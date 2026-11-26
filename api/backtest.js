
const SYMBOL = "XAU/USD";

const STOP_ATR = 1.5;
const TARGET_R = 2.0;
const SPREAD_USD = 0.30;
const SLIPPAGES = [0.10, 0.20];

const PERIODS = [
  {
    name: "MAYIS_HAZIRAN",
    start: "2026-05-01T00:00:00Z",
    end: "2026-07-01T00:00:00Z"
  },
  {
    name: "TEMMUZ_AGUSTOS",
    start: "2026-07-01T00:00:00Z",
    end: "2026-09-01T00:00:00Z"
  },
  {
    name: "EYLUL_KASIM",
    start: "2026-09-01T00:00:00Z",
    end: "2026-12-01T00:00:00Z"
  }
];

function parseTime(value) {
  let s = String(value || "").trim();

  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(s)) {
    s = s.replace(" ", "T") + "Z";
  }

  return Date.parse(s);
}

function emaSeries(values, period) {
  const out = Array(values.length).fill(null);

  if (values.length < period) return out;

  let value = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  out[period - 1] = value;

  const k = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
    out[i] = value;
  }

  return out;
}

function ema(values, period) {
  if (values.length < period) return null;

  let value = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  const k = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }

  return value;
}

function makeH4(candles) {
  const groups = new Map();

  for (const candle of candles) {
    const bucket =
      Math.floor(candle.time / 14400000) * 14400000;

    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(candle);
  }

  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([time, group]) => {
      if (group.length !== 4) return false;

      group.sort((a, b) => a.time - b.time);

      return group.every((candle, i) =>
        candle.time === time + i * 3600000
      );
    })
    .map(([time, group]) => ({
      time,
      end: time + 14400000,
      open: group[0].open,
      high: Math.max(...group.map(x => x.high)),
      low: Math.min(...group.map(x => x.low)),
      close: group[3].close
    }));
}

function trend(candles, index, fastPeriod, slowPeriod) {
  if (index < slowPeriod - 1) return null;

  const close = candles
    .slice(0, index + 1)
    .map(x => x.close);

  const fast = ema(close, fastPeriod);
  const slow = ema(close, slowPeriod);

  if (fast === null || slow === null) return null;

  if (fast > slow) return "BUY";
  if (fast < slow) return "SELL";

  return "WAIT";
}

