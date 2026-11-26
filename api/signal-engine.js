
const SYMBOLS = {
  EURUSD: "EUR/USD",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
  USDTRY: "USD/TRY",
  XAUUSD: "XAU/USD",
  XAGUSD: "XAG/USD",
  NAS100: "NASDAQ",
  DAX40: "DAX"
};

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getCandles(payload, symbol) {
  const item = payload?.data?.[symbol];
  if (!item) return [];
  return Array.isArray(item.candles) ? item.candles : [];
}

function closeOf(candle) {
  return number(candle.close);
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let result = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

function analyze(candles) {
  const closes = candles.map(closeOf).filter(v => v !== null);

  if (closes.length < 55) {
    return { valid: false, reason: "INSUFFICIENT_CANDLES" };
  }

  const fast = ema(closes, 20);
  const slow = ema(closes, 50);
  const price = closes[closes.length - 1];

  if (fast === null || slow === null || !price) {
    return { valid: false, reason: "INVALID_DATA" };
  }

  return {
    valid: true,
    price,
    fast,
    slow,
    trend: fast > slow ? "BUY" : fast < slow ? "SELL" : "WAIT"
  };
}

function buildSignal(h1, h4) {
  if (!h1.valid || !h4.valid) {
    return {
      status: "WAIT",
      reason: "H1_OR_H4_DATA_INSUFFICIENT"
    };
  }

  if (h1.trend !== h4.trend || h1.trend === "WAIT") {
    return {
      status: "WAIT",
      reason: "H1_H4_NOT_ALIGNED",
      price: h1.price
    };
  }

  const side = h1.trend;
  const entry = h1.price;
  const distance = Math.abs(h1.fast - h1.slow);

  if (!(distance > 0)) {
    return { status: "WAIT", reason: "NO_VALID_STOP_DISTANCE" };
  }

  const stopDistance = Math.max(distance * 1.5, entry * 0.001);
  const risk = stopDistance;
  const reward = risk * 1.8;

  const sl = side === "BUY"
    ? entry - risk
    : entry + risk;

  const tp = side === "BUY"
    ? entry + reward
    : entry - reward;

  return {
    status: side,
    entry,
    sl,
    tp,
    riskReward: "1:1.8",
    entryDistancePercent: 0,
    historicalWinProbability: "UNAVAILABLE",
    backtestStatus: "NOT_TESTED",
    riskPercentMaximum: 0.5,
    timeframeConfirmation: "H1+H4"
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED"
    });
  }

  try {
    const base = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;

    const [h1Response, h4Response] = await Promise.all([
      fetch(`${base}/api/candles?interval=1h`),
      fetch(`${base}/api/candles?interval=4h`)
    ]);

    if (!h1Response.ok || !h4Response.ok) {
      return res.status(502).json({
        ok: false,
        error: "CANDLE_DATA_UNAVAILABLE"
      });
    }

    const [h1Data, h4Data] = await Promise.all([
      h1Response.json(),
      h4Response.json()
    ]);

    const results = {};

    for (const symbol of Object.keys(SYMBOLS)) {
      const h1 = analyze(getCandles(h1Data, symbol));
      const h4 = analyze(getCandles(h4Data, symbol));

      results[symbol] = {
        symbol: SYMBOLS[symbol],
        h1,
        h4,
        signal: buildSignal(h1, h4)
      };
    }

    return res.status(200).json({
      ok: true,
      engine: "QUANT PRO SIGNAL ENGINE V1",
      mode: "SIGNALS_ONLY",
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
}
