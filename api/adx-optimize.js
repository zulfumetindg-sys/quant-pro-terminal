
const SYMBOL = "XAU/USD";
const SPREAD = 0.30;
const SLIPPAGES = [0.10, 0.20];

const TESTS = [
  { name: "MACD_ONLY", threshold: null },
  { name: "MACD_ADX_15", threshold: 15 },
  { name: "MACD_ADX_20", threshold: 20 },
  { name: "MACD_ADX_25", threshold: 25 }
];

const PERIODS = [
  { name: "MAYIS_HAZIRAN", start: "2026-05-01T00:00:00Z", end: "2026-07-01T00:00:00Z" },
  { name: "TEMMUZ_AGUSTOS", start: "2026-07-01T00:00:00Z", end: "2026-09-01T00:00:00Z" },
  { name: "EYLUL_KASIM", start: "2026-09-01T00:00:00Z", end: "2026-12-01T00:00:00Z" }
];

function parseTime(s) {
  const v = String(s).replace(" ", "T");
  return Date.parse(v.endsWith("Z") ? v : v + "Z");
}

function ema(values, period) {
  if (values.length < period) return null;
  let v = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    v = values[i] * k + v * (1 - k);
  }
  return v;
}

function emaSeries(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;

  let v = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = v;
  const k = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    v = values[i] * k + v * (1 - k);
    out[i] = v;
  }
  return out;
}

function makeH4(c) {
  const groups = new Map();

  for (const x of c) {
    const d = new Date(x.time);
    const t = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      Math.floor(d.getUTCHours() / 4) * 4
    );

    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(x);
  }

  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([t, a]) =>
      a.length === 4 &&
      a.every((x, i) => x.time === t + i * 3600000)
    )
    .map(([t, a]) => ({
      time: t,
      end: t + 14400000,
      open: a[0].open,
      high: Math.max(...a.map(x => x.high)),
      low: Math.min(...a.map(x => x.low)),
      close: a[3].close
    }));
}

function trend(c, i, fast, slow) {
  if (i + 1 < slow) return null;
  const values = c.slice(0, i + 1).map(x => x.close);
  const a = ema(values, fast);
  const b = ema(values, slow);
  if (a === null || b === null) return null;
  return a > b ? "BUY" : a < b ? "SELL" : "WAIT";
}

function buildIndicators(c) {
  const n = c.length;
  const close = c.map(x => x.close);

  const e20 = emaSeries(close, 20);
  const e50 = emaSeries(close, 50);

  // MACD 12/26/9
  const e12 = emaSeries(close, 12);
  const e26 = emaSeries(close, 26);

  const macd = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (e12[i] !== null && e26[i] !== null) {
      macd[i] = e12[i] - e26[i];
    }
  }

  const signal = Array(n).fill(null);
  const firstMacd = 25;
  const firstSignal = firstMacd + 8;

  if (n > firstSignal) {
    let v = 0;
    for (let i = firstMacd; i <= firstSignal; i++) v += macd[i];
    v /= 9;
    signal[firstSignal] = v;

    const k = 2 / 10;
    for (let i = firstSignal + 1; i < n; i++) {
      v = macd[i] * k + v * (1 - k);
      signal[i] = v;
    }
  }

  const hist = macd.map((v, i) =>
    v === null || signal[i] === null ? null : v - signal[i]
  );

  // True Range ve Directional Movement
  const tr = Array(n).fill(null);
  const plusDM = Array(n).fill(0);
  const minusDM = Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const up = c[i].high - c[i - 1].high;
    const down = c[i - 1].low - c[i].low;

    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;

    tr[i] = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close)
    );
  }

  // Wilder ADX 14
  const adx = Array(n).fill(null);
  const dx = Array(n).fill(null);

  let smTR = 0;
  let smPlus = 0;
  let smMinus = 0;

  if (n > 28) {
    for (let i = 1; i <= 14; i++) {
      smTR += tr[i];
      smPlus += plusDM[i];
      smMinus += minusDM[i];
    }

    for (let i = 14; i < n; i++) {
      if (i > 14) {
        smTR = smTR - smTR / 14 + tr[i];
        smPlus = smPlus - smPlus / 14 + plusDM[i];
        smMinus = smMinus - smMinus / 14 + minusDM[i];
      }

      const pdi = smTR ? 100 * smPlus / smTR : 0;
      const mdi = smTR ? 100 * smMinus / smTR : 0;

      dx[i] = pdi + mdi
        ? 100 * Math.abs(pdi - mdi) / (pdi + mdi)
        : 0;
    }

    const first = 27;
    let initial = 0;

    for (let i = 14; i <= 27; i++) initial += dx[i] || 0;

    adx[first] = initial / 14;

    for (let i = first + 1; i < n; i++) {
      adx[i] = (adx[i - 1] * 13 + dx[i]) / 14;
    }
  }

  // ATR 14
  const atr = Array(n).fill(null);

  for (let i = 14; i < n; i++) {
    let sum = 0;
    for (let j = i - 13; j <= i; j++) sum += tr[j];
    atr[i] = sum / 14;
  }

  return { e20, e50, hist, adx, atr };
}

