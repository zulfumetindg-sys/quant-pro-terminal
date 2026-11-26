
const SYMBOL = "XAU/USD";
const SPREAD = 0.30;
const SLIPPAGES = [0.10, 0.20];

const PERIODS = [
  { name: "MAYIS_HAZIRAN", start: "2026-05-01", end: "2026-07-01" },
  { name: "TEMMUZ_AGUSTOS", start: "2026-07-01", end: "2026-09-01" },
  { name: "EYLUL_KASIM", start: "2026-09-01", end: "2026-12-01" }
];

function ema(values, period) {
  if (values.length < period) return null;
  let v = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) v = values[i] * k + v * (1 - k);
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

function indicators(c) {
  const n = c.length;
  const close = c.map(x => x.close);
  const e20 = emaSeries(close, 20);
  const e50 = emaSeries(close, 50);

  const e12 = emaSeries(close, 12);
  const e26 = emaSeries(close, 26);
  const macd = close.map((_, i) =>
    e12[i] === null || e26[i] === null ? null : e12[i] - e26[i]
  );
  const signal = emaSeries(macd.map(x => x ?? 0), 9);
  const hist = macd.map((x, i) =>
    x === null || signal[i] === null ? null : x - signal[i]
  );

  const bb = Array(n).fill(null);
  for (let i = 19; i < n; i++) {
    const a = close.slice(i - 19, i + 1);
    const mean = a.reduce((s, x) => s + x, 0) / 20;
    const variance = a.reduce((s, x) => s + (x - mean) ** 2, 0) / 20;
    const sd = Math.sqrt(variance);
    bb[i] = { mid: mean, upper: mean + 2 * sd, lower: mean - 2 * sd };
  }

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

  const adx = Array(n).fill(null);
  let smTR = 0, smPlus = 0, smMinus = 0;
  const dx = Array(n).fill(null);

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
      dx[i] = pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    }

    const first = 27;
    const initial = dx.slice(14, 28).reduce((s, x) => s + (x || 0), 0) / 14;
    adx[first] = initial;

    for (let i = first + 1; i < n; i++) {
      adx[i] = (adx[i - 1] * 13 + dx[i]) / 14;
    }
  }

  const atr = Array(n).fill(null);
  for (let i = 14; i < n; i++) {
    let sum = 0;
    for (let j = i - 13; j <= i; j++) sum += tr[j];
    atr[i] = sum / 14;
  }

  return { e20, e50, hist, bb, adx, atr };
}

function parseTime(s) {
  return Date.parse(String(s).replace(" ", "T") + (String(s).endsWith("Z") ? "" : "Z"));
}

function makeH4(c) {
  const groups = new Map();
  for (const x of c) {
    const t = Math.floor(x.time / 14400000) * 14400000;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(x);
  }

  return [...groups.entries()]
    .filter(([t, a]) => a.length === 4 &&
      a.every((x, i) => x.time === t + i * 3600000))
    .map(([t, a]) => ({
      time: t,
      end: t + 14400000,
      open: a[0].open,
      high: Math.max(...a.map(x => x.high)),
      low: Math.min(...a.map(x => x.low)),
      close: a[3].close
    }));
}

function trendAt(c, i, fast, slow) {
  const closes = c.slice(0, i + 1).map(x => x.close);
  const a = ema(closes, fast);
  const b = ema(closes, slow);
  if (a === null || b === null || a === b) return "WAIT";
  return a > b ? "BUY" : "SELL";
}

function metrics(trades) {
  const wins = trades.filter(x => x.r > 0);
  const losses = trades.filter(x => x.r < 0);
  const gp = wins.reduce((s, x) => s + x.r, 0);
  const gl = Math.abs(losses.reduce((s, x) => s + x.r, 0));
  let equity = 0, peak = 0, dd = 0;

  for (const x of trades) {
    equity += x.r;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }

  return {
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRatePercent: trades.length ? +(wins.length / trades.length * 100).toFixed(2) : null,
    profitFactor: gl ? +(gp / gl).toFixed(3) : null,
    netProfitR: +trades.reduce((s, x) => s + x.r, 0).toFixed(2),
    maxDrawdownR: +dd.toFixed(2),
    averageR: trades.length ? +(trades.reduce((s, x) => s + x.r, 0) / trades.length).toFixed(3) : null,
    insufficientSample: trades.length < 30
  };
}

const VARIANTS = [
  { name: "BASELINE_EMA", adx: false, macd: false, bb: false },
  { name: "ADX_14_OVER_20", adx: true, macd: false, bb: false },
  { name: "MACD_CONFIRMATION", adx: false, macd: true, bb: false },
  { name: "ADX_PLUS_MACD", adx: true, macd: true, bb: false },
  { name: "ADX_MACD_BOLLINGER", adx: true, macd: true, bb: true }
];

