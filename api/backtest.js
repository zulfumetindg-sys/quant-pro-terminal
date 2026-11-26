
const SYMBOL = "XAU/USD";
const MARKET = "XAUUSD";

const COST = {
  spread: 0.30,
  slippagePerSide: [0.10, 0.20],
  commissionPerTrade: 0
};

function parseTime(value) {
  const s = String(value).replace(" ", "T");
  return Date.parse(s.endsWith("Z") ? s : s + "Z");
}

function normalize(values) {
  const now = Date.now();

  return values.map(c => ({
    time: parseTime(c.datetime),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close)
  })).filter(c =>
    Number.isFinite(c.time) &&
    c.time + 3600000 <= now &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    c.high >= c.low
  ).sort((a, b) => a.time - b.time);
}

function ema(values, period) {
  if (values.length < period) return null;

  let e = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  const k = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }

  return e;
}

function atr(candles, end, period = 14) {
  if (end < period) return null;

  let sum = 0;

  for (let i = end - period + 1; i <= end; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    sum += Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );
  }

  return sum / period;
}

function makeH4(candles) {
  const groups = new Map();

  for (const c of candles) {
    const d = new Date(c.time);
    const start = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      Math.floor(d.getUTCHours() / 4) * 4
    );

    if (!groups.has(start)) groups.set(start, []);
    groups.get(start).push(c);
  }

  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([start, g]) => {
      if (g.length !== 4) return false;

      for (let i = 0; i < 4; i++) {
        if (g[i].time !== start + i * 3600000) {
          return false;
        }
      }

      return true;
    })
    .map(([start, g]) => ({
      time: start,
      end: start + 4 * 3600000,
      open: g[0].open,
      high: Math.max(...g.map(x => x.high)),
      low: Math.min(...g.map(x => x.low)),
      close: g[3].close
    }));
}

function trend(candles, index, fastPeriod, slowPeriod) {
  if (index + 1 < slowPeriod) return null;

  const closes = candles
    .slice(0, index + 1)
    .map(c => c.close);

  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);

  if (fast === null || slow === null) return null;

  if (fast > slow) return "BUY";
  if (fast < slow) return "SELL";
  return "WAIT";
}

function calculateMetrics(trades, costPerTrade) {
  const results = trades.map(t => ({
    ...t,
    costPrice: costPerTrade,
    netR: t.grossR - costPerTrade / t.risk
  }));

  const wins = results.filter(t => t.netR > 0);
  const losses = results.filter(t => t.netR < 0);

  const grossProfitR = wins.reduce((s, t) => s + t.netR, 0);
  const grossLossR = Math.abs(
    losses.reduce((s, t) => s + t.netR, 0)
  );

  const netR = results.reduce((s, t) => s + t.netR, 0);

  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;

  for (const t of results) {
    equity += t.netR;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(
      maxDrawdownR,
      peak - equity
    );
  }

  const count = results.length;
  const enoughData = count >= 30;

  return {
    tradeCount: count,
    winCount: wins.length,
    lossCount: losses.length,
    winRatePercent: enoughData
      ? Number((wins.length / count * 100).toFixed(2))
      : null,
    profitFactor: grossLossR > 0
      ? Number((grossProfitR / grossLossR).toFixed(3))
      : null,
    netProfitR: Number(netR.toFixed(2)),
    maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
    averageR: count
      ? Number((netR / count).toFixed(3))
      : null,
    insufficientSample: !enoughData,
    lastTrades: results.slice(-10).map(t => ({
      side: t.side,
      entry: Number(t.entry.toFixed(3)),
      exit: Number(t.exit.toFixed(3)),
      grossR: Number(t.grossR.toFixed(3)),
      costR: Number((t.costPrice / t.risk).toFixed(3)),
      netR: Number(t.netR.toFixed(3)),
      outcome: t.outcome
    }))
  };
}

