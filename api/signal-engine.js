
const SYMBOLS = {
  EURUSD: "EUR/USD",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
  USDTRY: "USD/TRY",
  XAUUSD: "XAU/USD"
};

function ema(values, period) {
  if (values.length < period) return null;

  let result = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  const k = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function normalizeCandles(values) {
  return values.map(c => ({
    datetime: c.datetime,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  }))
  .filter(c =>
    Number.isFinite(Date.parse(c.datetime)) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close)
  )
  .sort((a, b) =>
    new Date(a.datetime) - new Date(b.datetime)
  );
}

function aggregateH4(candles) {
  const groups = {};

  for (const c of candles) {
    const time = new Date(c.datetime);
    const bucket = new Date(time);

    bucket.setUTCHours(
      Math.floor(time.getUTCHours() / 4) * 4,
      0, 0, 0
    );

    const key = bucket.toISOString();

    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }

  return Object.entries(groups)
    .filter(([key, group]) => {
      if (group.length !== 4) return false;

      const times = group.map(c =>
        new Date(c.datetime).getTime()
      );

      for (let i = 1; i < times.length; i++) {
        if (times[i] - times[i - 1] !== 3600000) {
          return false;
        }
      }

      return true;
    })
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, group]) => ({
      datetime: key,
      open: group[0].open,
      high: Math.max(...group.map(c => c.high)),
      low: Math.min(...group.map(c => c.low)),
      close: group[group.length - 1].close
    }));
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }

  const recent = ranges.slice(-period);

  return recent.reduce((a, b) => a + b, 0) / period;
}

function analyze(candles, timeframe) {
  const closes = candles.map(c => c.close);

  const fastPeriod = timeframe === "H1" ? 20 : 8;
  const slowPeriod = timeframe === "H1" ? 50 : 20;

  if (closes.length < slowPeriod + 1) {
    return {
      valid: false,
      reason: "INSUFFICIENT_CANDLES"
    };
  }

  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);

  if (fast === null || slow === null) {
    return {
      valid: false,
      reason: "EMA_UNAVAILABLE"
    };
  }

  return {
    valid: true,
    trend: fast > slow ? "BUY" :
           fast < slow ? "SELL" : "WAIT",
    fast,
    slow,
    price: closes[closes.length - 1],
    candleCount: candles.length
  };
}

function createSignal(h1, h4, candles) {
  if (!h1.valid || !h4.valid) {
    return {
      status: "WAIT",
      reason: "INSUFFICIENT_H1_H4_DATA"
    };
  }

  if (h1.trend === "WAIT" || h1.trend !== h4.trend) {
    return {
      status: "WAIT",
      reason: "H1_H4_NOT_ALIGNED",
      price: h1.price
    };
  }

  const atr = calculateATR(candles);

  if (!atr || !Number.isFinite(atr)) {
    return {
      status: "WAIT",
      reason: "ATR_UNAVAILABLE"
    };
  }

  const entry = h1.price;
  const risk = Math.max(atr * 1.5, entry * 0.001);
  const reward = risk * 1.8;
  const side = h1.trend;

  const sl = side === "BUY"
    ? entry - risk
    : entry + risk;

  const tp = side === "BUY"
    ? entry + reward
    : entry - reward;

  return {
    status: side,
    executionStatus: "NOT_TRADE_READY",
    entry,
    entryReference: "LAST_H1_CANDLE_CLOSE",
    currentPrice: null,
    entryDistancePercent: null,
    entryDistanceStatus: "UNAVAILABLE",
    entryDistanceReason: "LIVE_QUOTE_NOT_CONNECTED",
    sl,
    tp,
    riskReward: "1:1.8",
    historicalWinProbability: "UNAVAILABLE",
    backtestStatus: "NOT_TESTED",
    timeframeConfirmation: "H1+H4",
    maxRiskPercent: 0.5,
    atr
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED"
    });
  }

  const key = process.env.TWELVE_DATA_API_KEY;

  if (!key) {
    return res.status(503).json({
      ok: false,
      error: "API_KEY_MISSING"
    });
  }

  try {
    const url = new URL(
      "https://api.twelvedata.com/time_series"
    );

    url.searchParams.set(
      "symbol",
      Object.values(SYMBOLS).join(",")
    );

    url.searchParams.set("interval", "1h");
    url.searchParams.set("outputsize", "100");
    url.searchParams.set("timezone", "UTC");

    const response = await fetch(url, {
      headers: {
        Authorization: `apikey ${key}`
      }
    });

    const body = await response.json();

    if (!response.ok || body.status === "error") {
      return res.status(502).json({
        ok: false,
        error: "TWELVE_DATA_ERROR",
        message: body.message || "Veri alınamadı."
      });
    }

    const results = {};

    for (const [market, symbol] of Object.entries(SYMBOLS)) {
      const item = body[symbol];

      if (!item || !Array.isArray(item.values)) {
        results[market] = {
          symbol,
          signal: {
            status: "WAIT",
            reason: item?.message || "DATA_UNAVAILABLE"
          }
        };
        continue;
      }

      const candles = normalizeCandles(item.values);
      const h4Candles = aggregateH4(candles);

      const h1 = analyze(candles, "H1");
      const h4 = analyze(h4Candles, "H4");

      results[market] = {
        symbol,
        h1,
        h4,
        signal: createSignal(h1, h4, candles)
      };
    }

    return res.status(200).json({
      ok: true,
      engine: "QUANT PRO SIGNAL ENGINE V3",
      mode: "SIGNALS_ONLY",
      provider: "Twelve Data",
      generatedAt: new Date().toISOString(),
      results
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "ENGINE_ERROR",
      message: error.message
    });
  }
};