function buildIndicators(candles) {
  const close = candles.map(x => x.close);
  const n = candles.length;

  const e20 = emaSeries(close, 20);
  const e50 = emaSeries(close, 50);

  const e12 = emaSeries(close, 12);
  const e26 = emaSeries(close, 26);

  const macd = close.map((_, i) =>
    e12[i] === null || e26[i] === null
      ? null
      : e12[i] - e26[i]
  );

  const signal = Array(n).fill(null);

  const firstMacd = 25;
  const firstSignal = 33;

  if (n > firstSignal) {
    let value = 0;

    for (let i = firstMacd; i <= firstSignal; i++) {
      value += macd[i];
    }

    value /= 9;
    signal[firstSignal] = value;

    const k = 2 / 10;

    for (let i = firstSignal + 1; i < n; i++) {
      value = macd[i] * k + value * (1 - k);
      signal[i] = value;
    }
  }

  const histogram = macd.map((value, i) =>
    value === null || signal[i] === null
      ? null
      : value - signal[i]
  );

  const trueRange = Array(n).fill(null);

  for (let i = 1; i < n; i++) {
    trueRange[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
  }

  const atr = Array(n).fill(null);

  for (let i = 14; i < n; i++) {
    let sum = 0;

    for (let j = i - 13; j <= i; j++) {
      sum += trueRange[j];
    }

    atr[i] = sum / 14;
  }

  return { e20, e50, histogram, atr };
}

function getMetrics(trades) {
  const wins = trades.filter(x => x.netR > 0);
  const losses = trades.filter(x => x.netR < 0);

  const grossWin = wins.reduce((s, x) => s + x.netR, 0);
  const grossLoss = Math.abs(
    losses.reduce((s, x) => s + x.netR, 0)
  );

  const net = trades.reduce((s, x) => s + x.netR, 0);

  let equity = 0;
  let peak = 0;
  let drawdown = 0;

  for (const trade of trades) {
    equity += trade.netR;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }

  return {
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,

    winRatePercent: trades.length
      ? +(wins.length / trades.length * 100).toFixed(2)
      : null,

    profitFactor: grossLoss > 0
      ? +(grossWin / grossLoss).toFixed(3)
      : null,

    netProfitR: +net.toFixed(2),
    maxDrawdownR: +drawdown.toFixed(2),

    averageR: trades.length
      ? +(net / trades.length).toFixed(3)
      : null,

    insufficientSample: trades.length < 30
  };
}

function runBacktest(candles, h4, indicators, slippage, period) {
  const trades = [];

  const halfSpread = SPREAD_USD / 2;

  const periodStart = Date.parse(period.start);
  const periodEnd = Date.parse(period.end);

  const firstAfterPeriod = candles.findIndex(
    x => x.time >= periodEnd
  );

  const lastIndex = firstAfterPeriod < 0
    ? candles.length - 1
    : firstAfterPeriod - 1;

  let h4Index = -1;
  let i = 60;

  while (i < lastIndex) {
    const signalCandle = candles[i];
    const signalCloseTime = signalCandle.time + 3600000;

    while (
      h4Index + 1 < h4.length &&
      h4[h4Index + 1].end <= signalCloseTime
    ) {
      h4Index++;
    }

    if (
      signalCloseTime <= periodStart ||
      signalCloseTime > periodEnd ||
      h4Index < 20
    ) {
      i++;
      continue;
    }

    const h1Trend =
      indicators.e20[i] > indicators.e50[i]
        ? "BUY"
        : indicators.e20[i] < indicators.e50[i]
          ? "SELL"
          : "WAIT";

    const h4Trend = trend(h4, h4Index, 8, 20);

    if (
      h1Trend === "WAIT" ||
      !h4Trend ||
      h1Trend !== h4Trend
    ) {
      i++;
      continue;
    }

    const histogram = indicators.histogram[i];

    if (
      histogram === null ||
      (h1Trend === "BUY" && histogram <= 0) ||
      (h1Trend === "SELL" && histogram >= 0)
    ) {
      i++;
      continue;
    }

    const atr = indicators.atr[i];

    if (!atr || !Number.isFinite(atr)) {
      i++;
      continue;
    }

    // Son tamamlanmış H1 mumunun kapanışı.
    const signalEntry = signalCandle.close;

    const riskDistance = Math.max(
      atr * STOP_ATR,
      Math.abs(signalEntry) * 0.001
    );

    // Gerçekleşen girişe spread ve kayma yaklaşımı eklenir.
    const entry = h1Trend === "BUY"
      ? signalEntry + halfSpread + slippage
      : signalEntry - halfSpread - slippage;

    // SL ve TP sinyalin referans kapanışından hesaplanır.
    const sl = h1Trend === "BUY"
      ? signalEntry - riskDistance
      : signalEntry + riskDistance;

    const tp = h1Trend === "BUY"
      ? signalEntry + riskDistance * TARGET_R
      : signalEntry - riskDistance * TARGET_R;

    let exit = null;
    let exitIndex = i + 1;
    let exitReason = null;

    const maxHoldIndex = Math.min(i + 72, lastIndex);

    // Sinyal mumundan sonraki mumda çıkış kontrolü başlar.
    for (let j = i + 1; j <= maxHoldIndex; j++) {
      const candle = candles[j];

      const hitSL = h1Trend === "BUY"
        ? candle.low - halfSpread <= sl
        : candle.high + halfSpread >= sl;

      const hitTP = h1Trend === "BUY"
        ? candle.high - halfSpread >= tp
        : candle.low + halfSpread <= tp;

      // Aynı mumda SL ve TP görülürse muhafazakâr olarak SL.
      if (hitSL) {
        exit = h1Trend === "BUY"
          ? sl - slippage
          : sl + slippage;

        exitIndex = j;
        exitReason = "STOP_LOSS";
        break;
      }

      if (hitTP) {
        exit = h1Trend === "BUY"
          ? tp - slippage
          : tp + slippage;

        exitIndex = j;
        exitReason = "TAKE_PROFIT";
        break;
      }

      // Pozisyon kapanış fiyatından maliyet düşülerek taşınır.
      exit = h1Trend === "BUY"
        ? candle.close - halfSpread - slippage
        : candle.close + halfSpread + slippage;

      exitIndex = j;
      exitReason = "TIME_EXIT";
    }

    if (exit === null) {
      i++;
      continue;
    }

    const profit = h1Trend === "BUY"
      ? exit - entry
      : entry - exit;

    trades.push({
      side: h1Trend,
      signalTime: new Date(signalCloseTime).toISOString(),
      entryReference: signalEntry,
      entry,
      stopLoss: sl,
      takeProfit: tp,
      exit,
      exitTime: new Date(
        candles[exitIndex].time + 3600000
      ).toISOString(),
      exitReason,
      netR: +(profit / riskDistance).toFixed(3)
    });

    // Aynı anda üst üste pozisyon açılmasını engelle.
    i = Math.max(i + 1, exitIndex + 1);
  }

  return {
    period: period.name,
    spreadUSD: SPREAD_USD,
    slippagePerSideUSD: slippage,
    entryReference: "LAST_COMPLETED_H1_CLOSE",
    stopATR: STOP_ATR,
    targetR: TARGET_R,
    metrics: getMetrics(trades),
    lastTrades: trades.slice(-10)
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

    url.searchParams.set("symbol", SYMBOL);
    url.searchParams.set("interval", "1h");
    url.searchParams.set("outputsize", "5000");
    url.searchParams.set("timezone", "UTC");
    url.searchParams.set("order", "ASC");

    const response = await fetch(url, {
      headers: {
        Authorization: `apikey ${key}`
      }
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

    const candles = body.values
      .map(x => ({
        time: parseTime(x.datetime),
        open: Number(x.open),
        high: Number(x.high),
        low: Number(x.low),
        close: Number(x.close)
      }))
      .filter(x =>
        Number.isFinite(x.time) &&
        x.time + 3600000 <= now &&
        [x.open, x.high, x.low, x.close]
          .every(Number.isFinite) &&
        x.high >= x.low
      )
      .sort((a, b) => a.time - b.time);

    if (candles.length < 500) {
      return res.status(422).json({
        ok: false,
        error: "INSUFFICIENT_HISTORY",
        candleCount: candles.length
      });
    }

    const h4 = makeH4(candles);

    if (h4.length < 50) {
      return res.status(422).json({
        ok: false,
        error: "INSUFFICIENT_COMPLETED_H4",
        candleCount: candles.length,
        h4CandleCount: h4.length
      });
    }

    const indicators = buildIndicators(candles);
    const results = [];

    for (const slippage of SLIPPAGES) {
      for (const period of PERIODS) {
        results.push(
          runBacktest(
            candles,
            h4,
            indicators,
            slippage,
            period
          )
        );
      }
    }

    const conservativeResults = results.filter(
      x => x.slippagePerSideUSD === 0.20
    );

    return res.status(200).json({
      ok: true,
      engine: "QUANT PRO XAUUSD BACKTEST V9",
      mode: "SIGNALS_ONLY",
      market: "XAUUSD",
      symbol: SYMBOL,
      provider: "Twelve Data",

      timeframe: "H1 + COMPLETED H4",

      candleCount: candles.length,
      h4CandleCount: h4.length,

      firstCandle: new Date(
        candles[0].time
      ).toISOString(),

      lastCandle: new Date(
        candles[candles.length - 1].time
      ).toISOString(),

      strategy: {
        h1: "EMA20 / EMA50",
        h4: "EMA8 / EMA20",
        macd: "12/26/9 HISTOGRAM DIRECTION",
        adxFilter: false,
        stopLoss: "ATR14 x 1.5",
        takeProfit: "2.0R",
        entry: "LAST COMPLETED H1 CLOSE",
        maxHoldingHours: 72
      },

      costModel: {
        method: "DIRECTIONAL_BID_ASK_APPROXIMATION",
        ohlcAssumedMidPrice: true,
        spreadUSD: SPREAD_USD,
        slippagePerSideUSD: SLIPPAGES,
        historicalXMSpreadAvailable: false,
        commissionVerified: false,
        note:
          "Sabit spread ve kayma yaklaşımıdır. Tarihsel XM bid/ask tick verisi ve komisyon doğrulanmamıştır."
      },

      sampleRequirement: 30,

      results,

      conservativeSummary: {
        slippagePerSideUSD: 0.20,
        periods: conservativeResults.map(x => ({
          period: x.period,
          metrics: x.metrics
        }))
      },

      historicalWinProbability: "NOT_A_LIVE_SIGNAL_PROBABILITY",

      executionStatus: "RESEARCH_ONLY_NOT_TRADE_READY",

      warning:
        "Bu tarihsel simülasyondur. Giriş, tamamlanmış H1 kapanış fiyatını referans alır; bu fiyatın canlı piyasada aynı şekilde gerçekleşeceği garanti değildir. Bağımsız ileri test ve gerçek XM işlem maliyetleri doğrulanmamıştır.",

      generatedAt: new Date().toISOString()
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "BACKTEST_FAILED",
      message: error.message
    });
  }
};
