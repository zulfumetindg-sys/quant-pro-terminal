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

const results = [];
for (const slippage of [0.10, 0.20]) {
  for (const period of periods) {
    const result = engine.runBacktest(candles, h4, indicators, slippage, period);
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


const aggregateBySlippage = [0.10, 0.20].map(slippage => {
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
\nconst report = {
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
    slippagePerSideUSD: [0.10, 0.20],
    commissionIncluded: false,
    brokerCostsVerified: false
  },
  results
};

process.stdout.write(JSON.stringify(report, null, 2) + String.fromCharCode(10));

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