function runBacktest(candles) {
  const h4 = makeH4(candles);
  const trades = [];

  let h4Index = -1;
  let i = 60;

  while (i < candles.length - 2) {
    const signalCloseTime = candles[i].time + 3600000;

    while (
      h4Index + 1 < h4.length &&
      h4[h4Index + 1].end <= signalCloseTime
    ) {
      h4Index++;
    }

    if (h4Index < 20) {
      i++;
      continue;
    }

    const h1Trend = trend(candles, i, 20, 50);
    const h4Trend = trend(h4, h4Index, 8, 20);

    if (
      !h1Trend ||
      !h4Trend ||
      h1Trend === "WAIT" ||
      h1Trend !== h4Trend
    ) {
      i++;
      continue;
    }

    const volatility = atr(candles, i);

    if (!volatility) {
      i++;
      continue;
    }

    const side = h1Trend;
    const entry = candles[i + 1].open;

    const risk = Math.max(
      volatility * 1.5,
      Math.abs(entry) * 0.001
    );

    const sl = side === "BUY"
      ? entry - risk
      : entry + risk;

    const tp = side === "BUY"
      ? entry + risk * 1.8
      : entry - risk * 1.8;

    let outcome = "TIME_EXIT";
    let exitPrice = null;
    let exitIndex = i + 1;

    const maxHold = Math.min(i + 72, candles.length - 1);

    for (let j = i + 1; j <= maxHold; j++) {
      const c = candles[j];

      const hitSL = side === "BUY"
        ? c.low <= sl
        : c.high >= sl;

      const hitTP = side === "BUY"
        ? c.high >= tp
        : c.low <= tp;

      // Aynı mumda SL ve TP: kötümser olarak SL önce.
      if (hitSL) {
        outcome = "LOSS";
        exitPrice = sl;
        exitIndex = j;
        break;
      }

      if (hitTP) {
        outcome = "WIN";
        exitPrice = tp;
        exitIndex = j;
        break;
      }

      exitPrice = c.close;
      exitIndex = j;
    }

    const grossR = side === "BUY"
      ? (exitPrice - entry) / risk
      : (entry - exitPrice) / risk;

    trades.push({
      side,
      entry,
      exit: exitPrice,
      sl,
      tp,
      risk,
      grossR,
      outcome,
      entryTime: new Date(candles[i + 1].time).toISOString(),
      exitTime: new Date(candles[exitIndex].time).toISOString()
    });

    i = Math.max(i + 1, exitIndex + 1);
  }

  const gross = calculateMetrics(trades, 0);

  const scenarios = COST.slippagePerSide.map(slippage => {
    const totalCost =
      COST.spread +
      (slippage * 2) +
      COST.commissionPerTrade;

    return {
      name: `SPREAD_0.30_SLIPPAGE_${slippage.toFixed(2)}_EACH_SIDE`,
      assumptions: {
        spread: COST.spread,
        slippagePerSide: slippage,
        commissionPerTrade: COST.commissionPerTrade,
        totalCostPerTrade: Number(totalCost.toFixed(3))
      },
      metrics: calculateMetrics(trades, totalCost)
    };
  });

  return {
    tradeCount: trades.length,
    grossResults: gross,
    costScenarios: scenarios,
    sampleRequirement: 30,
    costWarning: "FIXED_SPREAD_ASSUMPTION_NOT_LIVE_XM_HISTORY"
  };
}

module.exports = async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=3600, stale-while-revalidate=300"
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
        message: body.message || "Geçmiş altın verisi alınamadı."
      });
    }

    const candles = normalize(body.values);

    if (candles.length < 500) {
      return res.status(422).json({
        ok: false,
        error: "INSUFFICIENT_HISTORY",
        receivedCandles: candles.length,
        requiredCandles: 500
      });
    }

    const report = runBacktest(candles);

    return res.status(200).json({
      ok: true,
      engine: "QUANT PRO XAUUSD BACKTEST V2",
      market: MARKET,
      symbol: SYMBOL,
      timeframe: "H1 + COMPLETED H4",
      provider: "Twelve Data",
      candleCount: candles.length,
      firstCandle: new Date(candles[0].time).toISOString(),
      lastCandle: new Date(candles[candles.length - 1].time).toISOString(),
      strategy: {
        h1: "EMA20 / EMA50",
        h4: "EMA8 / EMA20",
        stopLoss: "ATR14 x 1.5",
        takeProfit: "1.8R",
        entry: "NEXT H1 CANDLE OPEN",
        maxHoldingHours: 72
      },
      costModel: {
        spreadUSD: COST.spread,
        slippageScenariosUSDPerSide: COST.slippagePerSide,
        commissionPerTradeUSD: COST.commissionPerTrade,
        note: "Approximate fixed-cost stress test; not tick-level XM execution simulation."
      },
      report,
      generatedAt: new Date().toISOString()
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "BACKTEST_ERROR",
      message: error.message
    });
  }
};
