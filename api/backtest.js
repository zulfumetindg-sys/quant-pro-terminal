
const SYMBOL = "XAU/USD";
const MARKET = "XAUUSD";

const COST = {
  spreadUSD: 0.30,
  slippagePerSideUSD: [0.10, 0.20],
  commissionPerTradeUSD: 0
};

const PERIODS = [
  {
    name: "MAYIS_HAZIRAN",
    start: "2026-05-01T00:00:00.000Z",
    end: "2026-07-01T00:00:00.000Z"
  },
  {
    name: "TEMMUZ_AGUSTOS",
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-09-01T00:00:00.000Z"
  },
  {
    name: "EYLUL_KASIM",
    start: "2026-09-01T00:00:00.000Z",
    end: "2026-12-01T00:00:00.000Z"
  }
];

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
    [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.high >= c.low
  ).sort((a, b) => a.time - b.time);
}

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
    .filter(([start, group]) =>
      group.length === 4 &&
      group.every((c, i) =>
        c.time === start + i * 3600000
      )
    )
    .map(([start, group]) => ({
      time: start,
      end: start + 4 * 3600000,
      open: group[0].open,
      high: Math.max(...group.map(c => c.high)),
      low: Math.min(...group.map(c => c.low)),
      close: group[3].close
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

function calculateMetrics(trades) {
  const wins = trades.filter(t => t.netR > 0);
  const losses = trades.filter(t => t.netR < 0);

  const grossProfit = wins.reduce((s, t) => s + t.netR, 0);
  const grossLoss = Math.abs(
    losses.reduce((s, t) => s + t.netR, 0)
  );

  const net = trades.reduce((s, t) => s + t.netR, 0);

  let equity = 0;
  let peak = 0;
  let maxDD = 0;

  for (const t of trades) {
    equity += t.netR;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }

  const count = trades.length;

  return {
    tradeCount: count,
    winCount: wins.length,
    lossCount: losses.length,
    winRatePercent: count
      ? Number((wins.length / count * 100).toFixed(2))
      : null,
    profitFactor: grossLoss > 0
      ? Number((grossProfit / grossLoss).toFixed(3))
      : null,
    netProfitR: Number(net.toFixed(2)),
    maxDrawdownR: Number(maxDD.toFixed(2)),
    averageR: count
      ? Number((net / count).toFixed(3))
      : null,
    insufficientSample: count < 30
  };
}

function runPeriod(candles, h4, slippage, period) {
  const trades = [];
  const halfSpread = COST.spreadUSD / 2;

  const startTime = Date.parse(period.start);
  const endTime = Date.parse(period.end);

  let h4Index = -1;

  const endIndex = candles.findIndex(c => c.time >= endTime);
  const lastIndex = endIndex === -1
    ? candles.length - 1
    : endIndex - 1;

  let i = 60;

  while (i < lastIndex) {
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

    const next = candles[i + 1];

    // İşlem yalnızca ilgili dönemde açılabilir.
    if (next.time < startTime || next.time >= endTime) {
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

    const riskDistance = Math.max(
      volatility * 1.5,
      Math.abs(next.open) * 0.001
    );

    const entry = side === "BUY"
      ? next.open + halfSpread + slippage
      : next.open - halfSpread - slippage;

    const sl = side === "BUY"
      ? entry - riskDistance
      : entry + riskDistance;

    const tp = side === "BUY"
      ? entry + riskDistance * 1.8
      : entry - riskDistance * 1.8;

    let exit = null;
    let exitReason = "TIME_EXIT";
    let exitIndex = i + 1;

    // İşlem, test edilen dönemin dışına taşamaz.
    const maxHold = Math.min(i + 72, lastIndex);

    for (let j = i + 1; j <= maxHold; j++) {
      const c = candles[j];

      const bidLow = c.low - halfSpread;
      const bidHigh = c.high - halfSpread;
      const askLow = c.low + halfSpread;
      const askHigh = c.high + halfSpread;

      const hitSL = side === "BUY"
        ? bidLow <= sl
        : askHigh >= sl;

      const hitTP = side === "BUY"
        ? bidHigh >= tp
        : askLow <= tp;

      // Aynı mumda SL ve TP: SL önce kabul edilir.
      if (hitSL) {
        exit = side === "BUY"
          ? sl - slippage
          : sl + slippage;

        exitReason = "STOP_LOSS";
        exitIndex = j;
        break;
      }

      if (hitTP) {
        exit = side === "BUY"
          ? tp - slippage
          : tp + slippage;

        exitReason = "TAKE_PROFIT";
        exitIndex = j;
        break;
      }

      exit = side === "BUY"
        ? c.close - halfSpread - slippage
        : c.close + halfSpread + slippage;

      exitIndex = j;
    }

    if (exit === null) {
      i++;
      continue;
    }

    const priceProfit = side === "BUY"
      ? exit - entry
      : entry - exit;

    const netR = (
      priceProfit - COST.commissionPerTradeUSD
    ) / riskDistance;

    trades.push({
      side,
      entry,
      exit,
      netR,
      exitReason,
      entryTime: new Date(next.time).toISOString(),
      exitTime: new Date(candles[exitIndex].time).toISOString()
    });

    i = Math.max(i + 1, exitIndex + 1);
  }

  return {
    period: period.name,
    start: period.start,
    endExclusive: period.end,
    assumptions: {
      spreadUSD: COST.spreadUSD,
      slippagePerSideUSD: slippage,
      commissionPerTradeUSD: COST.commissionPerTradeUSD
    },
    metrics: calculateMetrics(trades)
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

    const h4 = makeH4(candles);

    const scenarios = COST.slippagePerSideUSD.map(slippage => ({
      name: `SLIPPAGE_${slippage.toFixed(2)}_PER_SIDE`,
      periods: PERIODS.map(period =>
        runPeriod(candles, h4, slippage, period)
      )
    }));

    return res.status(200).json({
      ok: true,
      engine: "QUANT PRO XAUUSD BACKTEST V4",
      market: MARKET,
      symbol: SYMBOL,
      timeframe: "H1 + COMPLETED H4",
      provider: "Twelve Data",
      candleCount: candles.length,
      h4CandleCount: h4.length,
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
        method: "DIRECTIONAL_BID_ASK_APPROXIMATION",
        ohlcAssumedMidPrice: true,
        spreadUSD: COST.spreadUSD,
        slippagePerSideUSD: COST.slippagePerSideUSD,
        commissionPerTradeUSD: COST.commissionPerTradeUSD,
        historicalXMSpreadAvailable: false,
        commissionVerified: false
      },

      periodMethod: {
        indicatorWarmupUsesEarlierCandles: true,
        tradesCountedOnlyInTheirEntryPeriod: true,
        tradesCannotExitOutsideTheirPeriod: true,
        periods: PERIODS
      },

      scenarios,
      sampleRequirement: 30,
      executionStatus: "NOT_TRADE_READY",
      warning: "Bu sonuçlar OHLC verisiyle yapılan yaklaşık simülasyondur; tarihsel XM bid/ask veya tick verisi değildir.",
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
