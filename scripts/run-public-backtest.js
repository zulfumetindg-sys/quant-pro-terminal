"use strict";

const fs = require("node:fs");
const path = require("node:path");
const engine = require("../api/backtest").__test;

const file = process.argv[2] || "/tmp/XAUUSD_1h.csv";
if (!fs.existsSync(file)) throw new Error("PUBLIC_XAUUSD_CSV_NOT_FOUND: " + file);

let raw = fs.readFileSync(file, "utf8");
if (raw.charCodeAt(0) === 65279) raw = raw.slice(1);
const lines = raw.trim().split(String.fromCharCode(10)).map(line =>
  line.endsWith(String.fromCharCode(13)) ? line.slice(0, -1) : line
);
if (lines.length < 501) throw new Error("PUBLIC_XAUUSD_SAMPLE_TOO_SMALL");

const headers = lines[0].split(",").map(x => x.trim().toLowerCase());
const required = ["datetime", "open", "high", "low", "close"];
for (const name of required) {
  if (!headers.includes(name)) throw new Error("CSV_MISSING_COLUMN: " + name);
}

const rows = lines.slice(1).map(line => {
  const cells = line.split(",");
  const row = {};
  headers.forEach((header, index) => { row[header] = (cells[index] || "").trim(); });
  return row;
});

const candles = engine.normalizeHistoricalCandles(rows, Date.now());
if (candles.length < 500) throw new Error("VALID_CANDLE_COUNT_TOO_SMALL");

const h4 = engine.makeH4(candles);
const indicators = engine.buildIndicators(candles);
const periods = [
  { name: "MAYIS_HAZIRAN", start: "2026-05-01T00:00:00Z", end: "2026-07-01T00:00:00Z" },
  { name: "TEMMUZ_AGUSTOS", start: "2026-07-01T00:00:00Z", end: "2026-09-01T00:00:00Z" },
  { name: "EYLUL_KASIM", start: "2026-09-01T00:00:00Z", end: "2026-12-01T00:00:00Z" }
];

const slippageScenarios = [0.10, 0.20, 0.30, 0.50];
const results = [];
const diagnosticTradesBySlippage = new Map();
for (const slippage of slippageScenarios) {
  for (const period of periods) {
    const result = engine.runBacktest(candles, h4, indicators, slippage, period, Date.now(), { includeTrades: true });
    if (result.periodStatus === "PERIOD_COMPLETE" && Array.isArray(result.closedTrades)) {
      diagnosticTradesBySlippage.set(slippage, [
        ...(diagnosticTradesBySlippage.get(slippage) || []),
        ...result.closedTrades.map(trade => ({ ...trade, period: period.name, slippagePerSideUSD: slippage }))
      ]);
    }
    results.push({
      period: result.period,
      periodStatus: result.periodStatus,
      periodComplete: result.periodComplete,
      warmupComplete: result.warmupComplete,
      continuityComplete: result.continuityComplete ?? null,
      spreadUSD: result.spreadUSD,
      slippagePerSideUSD: result.slippagePerSideUSD,
      metrics: result.metrics,
      warning: result.warning || null
    });
  }
}


const aggregateBySlippage = slippageScenarios.map(slippage => {
  const included = results.filter(x =>
    x.slippagePerSideUSD === slippage &&
    x.periodStatus === "PERIOD_COMPLETE" &&
    x.metrics
  );
  const tradeCount = included.reduce((sum, x) => sum + x.metrics.tradeCount, 0);
  const winCount = included.reduce((sum, x) => sum + x.metrics.winCount, 0);
  const lossCount = included.reduce((sum, x) => sum + x.metrics.lossCount, 0);
  const grossWinR = included.reduce((sum, x) => sum + x.metrics.grossWinR, 0);
  const grossLossR = included.reduce((sum, x) => sum + x.metrics.grossLossR, 0);
  const netProfitR = included.reduce((sum, x) => sum + x.metrics.netProfitR, 0);
  return {
    slippagePerSideUSD: slippage,
    completedPeriodsIncluded: included.map(x => x.period),
    tradeCount,
    winCount,
    lossCount,
    winRatePercent: tradeCount ? Number((winCount / tradeCount * 100).toFixed(2)) : null,
    profitFactor: grossLossR > 0 ? Number((grossWinR / grossLossR).toFixed(3)) : null,
    netProfitR: Number(netProfitR.toFixed(2)),
    averageR: tradeCount ? Number((netProfitR / tradeCount).toFixed(3)) : null,
    grossWinR: Number(grossWinR.toFixed(3)),
    grossLossR: Number(grossLossR.toFixed(3)),
    worstSinglePeriodMaxDrawdownR: included.length
      ? Math.max(...included.map(x => x.metrics.maxDrawdownR))
      : null,
    note: "Worst drawdown among included periods; not a combined chronological drawdown."
  };
});

