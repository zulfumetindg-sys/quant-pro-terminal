
const { measureVolatilityShock } = require("./volatility");

const SYMBOL = "XAU/USD";
const STOP_ATR = 1.5;
const TARGET_R = 2.0;
const SPREAD_USD = 0.30;
const SLIPPAGES = [0.10, 0.20];
const MAX_HOLD_HOURS = 72;
const MAX_ENTRY_DISTANCE_PERCENT = 0.10;
const FORWARD_START = Date.parse("2026-11-26T20:00:00Z");

const PERIODS = [
  { name: "MAYIS_HAZIRAN", start: "2026-05-01T00:00:00Z", end: "2026-07-01T00:00:00Z" },
  { name: "TEMMUZ_AGUSTOS", start: "2026-07-01T00:00:00Z", end: "2026-09-01T00:00:00Z" },
  { name: "EYLUL_KASIM", start: "2026-09-01T00:00:00Z", end: "2026-12-01T00:00:00Z" }
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

  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
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

  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const k = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }
  return value;
}

function makeH4(candles) {
  const groups = new Map();

  for (const candle of candles) {
    const bucket = Math.floor(candle.time / 14400000) * 14400000;
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(candle);
  }

  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([time, group]) => {
      if (group.length !== 4) return false;
      group.sort((a, b) => a.time - b.time);
      return group.every((c, i) =>
        c.time === time + i * 3600000
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

  const close = candles.slice(0, index + 1).map(x => x.close);
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
  const grossLoss = Math.abs(losses.reduce((s, x) => s + x.netR, 0));
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
      : grossWin > 0 ? "NO_LOSSES" : null,
    netProfitR: +net.toFixed(2),
    maxDrawdownR: +drawdown.toFixed(2),
    averageR: trades.length
      ? +(net / trades.length).toFixed(3)
      : null,
    grossWinR: +grossWin.toFixed(3),
    grossLossR: +grossLoss.toFixed(3),
    insufficientSample: trades.length < 30
  };
}

function getSignal(candles, h4, indicators, i, h4Index) {
  if (h4Index < 20) return null;

  const h1Trend =
    indicators.e20[i] > indicators.e50[i] ? "BUY" :
    indicators.e20[i] < indicators.e50[i] ? "SELL" : "WAIT";

  const h4Trend = trend(h4, h4Index, 8, 20);

  if (!h4Trend || h1Trend === "WAIT" || h1Trend !== h4Trend) {
    return null;
  }

  const histogram = indicators.histogram[i];

  if (
    histogram === null ||
    (h1Trend === "BUY" && histogram <= 0) ||
    (h1Trend === "SELL" && histogram >= 0)
  ) return null;

  const atr = indicators.atr[i];
  if (!atr || !Number.isFinite(atr)) return null;

  // Live engine rejects entries when the current quote is too far
  // from the last completed H1 close. Historical tests use the next
  // H1 open as a reproducible proxy for the quote at signal execution.
  const nextOpen = candles[i + 1]?.open;
  if (!Number.isFinite(nextOpen) || nextOpen <= 0) return null;

  const entryDistancePercent =
    Math.abs(nextOpen - candles[i].close) /
    Math.abs(candles[i].close) * 100;

  if (entryDistancePercent > MAX_ENTRY_DISTANCE_PERCENT) return null;

  return {
    side: h1Trend,
    atr,
    volatilityShock: measureVolatilityShock(candles, i),
    reference: candles[i].close,
    entryDistancePercent
  };
}

function calculateTrade(candles, i, signal, slippage, maxIndex, forceCloseAtEnd) {
  const halfSpread = SPREAD_USD / 2;
  const { side, atr } = signal;

  // Signal is confirmed at candle i close; execution is modeled at
  // the next H1 candle open to avoid same-close execution lookahead.
  const executionReference = candles[i + 1].open;
  const riskDistance = Math.max(
    atr * STOP_ATR,
    Math.abs(executionReference) * 0.001
  );

  const entry = side === "BUY"
    ? executionReference + halfSpread + slippage
    : executionReference - halfSpread - slippage;

  // Define SL/TP from the actual cost-adjusted entry so 1R is the
  // true entry-to-stop distance, not the pre-cost signal reference.
  const sl = side === "BUY"
    ? entry - riskDistance
    : entry + riskDistance;

  const tp = side === "BUY"
    ? entry + riskDistance * TARGET_R
    : entry - riskDistance * TARGET_R;

  const maxHoldTime =
    candles[i].time + 3600000 + MAX_HOLD_HOURS * 3600000;

  for (let j = i + 1; j <= maxIndex; j++) {
    const candle = candles[j];

    const hitSL = side === "BUY"
      ? candle.low - halfSpread <= sl
      : candle.high + halfSpread >= sl;

    const hitTP = side === "BUY"
      ? candle.high - halfSpread >= tp
      : candle.low + halfSpread <= tp;

    let exit = null;
    let exitReason = null;

    if (hitSL) {
      // A stop crossed by an opening gap fills at the worse opening quote,
      // not at the stale stop level. Intrabar collisions remain stop-first.
      const openingQuote = side === "BUY"
        ? candle.open - halfSpread
        : candle.open + halfSpread;
      const gappedThroughStop = side === "BUY"
        ? openingQuote <= sl
        : openingQuote >= sl;
      exit = gappedThroughStop
        ? (side === "BUY" ? openingQuote - slippage : openingQuote + slippage)
        : (side === "BUY" ? sl - slippage : sl + slippage);
      exitReason = "STOP_LOSS";
    } else if (hitTP) {
      exit = side === "BUY" ? tp - slippage : tp + slippage;
      exitReason = "TAKE_PROFIT";
    } else if (
      candle.time + 3600000 >= maxHoldTime ||
      (forceCloseAtEnd && j === maxIndex)
    ) {
      exit = side === "BUY"
        ? candle.close - halfSpread - slippage
        : candle.close + halfSpread + slippage;
      exitReason = "TIME_EXIT";
    }

    if (exit === null) continue;

    const profit = side === "BUY"
      ? exit - entry
      : entry - exit;

    return {
      side,
      volatilityShock: signal.volatilityShock || null,
      signalTime: new Date(candles[i].time + 3600000).toISOString(),
      entryReference: executionReference,
      entry,
      stopLoss: sl,
      takeProfit: tp,
      exit,
      exitTime: new Date(candle.time + 3600000).toISOString(),
      exitReason,
      netR: +(profit / riskDistance).toFixed(3),
      exitIndex: j
    };
  }

  const last = candles[maxIndex];
  const markPrice = side === "BUY"
    ? last.close - halfSpread - slippage
    : last.close + halfSpread + slippage;

  return {
    open: true,
    side,
    volatilityShock: signal.volatilityShock || null,
    signalTime: new Date(candles[i].time + 3600000).toISOString(),
    entryReference: executionReference,
    entry,
    stopLoss: sl,
    takeProfit: tp,
    lastPrice: last.close,
    unrealizedR: +(
      (side === "BUY" ? markPrice - entry : entry - markPrice) /
      riskDistance
    ).toFixed(3),
    status: "OPEN_NOT_COUNTED"
  };
}

function summarizeVolatilityDiagnostics(trades) {
  const values = trades
    .map(trade => trade?.volatilityShock?.ratio)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const percentile = p => values.length
    ? values[Math.min(values.length - 1, Math.ceil(p * values.length) - 1)]
    : null;
  return {
    sampleCount: values.length,
    medianRatio: percentile(0.50),
    p75Ratio: percentile(0.75),
    p90Ratio: percentile(0.90),
    maximumRatio: values.length ? values[values.length - 1] : null,
    interpretation: "DIAGNOSTIC_ONLY_NO_VOLATILITY_BLOCKING_THRESHOLD"
  };
}

function runBacktest(candles, h4, indicators, slippage, period) {
  const trades = [];
  const periodStart = Date.parse(period.start);
  const periodEnd = Date.parse(period.end);

  const firstAfterPeriod = candles.findIndex(
    x => x.time >= periodEnd
  );
  const periodComplete = firstAfterPeriod >= 0;

  const lastIndex = periodComplete
    ? firstAfterPeriod - 1
    : candles.length - 1;

  let h4Index = -1;
  let i = 60;
  let openTrade = null;

  while (i < lastIndex) {
    const signalCloseTime = candles[i].time + 3600000;

    while (
      h4Index + 1 < h4.length &&
      h4[h4Index + 1].end <= signalCloseTime
    ) h4Index++;

    if (
      signalCloseTime <= periodStart ||
      signalCloseTime >= periodEnd
    ) {
      i++;
      continue;
    }

    const signal = getSignal(candles, h4, indicators, i, h4Index);

    if (!signal) {
      i++;
      continue;
    }

    const trade = calculateTrade(
      candles, i, signal, slippage, lastIndex, periodComplete
    );

    if (trade.open) {
      openTrade = trade;
      break;
    }

    const exitIndex = trade.exitIndex;
    delete trade.exitIndex;

    trades.push(trade);
    i = Math.max(i + 1, exitIndex + 1);
  }

  return {
    period: period.name,
    periodComplete,
    periodStatus: periodComplete ? "PERIOD_COMPLETE" : "PERIOD_STILL_RUNNING",
    spreadUSD: SPREAD_USD,
    slippagePerSideUSD: slippage,
    entryReference: "NEXT_H1_OPEN_AFTER_SIGNAL",
    stopATR: STOP_ATR,
    targetR: TARGET_R,
    metrics: getMetrics(trades),
    volatilityDiagnostics: summarizeVolatilityDiagnostics([...trades, openTrade]),
    openTrade,
    lastTrades: trades.slice(-10)
  };
}

function hasForwardWarmup(candles, forwardStart) {
  // EMA20 on H4 needs a materially longer warmup than 100 H1 hours.
  // Use at least 5x the slowest EMA period (100 completed H4 bars),
  // and at least 400 completed H1 bars before the forward boundary.
  const history = candles.filter(c => c.time + 3600000 <= forwardStart);
  if (history.length < 400) return false;

  const h1Warmup = history.slice(-400);
  const maxGapMs = 72 * 3600000;

  if (h1Warmup[h1Warmup.length - 1].time + 3600000 <
      forwardStart - maxGapMs) return false;

  for (let i = 1; i < h1Warmup.length; i++) {
    if (h1Warmup[i].time - h1Warmup[i - 1].time > maxGapMs) return false;
  }

  const h4Warmup = makeH4(history).slice(-100);
  if (h4Warmup.length < 100) return false;

  if (h4Warmup[h4Warmup.length - 1].end <
      forwardStart - maxGapMs) return false;

  for (let i = 1; i < h4Warmup.length; i++) {
    if (h4Warmup[i].time - h4Warmup[i - 1].time > maxGapMs) return false;
  }

  return true;
}

function hasForwardContinuity(candles, forwardStart) {
  const forward = candles.filter(c => c.time >= forwardStart);
  // An empty forward window is missing evidence, not a continuous test period.
  if (forward.length === 0) return false;

  const maxGapMs = 72 * 3600000;
  if (forward[0].time - forwardStart > maxGapMs) return false;

  for (let i = 1; i < forward.length; i++) {
    if (forward[i].time - forward[i - 1].time > maxGapMs) return false;
  }
  return true;
}

function runForwardTest(candles, h4, indicators, slippage) {
  const trades = [];
  let openTrade = null;
  let h4Index = -1;
  let i = 60;

  while (i < candles.length - 1) {
    const signalCloseTime = candles[i].time + 3600000;

    // Başlangıç anındaki ve öncesindeki mumları kesinlikle alma.
    if (signalCloseTime <= FORWARD_START) {
      i++;
      continue;
    }

    while (
      h4Index + 1 < h4.length &&
      h4[h4Index + 1].end <= signalCloseTime
    ) h4Index++;

    const signal = getSignal(candles, h4, indicators, i, h4Index);

    if (!signal) {
      i++;
      continue;
    }

    const trade = calculateTrade(
      candles,
      i,
      signal,
      slippage,
      candles.length - 1,
      false
    );

    if (trade.open) {
      openTrade = trade;
      break;
    }

    const exitIndex = trade.exitIndex;
    delete trade.exitIndex;

    trades.push(trade);
    i = Math.max(i + 1, exitIndex + 1);
  }

  return {
    periodStart: new Date(FORWARD_START).toISOString(),
    spreadUSD: SPREAD_USD,
    slippagePerSideUSD: slippage,
    strategy: "V9_UNCHANGED",
    closedTradeMetrics: getMetrics(trades),
    volatilityDiagnostics: summarizeVolatilityDiagnostics([...trades, openTrade]),
    openTrade,
    closedTrades: trades,
    lastClosedTrades: trades.slice(-10),
    status: trades.length < 30
      ? "COLLECTING_MINIMUM_30_CLOSED_TRADES"
      : "FORWARD_SAMPLE_30_REACHED"
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

    const candleMap = new Map();

    for (const x of body.values) {
      const candle = {
        time: parseTime(x.datetime),
        open: Number(x.open),
        high: Number(x.high),
        low: Number(x.low),
        close: Number(x.close)
      };

      if (
        !Number.isFinite(candle.time) ||
        ![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) ||
        candle.high < Math.max(candle.open, candle.close, candle.low) ||
        candle.low > Math.min(candle.open, candle.close, candle.high)
      ) continue;

      if (candle.time + 3600000 <= Date.now()) {
        candleMap.set(candle.time, candle);
      }
    }

    const candles = [...candleMap.values()]
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
    const mode = req.query?.mode;

    if (mode === "forward") {
      const forwardCandles = candles.filter(
        x => x.time >= FORWARD_START
      );

      const warmupComplete = hasForwardWarmup(candles, FORWARD_START);
      const forwardContinuity = hasForwardContinuity(candles, FORWARD_START);

      if (!forwardContinuity) {
        return res.status(422).json({
          ok: false,
          error: "FORWARD_TEST_DATA_GAP",
          mode: "OUT_OF_SAMPLE_FORWARD_TEST",
          symbol: SYMBOL,
          startTime: new Date(FORWARD_START).toISOString(),
          maximumAllowedGapHours: 72,
          historyStatus: "FORWARD_CANDLE_SEQUENCE_INCOMPLETE",
          executionStatus: "RESEARCH_ONLY_NOT_TRADE_READY",
          warning: "İleri test döneminde 72 saati aşan veri boşluğu bulundu. Eksik fiyat hareketleriyle performans hesaplanmadı."
        });
      }

      // Do not publish forward-test metrics when the original warmup window
      // has rolled out of the provider's limited historical candle window.
      if (!warmupComplete) {
        return res.status(422).json({
          ok: false,
          error: "FORWARD_TEST_WARMUP_INCOMPLETE",
          mode: "OUT_OF_SAMPLE_FORWARD_TEST",
          symbol: SYMBOL,
          startTime: new Date(FORWARD_START).toISOString(),
          firstAvailableCandle: new Date(candles[0].time).toISOString(),
          requiredHistory: { minimumCompletedH1Candles: 400, minimumCompletedH4Candles: 100, maximumGapHours: 72 },
          historyStatus: "HISTORY_MAY_BE_TRUNCATED",
          persistence: "NOT_STORED_PERMANENTLY",
          executionStatus: "RESEARCH_ONLY_NOT_TRADE_READY",
          warning: "İleri test için gereken 400 tamamlanmış H1 ve 100 tamamlanmış H4 ısınma mumu veya kesintisiz geçmiş bulunamadı. Yanıltıcı ileri test sonucu üretilmedi."
        });
      }

      const results = SLIPPAGES.map(slippage =>
        runForwardTest(candles, h4, indicators, slippage)
      );

      return res.status(200).json({
        ok: true,
        schemaVersion: 2,
        engine: "QUANT PRO XAUUSD FORWARD TEST V2",
        mode: "OUT_OF_SAMPLE_FORWARD_TEST",
        symbol: SYMBOL,
        provider: "Twelve Data",
        timeframe: "H1 + COMPLETED H4",
        startTime: new Date(FORWARD_START).toISOString(),
        firstForwardCandle: forwardCandles.length
          ? new Date(forwardCandles[0].time).toISOString()
          : null,
        lastForwardCandle: forwardCandles.length
          ? new Date(forwardCandles[forwardCandles.length - 1].time + 3600000).toISOString()
          : null,
        forwardCandleCount: forwardCandles.length,
        warmupComplete,
        historyStatus: warmupComplete
          ? "START_AND_INDICATOR_HISTORY_AVAILABLE"
          : "HISTORY_MAY_BE_TRUNCATED",
        strategy: {
          h1: "EMA20 / EMA50",
          h4: "EMA8 / EMA20",
          macd: "12/26/9 HISTOGRAM DIRECTION",
          stopLoss: "ATR14 x 1.5",
          takeProfit: "2.0R",
          maxHoldingHours: MAX_HOLD_HOURS,
          maxEntryDistancePercent: MAX_ENTRY_DISTANCE_PERCENT,
          historicalEntryDistanceProxy: "NEXT_H1_OPEN_VS_SIGNAL_H1_CLOSE"
        },
        results,
        persistence: "NOT_STORED_PERMANENTLY",
        executionStatus: "RESEARCH_ONLY_NOT_TRADE_READY",
        warning: "İleri test, Twelve Data'nın sunduğu son 5000 mum üzerinden yeniden hesaplanır. Kalıcı veri tabanı olmadığı için sağlayıcının geçmiş mum sınırı aşılırsa eski test verileri kaybolabilir. Gerçek piyasa spread ve komisyonu doğrulanmamıştır.",
        generatedAt: new Date().toISOString()
      });
    }

    const results = [];

    for (const slippage of SLIPPAGES) {
      for (const period of PERIODS) {
        results.push(
          runBacktest(candles, h4, indicators, slippage, period)
        );
      }
    }

    const conservativeResults = results.filter(
      x => x.slippagePerSideUSD === 0.20
    );

    return res.status(200).json({
      ok: true,
      engine: "QUANT PRO XAUUSD BACKTEST V10",
      mode: "SIGNALS_ONLY",
      market: "XAUUSD",
      symbol: SYMBOL,
      provider: "Twelve Data",
      timeframe: "H1 + COMPLETED H4",
      candleCount: candles.length,
      h4CandleCount: h4.length,
      firstCandle: new Date(candles[0].time).toISOString(),
      lastCandle: new Date(candles[candles.length - 1].time).toISOString(),
      strategy: {
        h1: "EMA20 / EMA50",
        h4: "EMA8 / EMA20",
        macd: "12/26/9 HISTOGRAM DIRECTION",
        adxFilter: false,
        stopLoss: "ATR14 x 1.5",
        takeProfit: "2.0R",
        signalReference: "LAST_COMPLETED_H1_CLOSE",
        entry: "NEXT_H1_OPEN_AFTER_SIGNAL",
        maxHoldingHours: MAX_HOLD_HOURS,
        maxEntryDistancePercent: MAX_ENTRY_DISTANCE_PERCENT,
        historicalEntryDistanceProxy: "NEXT_H1_OPEN_VS_SIGNAL_H1_CLOSE"
      },
      costModel: {
        method: "DIRECTIONAL_BID_ASK_APPROXIMATION",
        ohlcAssumedMidPrice: true,
        spreadUSD: SPREAD_USD,
        slippagePerSideUSD: SLIPPAGES,
        brokerSpecificSpreadVerified: false,
        commissionVerified: false
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
      warning: "Bu sonuçlar tarihsel OHLC simülasyonudur. Önceki V9 sonuçlarıyla birebir karşılaştırılmamalıdır; işlem sırası ve dönem sınırı düzeltmeleri nedeniyle yeniden hesaplanmıştır. Gerçek piyasa işlem maliyetleri doğrulanmamıştır.",
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


// Export pure strategy functions for the Node test runner. The default export remains the Vercel handler.
module.exports.__test = {
  parseTime, emaSeries, ema, makeH4, trend, buildIndicators,
  getMetrics, getSignal, calculateTrade, runBacktest, runForwardTest, summarizeVolatilityDiagnostics,
  hasForwardWarmup, hasForwardContinuity
};
