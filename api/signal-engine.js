
const SYMBOL = "XAU/USD";
const MARKET = "XAUUSD";

const STOP_ATR = 1.5;
const TARGET_R = 2.0;
const MAX_ENTRY_DISTANCE_PERCENT = 0.10;
const CACHE_TTL_MS = 30000;
const MAX_QUOTE_AGE_MS = 180000;
let cachedPayload = null;
let cachedAt = 0;

function parseTime(value) {
  let s = String(value || "").trim();
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(s)) {
    s = s.replace(" ", "T") + "Z";
  }
  return Date.parse(s);
}

function normalizeCandles(values) {
  const now = Date.now();
  const byTime = new Map();

  for (const raw of values) {
    const time = parseTime(raw.datetime);
    const candle = {
      time,
      datetime: Number.isFinite(time) ? new Date(time).toISOString() : null,
      open: Number(raw.open),
      high: Number(raw.high),
      low: Number(raw.low),
      close: Number(raw.close)
    };

    const validPrices = [candle.open, candle.high, candle.low, candle.close]
      .every(Number.isFinite);
    const validOHLC = validPrices &&
      candle.high >= Math.max(candle.open, candle.close, candle.low) &&
      candle.low <= Math.min(candle.open, candle.close, candle.high);

    if (
      !Number.isFinite(time) ||
      time % 3600000 !== 0 ||
      time + 3600000 > now ||
      !validOHLC
    ) continue;

    // A provider may repeat a timestamp. Keep exactly one completed bar.
    byTime.set(time, candle);
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function emaSeries(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;

  let v = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  out[period - 1] = v;
  const k = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    v = values[i] * k + v * (1 - k);
    out[i] = v;
  }
  return out;
}

function ema(values, period) {
  if (values.length < period) return null;

  let v = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  const k = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    v = values[i] * k + v * (1 - k);
  }
  return v;
}