function summarizeTradeSequence(trades) {
  const ordered = [...trades].sort((a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime));
  let equity = 0, peak = 0, maxDrawdownR = 0, currentLossStreak = 0, longestLossStreak = 0;
  for (const trade of ordered) {
    equity += trade.netR;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
    if (trade.netR < 0) {
      currentLossStreak++;
      longestLossStreak = Math.max(longestLossStreak, currentLossStreak);
    } else if (trade.netR > 0) currentLossStreak = 0;
  }
  const group = list => {
    const wins = list.filter(x => x.netR > 0).length;
    const grossWin = list.filter(x => x.netR > 0).reduce((s, x) => s + x.netR, 0);
    const grossLoss = Math.abs(list.filter(x => x.netR < 0).reduce((s, x) => s + x.netR, 0));
    const net = list.reduce((s, x) => s + x.netR, 0);
    return {
      trades: list.length,
      wins,
      losses: list.filter(x => x.netR < 0).length,
      winRatePercent: list.length ? Number((wins / list.length * 100).toFixed(2)) : null,
      profitFactor: grossLoss ? Number((grossWin / grossLoss).toFixed(3)) : null,
      netR: Number(net.toFixed(3)),
      averageR: list.length ? Number((net / list.length).toFixed(3)) : null
    };
  };
  const byMonth = {};
  for (const trade of ordered) {
    const month = trade.exitTime.slice(0, 7);
    (byMonth[month] ||= []).push(trade);
  }
  return {
    tradeSequence: group(ordered),
    chronologicalMaxDrawdownR: Number(maxDrawdownR.toFixed(3)),
    longestConsecutiveLosses: longestLossStreak,
    bySide: {
      BUY: group(ordered.filter(x => x.side === "BUY")),
      SELL: group(ordered.filter(x => x.side === "SELL"))
    },
    byExitMonth: Object.fromEntries(Object.entries(byMonth).map(([month, list]) => [month, group(list)]))
  };
}

function monteCarloBootstrap(trades, iterations = 10000) {
  if (trades.length < 30) return { status: "INSUFFICIENT_SAMPLE", sampleSize: trades.length };
  const returns = trades.map(x => x.netR);
  let seed = 0x51A7E;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const drawdowns = [], totals = [];
  for (let run = 0; run < iterations; run++) {
    let equity = 0, peak = 0, dd = 0;
    for (let i = 0; i < returns.length; i++) {
      equity += returns[Math.floor(random() * returns.length)];
      peak = Math.max(peak, equity);
      dd = Math.max(dd, peak - equity);
    }
    totals.push(equity);
    drawdowns.push(dd);
  }
  const percentile = (values, p) => {
    values.sort((a, b) => a - b);
    return Number(values[Math.floor((values.length - 1) * p)].toFixed(2));
  };
  return {
    status: "EXPLORATORY_IID_TRADE_RESAMPLING_NOT_A_FORECAST",
    iterations,
    sampleSize: trades.length,
    terminalNetRPercentiles: {
      p05: percentile(totals, 0.05),
      p50: percentile(totals, 0.50),
      p95: percentile(totals, 0.95)
    },
    maxDrawdownRPercentiles: {
      p50: percentile(drawdowns, 0.50),
      p90: percentile(drawdowns, 0.90),
      p95: percentile(drawdowns, 0.95),
      p99: percentile(drawdowns, 0.99)
    },
    warning: "Trade bağımsızlığı varsayımı gerçek piyasa kümelenmesini modellemez; bu dağılım tahmin veya garanti değildir."
  };
}

const sequenceDiagnostics = {};
for (const slippage of slippageScenarios) {
  const trades = diagnosticTradesBySlippage.get(slippage) || [];
  sequenceDiagnostics[String(slippage)] = {
    ...summarizeTradeSequence(trades),
    monteCarlo: monteCarloBootstrap(trades)
  };
}

const report = {
  report: "QUANT_PRO_EXACT_ENGINE_PUBLIC_DATA_CROSS_CHECK",
  engine: "api/backtest.js current branch implementation",
  provider: "GetData public XAUUSD 1H sample",
  sourceFile: path.basename(file),
  candleCount: candles.length,
  h4CandleCount: h4.length,
  firstCandle: new Date(candles[0].time).toISOString(),
  lastCandle: new Date(candles[candles.length - 1].time).toISOString(),
  dataIsXM: false,
  dataIsTwelveData: false,
  strategyChanged: false,
  costAssumptions: {
    spreadUSD: 0.30,
    slippagePerSideUSD: slippageScenarios,
    commissionIncluded: false,
    brokerCostsVerified: false
  },
  aggregateBySlippage,
  sequenceDiagnostics,
  results
};

const reportJson = JSON.stringify(report, null, 2) + String.fromCharCode(10);
process.stdout.write(reportJson);
if (process.env.REPORT_OUTPUT) fs.writeFileSync(process.env.REPORT_OUTPUT, reportJson, "utf8");

const requiredComplete = results.filter(x =>
  ["MAYIS_HAZIRAN", "TEMMUZ_AGUSTOS"].includes(x.period)
);
if (requiredComplete.length !== 4 || requiredComplete.some(x =>
  x.periodStatus !== "PERIOD_COMPLETE" ||
  x.warmupComplete !== true ||
  x.continuityComplete !== true ||
  !x.metrics
)) {
  process.exitCode = 1;
}
