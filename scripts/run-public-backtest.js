"use strict";

const fs = require("node:fs");
const path = require("node:path");
const engine = require("../api/backtest").__test;

const file = process.argv[2] || "/tmp/XAUUSD_1h.csv";
if (!fs.existsSync(file)) {
  throw new Error("PUBLIC_XAUUSD_CSV_NOT_FOUND: " + file);
}

const raw = fs.readFileSync(file, "utf8").replace(/^\\uFEFF/, "").trim();
const lines = raw.split(/\\r?\\n/);
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
    slippagePerSideUSD: [0.10, 0.20],
    commissionIncluded: false,
    brokerCostsVerified: false
  },
  results
};

process.stdout.write(JSON.stringify(report, null, 2) + "\\n");

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