function aggregateH4(candles) {
  const groups = new Map();

  for (const c of candles) {
    const bucket =
      Math.floor(c.time / 14400000) * 14400000;

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

function calculateMACDHistogram(candles) {
  const close = candles.map(c => c.close);
  const e12 = emaSeries(close, 12);
  const e26 = emaSeries(close, 26);

  const macd = close.map((_, i) =>
    e12[i] === null || e26[i] === null
      ? null
      : e12[i] - e26[i]
  );

  const signal = Array(close.length).fill(null);
  const firstMacd = 25;
  const firstSignal = firstMacd + 8;

  if (close.length > firstSignal) {
    let value = 0;

    for (let i = firstMacd; i <= firstSignal; i++) {
      value += macd[i];
    }

    value /= 9;
    signal[firstSignal] = value;
    const k = 2 / 10;

    for (let i = firstSignal + 1; i < close.length; i++) {
      value = macd[i] * k + value * (1 - k);
      signal[i] = value;
    }
  }

  const histogram = macd.map((value, i) =>
    value === null || signal[i] === null
      ? null
      : value - signal[i]
  );

  return histogram[histogram.length - 1];
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

function analyzeTrend(candles, fastPeriod, slowPeriod) {
  if (candles.length < slowPeriod) {
    return {
      valid: false,
      trend: "WAIT",
      reason: "INSUFFICIENT_CANDLES"
    };
  }

  const close = candles.map(c => c.close);
  const fast = ema(close, fastPeriod);
  const slow = ema(close, slowPeriod);

  if (fast === null || slow === null) {
    return {
      valid: false,
      trend: "WAIT",
      reason: "EMA_UNAVAILABLE"
    };
  }

  return {
    valid: true,
    trend: fast > slow ? "BUY" : fast < slow ? "SELL" : "WAIT",
    fast,
    slow,
    price: close[close.length - 1],
    candleCount: candles.length,
    lastCompletedCandle: candles[candles.length - 1].datetime
  };
}

function createSignal(candles, h4Candles, currentPrice) {
  const h1 = analyzeTrend(candles, 20, 50);
  const h4 = analyzeTrend(h4Candles, 8, 20);

  const base = {
    executionStatus: "RESEARCH_ONLY_NOT_TRADE_READY",
    maxRiskPercent: 0.5,
    historicalWinProbability: "UNAVAILABLE",
    backtestStatus: "NOT_INDEPENDENTLY_VALIDATED",
    timeframe: "H1 + COMPLETED H4",
    currentPrice,
    liveQuoteStatus: Number.isFinite(currentPrice)
      ? "OK"
      : "UNAVAILABLE",
    maxEntryDistancePercent: MAX_ENTRY_DISTANCE_PERCENT
  };

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return {
      ...base,
      status: "WAIT",
      reason: "LIVE_QUOTE_UNAVAILABLE"
    };
  }

  if (!h1.valid || !h4.valid) {
    return {
      ...base,
      status: "WAIT",
      reason: "INSUFFICIENT_H1_H4_DATA"
    };
  }

  const entry = h1.price;
  const distance =
    Math.abs(currentPrice - entry) / Math.abs(entry) * 100;

  const entryFields = {
    entry: currentPrice,
    entryReference: "LATEST_PROVIDER_PRICE_ESTIMATE",
    signalReference: "LAST_COMPLETED_H1_CLOSE",
    entryDistancePercent: Number(distance.toFixed(4))
  };

  if (h1.trend === "WAIT" || h1.trend !== h4.trend) {
    return {
      ...base,
      ...entryFields,
      status: "WAIT",
      reason: "H1_H4_NOT_ALIGNED",
      h1Trend: h1.trend,
      h4Trend: h4.trend
    };
  }

  const histogram = calculateMACDHistogram(candles);

  if (
    histogram === null ||
    (h1.trend === "BUY" && histogram <= 0) ||
    (h1.trend === "SELL" && histogram >= 0)
  ) {
    return {
      ...base,
      ...entryFields,
      status: "WAIT",
      reason: "MACD_HISTOGRAM_NOT_CONFIRMED",
      h1Trend: h1.trend,
      h4Trend: h4.trend,
      macdHistogram: histogram
    };
  }

  if (distance > MAX_ENTRY_DISTANCE_PERCENT) {
    return {
      ...base,
      ...entryFields,
      status: "WAIT",
      reason: "ENTRY_TOO_FAR_FROM_PRICE",
      h1Trend: h1.trend,
      h4Trend: h4.trend,
      macdHistogram: Number(histogram.toFixed(5))
    };
  }

  const atr = calculateATR(candles);

  if (!atr || !Number.isFinite(atr)) {
    return {
      ...base,
      ...entryFields,
      status: "WAIT",
      reason: "ATR_UNAVAILABLE"
    };
  }

  const side = h1.trend;
  const risk = Math.max(
    atr * STOP_ATR,
    Math.abs(currentPrice) * 0.001
  );

  const reward = risk * TARGET_R;

  const sl = side === "BUY"
    ? currentPrice - risk
    : currentPrice + risk;

  const tp = side === "BUY"
    ? currentPrice + reward
    : currentPrice - reward;

  const signalCandleTime = candles[candles.length - 1].time + 3600000;
  const signalCandleClosedAt = new Date(signalCandleTime).toISOString();
  const signalId = `XAUUSD:${side}:${signalCandleTime}`;

  return {
    ...base,
    ...entryFields,
    status: side,
    signalId,
    signalCandleClosedAt,
    signalValidUntil: new Date(signalCandleTime + 3600000).toISOString(),
    h1Trend: h1.trend,
    h4Trend: h4.trend,
    macdHistogram: Number(histogram.toFixed(5)),
    macdFilter: "12/26/9 HISTOGRAM DIRECTION",
    atr: Number(atr.toFixed(3)),
    stopATR: STOP_ATR,
    sl: Number(sl.toFixed(3)),
    tp: Number(tp.toFixed(3)),
    riskReward: "1:2.0",
    riskRewardBasis: "GROSS_BEFORE_SPREAD_SLIPPAGE_AND_COMMISSION",
    entryModelWarning:
      "Giriş, Twelve Data son fiyatının yaklaşık tahminidir; bid/ask, spread ve kayma dahil değildir. Mesafe, son tamamlanmış H1 kapanışına göredir."
  };
}

async function getLatestQuote(key) {
  const url = new URL("https://api.twelvedata.com/quote");
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("timezone", "UTC");

  const response = await fetch(url, {
    headers: { Authorization: `apikey ${key}` }
  });
  const body = await response.json();
  const price = Number(body.close);
  // `timestamp` is the interval candle's opening time, not the latest quote update.
  // Require the dedicated last_quote_at field; never fall back to candle timestamp.
  const quoteTimestamp = Number(body.last_quote_at);

  if (!response.ok || body.status === "error" ||
      !Number.isFinite(price) || price <= 0) {
    throw new Error(body.message || "QUOTE_DATA_UNAVAILABLE");
  }
  // A fresh last quote is not tradable when the provider says the market is closed.
  // Fail closed if this required market-state field is absent or not explicitly true.
  if (body.is_market_open !== true) {
    throw new Error("MARKET_CLOSED_OR_STATUS_UNVERIFIED");
  }
  if (!Number.isFinite(quoteTimestamp) || quoteTimestamp <= 0) {
    throw new Error("QUOTE_TIMESTAMP_UNAVAILABLE");
  }

  const ageMs = Date.now() - quoteTimestamp * 1000;
  if (ageMs < 0 || ageMs > MAX_QUOTE_AGE_MS) {
    throw new Error("QUOTE_STALE_OR_FUTURE");
  }

  return {
    status: "ok",
    price,
    timestamp: new Date(quoteTimestamp * 1000).toISOString(),
    ageSeconds: Math.floor(ageMs / 1000),
    freshness: "VERIFIED_WITHIN_180_SECONDS",
    source: "TWELVE_DATA_QUOTE_1MIN"
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED"
    });
  }

  const key = process.env.TWELVE_DATA_API_KEY;

  if (cachedPayload && Date.now() - cachedAt < CACHE_TTL_MS) {
    const quoteTime = Date.parse(cachedPayload.quote?.timestamp || "");
    const quoteAge = Date.now() - quoteTime;
    if (cachedPayload.quote?.status === "ok" &&
        Number.isFinite(quoteTime) && quoteAge >= 0 &&
        quoteAge <= MAX_QUOTE_AGE_MS) {
      return res.status(200).json({ ...cachedPayload, cache: "HIT_30_SECONDS" });
    }
    cachedPayload = null;
    cachedAt = 0;
  }
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
    url.searchParams.set("outputsize", "5000");
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
        error: "XAUUSD_CANDLE_DATA_UNAVAILABLE"
      });
    }

    const candles = normalizeCandles(values);
    const h4Candles = aggregateH4(candles);

    if (candles.length < 60 || h4Candles.length < 20) {
      return res.status(422).json({
        ok: false,
        error: "INSUFFICIENT_COMPLETED_CANDLES",
        candleCount: candles.length,
        h4CandleCount: h4Candles.length
      });
    }

    let quote;

    try {
      quote = await getLatestQuote(key);
    } catch (error) {
      quote = {
        status: "error",
        price: null,
        freshness: "UNVERIFIED",
        message: error.message
      };
    }

    const signal = createSignal(
      candles,
      h4Candles,
      quote.status === "ok" ? quote.price : null
    );

    const payload = {
      ok: true,
      engine: "QUANT PRO XAUUSD SIGNAL ENGINE V9",
      mode: "SIGNALS_ONLY",
      market: MARKET,
      symbol: SYMBOL,
      provider: "Twelve Data",
      timeframe: "H1 + COMPLETED H4",
      candleCount: candles.length,
      completedH4Count: h4Candles.length,
      firstCandle: candles[0].datetime,
      lastCandle: candles[candles.length - 1].datetime,
      strategy: {
        h1EMA: "20/50",
        h4EMA: "8/20",
        macd: "12/26/9",
        macdFilter: "HISTOGRAM DIRECTION",
        atr: 14,
        stopATR: STOP_ATR,
        targetR: TARGET_R,
        maxEntryDistancePercent: MAX_ENTRY_DISTANCE_PERCENT,
        adxFilter: false
      },
      quote,
      h1: analyzeTrend(candles, 20, 50),
      h4: analyzeTrend(h4Candles, 8, 20),
      signal,
      executionStatus: "RESEARCH_ONLY_NOT_TRADE_READY",
      warning:
        "Fiyat zaman damgası en fazla 180 saniye eski olmalıdır. Bid/ask, gerçek spread, kayma, komisyon ve bağımsız ileri test doğrulanmamıştır.",
      generatedAt: new Date().toISOString()
    };
    cachedPayload = payload;
    cachedAt = Date.now();
    return res.status(200).json({ ...payload, cache: "MISS" });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "SIGNAL_ENGINE_ERROR",
      message: error.message
    });
  }
};


// Export pure functions for deterministic automated tests. The default export remains the Vercel handler.
module.exports.__test = { parseTime, normalizeCandles, emaSeries, ema, aggregateH4, calculateMACDHistogram, calculateATR, analyzeTrend, createSignal, getLatestQuote };
