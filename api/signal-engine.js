
const SYMBOL = "XAU/USD";
const MARKET = "XAUUSD";

function parseTime(value) {
  let s = String(value || "").trim();

  // Twelve Data UTC zamanını açıkça UTC olarak yorumla.
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(s)) {
    s = s.replace(" ", "T") + "Z";
  }

  return Date.parse(s);
}

function normalizeCandles(values) {
  const now = Date.now();

  return values
    .map(c => {
      const time = parseTime(c.datetime);

      return {
        time,
        datetime: Number.isFinite(time)
          ? new Date(time).toISOString()
          : null,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      };
    })
    .filter(c =>
      Number.isFinite(c.time) &&
      c.time + 3600000 <= now &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.high >= c.low
    )
    .sort((a, b) => a.time - b.time);
}

function ema(values, period) {
  if (values.length < period) return null;

  let result =
    values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const k = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function aggregateH4(candles) {
  const groups = new Map();

  for (const c of candles) {
    const bucket = Math.floor(c.time / 14400000) * 14400000;

    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(c);
  }

  return Array.from(groups.entries())
    .filter(([bucket, group]) => {
      if (Date.now() < bucket + 14400000) return false;
      if (group.length !== 4) return false;

      group.sort((a, b) => a.time - b.time);

      for (let i = 0; i < 4; i++) {
        if (group[i].time !== bucket + i * 3600000) {
          return false;
        }
      }

      return true;
    })
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, group]) => ({
      time: bucket,
      datetime: new Date(bucket).toISOString(),
      open: group[0].open,
      high: Math.max(...group.map(c => c.high)),
      low: Math.min(...group.map(c => c.low)),
      close: group[3].close
    }));
}

function analyze(candles, timeframe) {
  const closes = candles.map(c => c.close);

  const fastPeriod = timeframe === "H1" ? 20 : 8;
  const slowPeriod = timeframe === "H1" ? 50 : 20;

  if (closes.length < slowPeriod + 1) {
    return {
      valid: false,
      reason: "INSUFFICIENT_COMPLETED_CANDLES",
      candleCount: candles.length
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
    timeframe,
    trend: fast > slow ? "BUY" : fast < slow ? "SELL" : "WAIT",
    fast,
    slow,
    price: closes[closes.length - 1],
    candleCount: candles.length,
    lastCompletedCandle: candles[candles.length - 1].datetime
  };
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

function createSignal(h1, h4, candles, currentPrice) {
  const hasQuote =
    Number.isFinite(currentPrice) && currentPrice > 0;

  const base = {
    executionStatus: "NOT_TRADE_READY",
    executionBlockReason: "BACKTEST_AND_XM_SPREAD_VALIDATION_PENDING",
    historicalWinProbability: "UNAVAILABLE",
    backtestStatus: "NOT_VALIDATED_FOR_LIVE_EXECUTION",
    timeframeConfirmation: "H1+H4",
    maxRiskPercent: 0.5,
    currentPrice: hasQuote ? currentPrice : null,
    liveQuoteStatus: hasQuote ? "OK" : "UNAVAILABLE"
  };

  if (!h1.valid || !h4.valid) {
    return {
      ...base,
      status: "WAIT",
      reason: "INSUFFICIENT_COMPLETED_H1_H4_DATA"
    };
  }

  const entry = h1.price;

  const distance = hasQuote
    ? Math.abs(currentPrice - entry) / Math.abs(entry) * 100
    : null;

  const distanceFields = {
    entry,
    entryReference: "LAST_COMPLETED_H1_CANDLE_CLOSE",
    entryDistancePercent:
      distance === null ? null : Number(distance.toFixed(4)),
    entryDistanceStatus:
      distance === null ? "UNAVAILABLE" : "AVAILABLE"
  };

  if (h1.trend === "WAIT" || h1.trend !== h4.trend) {
    return {
      ...base,
      ...distanceFields,
      status: "WAIT",
      reason: "H1_H4_NOT_ALIGNED",
      h1Trend: h1.trend,
      h4Trend: h4.trend
    };
  }

  const atr = calculateATR(candles);

  if (!atr || !Number.isFinite(atr)) {
    return {
      ...base,
      ...distanceFields,
      status: "WAIT",
      reason: "ATR_UNAVAILABLE"
    };
  }

  const side = h1.trend;
  const risk = Math.max(atr * 1.5, Math.abs(entry) * 0.001);
  const reward = risk * 1.8;

  const sl = side === "BUY"
    ? entry - risk
    : entry + risk;

  const tp = side === "BUY"
    ? entry + reward
    : entry - reward;

  return {
    ...base,
    ...distanceFields,
    status: side,
    h1Trend: h1.trend,
    h4Trend: h4.trend,
    sl: Number(sl.toFixed(3)),
    tp: Number(tp.toFixed(3)),
    riskReward: "1:1.8",
    atr: Number(atr.toFixed(3)),
    entryModelWarning: "LIVE_ENTRY_AND_BACKTEST_ENTRY_STILL_REQUIRE_ALIGNMENT"
  };
}

async function getLatestPrice(key) {
  const url = new URL("https://api.twelvedata.com/price");

  url.searchParams.set("symbol", SYMBOL);

  const response = await fetch(url, {
    headers: {
      Authorization: `apikey ${key}`
    }
  });

  const body = await response.json();
  const price = Number(body.price);

  if (!response.ok || !Number.isFinite(price) || price <= 0) {
    throw new Error(body.message || "LIVE_PRICE_UNAVAILABLE");
  }

  return price;
}

module.exports = async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=50, stale-while-revalidate=10"
  );

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

    url.searchParams.set("symbol", SYMBOL);
    url.searchParams.set("interval", "1h");
    url.searchParams.set("outputsize", "500");
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
        error: "TWELVE_DATA_CANDLES_ERROR",
        message: body.message || "Altın mum verisi alınamadı."
      });
    }

    const values = Array.isArray(body.values)
      ? body.values
      : body[SYMBOL]?.values;

    if (!Array.isArray(values)) {
      return res.status(502).json({
        ok: false,
        error: "XAUUSD_CANDLE_DATA_UNAVAILABLE",
        message: body.message || "XAUUSD mum verisi bulunamadı."
      });
    }

    const candles = normalizeCandles(values);
    const h4Candles = aggregateH4(candles);

    const h1 = analyze(candles, "H1");
    const h4 = analyze(h4Candles, "H4");

    let quote;

    try {
      quote = {
        status: "ok",
        price: await getLatestPrice(key)
      };
    } catch (error) {
      quote = {
        status: "error",
        price: null,
        message: error.message
      };
    }

    const currentPrice =
      quote.status === "ok" ? quote.price : null;

    const signal = createSignal(
      h1,
      h4,
      candles,
      currentPrice
    );

    return res.status(200).json({
      ok: true,
      engine: "QUANT PRO XAUUSD SIGNAL ENGINE V6",
      mode: "SIGNALS_ONLY",
      market: MARKET,
      symbol: SYMBOL,
      provider: "Twelve Data",
      timeframe: "H1 + COMPLETED H4",
      candleCount: candles.length,
      completedH4Count: h4Candles.length,
      generatedAt: new Date().toISOString(),
      candleRule: "ONLY_COMPLETED_H1_CANDLES",
      creditEstimate: {
        candleRequest: 1,
        livePriceRequest: 1,
        expectedTotal: 2
      },
      quote,
      h1,
      h4,
      signal
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "ENGINE_ERROR",
      message: error.message
    });
  }
};