function run(c, h4, ind, hi, variant, slip, period) {
  const trades = [];
  const start = Date.parse(period.start + "T00:00:00Z");
  const end = Date.parse(period.end + "T00:00:00Z");
  const half = SPREAD / 2;
  let h4i = -1;

  for (let i = 60; i < c.length - 1; i++) {
    const next = c[i + 1];
    if (next.time < start || next.time >= end) continue;

    const closeTime = c[i].time + 3600000;
    while (h4i + 1 < h4.length && h4[h4i + 1].end <= closeTime) h4i++;
    if (h4i < 20) continue;

    const h1 = ind.e20[i] > ind.e50[i] ? "BUY" :
      ind.e20[i] < ind.e50[i] ? "SELL" : "WAIT";
    const h4trend = trendAt(h4, h4i, 8, 20);
    if (h1 === "WAIT" || h1 !== h4trend) continue;

    if (variant.adx && !(ind.adx[i] >= 20)) continue;
    if (variant.macd && !(h1 === "BUY" ? ind.hist[i] > 0 : ind.hist[i] < 0)) continue;

    if (variant.bb) {
      const b = ind.bb[i];
      if (!b) continue;
      if (h1 === "BUY" && !(c[i].close > b.mid && c[i].close < b.upper)) continue;
      if (h1 === "SELL" && !(c[i].close < b.mid && c[i].close > b.lower)) continue;
    }

    const atr = ind.atr[i];
    if (!atr || !Number.isFinite(atr)) continue;

    const risk = Math.max(atr * 1.5, next.open * 0.001);
    const entry = h1 === "BUY" ? next.open + half + slip : next.open - half - slip;
    const sl = h1 === "BUY" ? entry - risk : entry + risk;
    const tp = h1 === "BUY" ? entry + risk * 1.8 : entry - risk * 1.8;

    let exit = null, exitIndex = i + 1;
    const last = Math.min(i + 72, c.length - 1,
      c.findIndex(x => x.time >= end) < 0 ? c.length - 1 : c.findIndex(x => x.time >= end) - 1);

    for (let j = i + 1; j <= last; j++) {
      const x = c[j];
      const hitSL = h1 === "BUY" ? x.low - half <= sl : x.high + half >= sl;
      const hitTP = h1 === "BUY" ? x.high - half >= tp : x.low + half <= tp;

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

      exit = h1 === "BUY" ? x.close - half - slip : x.close + half + slip;
      exitIndex = j;
    }

    if (exit === null) continue;
    const profit = h1 === "BUY" ? exit - entry : entry - exit;
    trades.push({ r: profit / risk });
    i = Math.max(i, exitIndex - 1);
  }

  return { variant: variant.name, period: period.name, slippagePerSideUSD: slip, metrics: metrics(trades) };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });

  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) return res.status(503).json({ ok: false, error: "API_KEY_MISSING" });

  try {
    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", SYMBOL);
    url.searchParams.set("interval", "1h");
    url.searchParams.set("outputsize", "5000");
    url.searchParams.set("timezone", "UTC");
    url.searchParams.set("order", "ASC");

    const response = await fetch(url, { headers: { Authorization: `apikey ${key}` } });
    const body = await response.json();

    if (!response.ok || !Array.isArray(body.values)) {
      return res.status(502).json({ ok: false, error: body.message || "DATA_ERROR" });
    }

    const now = Date.now();
    const c = body.values.map(x => ({
      time: parseTime(x.datetime),
      open: +x.open, high: +x.high, low: +x.low, close: +x.close
    })).filter(x => Number.isFinite(x.time) && x.time + 3600000 <= now &&
      [x.open, x.high, x.low, x.close].every(Number.isFinite))
      .sort((a, b) => a.time - b.time);

    if (c.length < 500) return res.status(422).json({ ok: false, error: "INSUFFICIENT_HISTORY", count: c.length });

    const h4 = makeH4(c);
    const ind = indicators(c);
    const hi = indicators(h4);
    const results = [];

    for (const v of VARIANTS) {
      for (const slip of SLIPPAGES) {
        for (const p of PERIODS) {
          results.push(run(c, h4, ind, hi, v, slip, p));
        }
      }
    }

    return res.status(200).json({
      ok: true,
      engine: "QUANT PRO XAUUSD INDICATOR TEST V1",
      symbol: SYMBOL,
      candleCount: c.length,
      h4CandleCount: h4.length,
      indicators: ["ADX14", "MACD12_26_9", "BOLLINGER20_2"],
      baselineIncluded: true,
      variants: VARIANTS,
      spreadUSD: SPREAD,
      slippagePerSideUSD: SLIPPAGES,
      commissionPerTradeUSD: 0,
      historicalXMSpreadAvailable: false,
      results,
      executionStatus: "RESEARCH_ONLY_NOT_TRADE_READY",
      warning: "OHLC tabanlı yaklaşık simülasyon. Gerçek XM bid/ask, komisyon ve tick verisi doğrulanmamıştır.",
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "TEST_ERROR", message: e.message });
  }
};