function getMetrics(trades) {
  const wins = trades.filter(x => x > 0);
  const losses = trades.filter(x => x < 0);

  const grossWin = wins.reduce((s, x) => s + x, 0);
  const grossLoss = Math.abs(losses.reduce((s, x) => s + x, 0));

  let equity = 0;
  let peak = 0;
  let dd = 0;

  for (const r of trades) {
    equity += r;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }

  const net = trades.reduce((s, x) => s + x, 0);

  return {
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRatePercent: trades.length
      ? +(wins.length / trades.length * 100).toFixed(2)
      : null,
    profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(3) : null,
    netProfitR: +net.toFixed(2),
    maxDrawdownR: +dd.toFixed(2),
    averageR: trades.length ? +(net / trades.length).toFixed(3) : null,
    insufficientSample: trades.length < 30
  };
}

function runPeriod(c, h4, ind, test, slip, period) {
  const trades = [];
  const half = SPREAD / 2;

  const start = Date.parse(period.start);
  const end = Date.parse(period.end);

  const endIndex = c.findIndex(x => x.time >= end);
  const lastIndex = endIndex < 0 ? c.length - 1 : endIndex - 1;

  let h4i = -1;
  let i = 60;

  while (i < lastIndex) {
    const next = c[i + 1];
    const closeTime = c[i].time + 3600000;

    while (
      h4i + 1 < h4.length &&
      h4[h4i + 1].end <= closeTime
    ) {
      h4i++;
    }

    if (next.time < start || next.time >= end || h4i < 20) {
      i++;
      continue;
    }

    const h1 = ind.e20[i] > ind.e50[i] ? "BUY" :
      ind.e20[i] < ind.e50[i] ? "SELL" : "WAIT";

    const h4trend = trend(h4, h4i, 8, 20);

    if (!h4trend || h1 === "WAIT" || h1 !== h4trend) {
      i++;
      continue;
    }

    // MACD histogram direction filter
    if (
      ind.hist[i] === null ||
      (h1 === "BUY" && ind.hist[i] <= 0) ||
      (h1 === "SELL" && ind.hist[i] >= 0)
    ) {
      i++;
      continue;
    }

    // ADX threshold filter
    if (test.threshold !== null) {
      if (
        ind.adx[i] === null ||
        ind.adx[i] < test.threshold
      ) {
        i++;
        continue;
      }
    }

    const volatility = ind.atr[i];

    if (!volatility || !Number.isFinite(volatility)) {
      i++;
      continue;
    }

    const risk = Math.max(
      volatility * 1.5,
      Math.abs(next.open) * 0.001
    );

    const entry = h1 === "BUY"
      ? next.open + half + slip
      : next.open - half - slip;

    const sl = h1 === "BUY" ? entry - risk : entry + risk;
    const tp = h1 === "BUY" ? entry + risk * 1.8 : entry - risk * 1.8;

    let exit = null;
    let exitIndex = i + 1;

    const maxHold = Math.min(i + 72, lastIndex);

    for (let j = i + 1; j <= maxHold; j++) {
      const x = c[j];

      const hitSL = h1 === "BUY"
        ? x.low - half <= sl
        : x.high + half >= sl;

      const hitTP = h1 === "BUY"
        ? x.high - half >= tp
        : x.low + half <= tp;

      // Aynı mumda SL ve TP: muhafazakâr olarak SL önce
      if (hitSL) {
        exit = h1 === "BUY" ? sl - slip : sl + slip;
        exitIndex = j;
        break;
      }

      if (hitTP) {
        exit = h1 === "BUY" ? tp - slip : tp + slip;
        exitIndex = j;
        break;
      }

      exit = h1 === "BUY"
        ? x.close - half - slip
        : x.close + half + slip;

      exitIndex = j;
    }

    if (exit === null) {
      i++;
      continue;
    }

    const profit = h1 === "BUY" ? exit - entry : entry - exit;
    trades.push(profit / risk);

    // Önceki MACD testindeki V4 işlem atlama kuralı
    i = Math.max(i + 1, exitIndex + 1);
  }

  return {
    filter: test.name,
    adxThreshold: test.threshold,
    period: period.name,
    slippagePerSideUSD: slip,
    metrics: getMetrics(trades)
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

  if (!key) {
    return res.status(503).json({
      ok: false,
      error: "API_KEY_MISSING"
    });
  }

  try {
    const url = new URL("https://api.twelvedata.com/time_series");

    url.searchParams.set("symbol", SYMBOL);
    url.searchParams.set("interval", "1h");
    url.searchParams.set("outputsize", "5000");
    url.searchParams.set("timezone", "UTC");
    url.searchParams.set("order", "ASC");

    const response = await fetch(url, {
      headers: { Authorization: `apikey ${key}` }
    });

    const body = await response.json();

    if (
      !response.ok ||
      body.status === "error" ||
      !Array.isArray(body.values)
    ) {
      return res.status(502).json({
        ok: false,
        error: "HISTORICAL_DATA_ERROR",
        message: body.message || "Twelve Data verisi alınamadı."
      });
    }

    const now = Date.now();

    const c = body.values.map(x => ({
      time: parseTime(x.datetime),
      open: Number(x.open),
      high: Number(x.high),
      low: Number(x.low),
      close: Number(x.close)
    })).filter(x =>
      Number.isFinite(x.time) &&
      x.time + 3600000 <= now &&
      [x.open, x.high, x.low, x.close].every(Number.isFinite) &&
      x.high >= x.low
    ).sort((a, b) => a.time - b.time);

    if (c.length < 500) {
      return res.status(422).json({
        ok: false,
        error: "INSUFFICIENT_HISTORY",
        candleCount: c.length
      });
    }

    const h4 = makeH4(c);
    const ind = buildIndicators(c);
    const results = [];

    for (const test of TESTS) {
      for (const slip of SLIPPAGES) {
        for (const period of PERIODS) {
          results.push(
            runPeriod(c, h4, ind, test, slip, period)
          );
        }
      }
    }

    return res.status(200).json({
      ok: true,
      engine: "QUANT PRO XAUUSD MACD ADX OPTIMIZATION V1",
      symbol: SYMBOL,
      timeframe: "H1 + COMPLETED H4",
      provider: "Twelve Data",
      candleCount: c.length,
      h4CandleCount: h4.length,
      firstCandle: new Date(c[0].time).toISOString(),
      lastCandle: new Date(c[c.length - 1].time).toISOString(),
      macd: "12/26/9",
      adx: "Wilder ADX 14",
      thresholds: [15, 20, 25],
      controlGroup: "MACD_ONLY",
      baseline: "H1 EMA20/50 + H4 EMA8/20",
      stopLoss: "ATR14 x 1.5",
      takeProfit: "1.8R",
      maxHoldingHours: 72,
      spreadUSD: SPREAD,
      slippagePerSideUSD: SLIPPAGES,
      commissionPerTradeUSD: 0,
      historicalXMSpreadAvailable: false,
      tests: TESTS,
      results,
      executionStatus: "RESEARCH_ONLY_NOT_TRADE_READY",
      warning: "OHLC yaklaşık simülasyonudur. Gerçek XM tarihsel bid/ask, komisyon ve tick verisi doğrulanmamıştır.",
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "ADX_OPTIMIZATION_ERROR",
      message: e.message
    });
  }
};
