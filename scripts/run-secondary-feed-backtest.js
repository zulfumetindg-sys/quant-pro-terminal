"use strict";

const fs = require("node:fs");
const engine = require("../api/backtest").__test;
const file = process.argv[2] || "/tmp/sepaul_xauusd_h1.csv";
if (!fs.existsSync(file)) throw new Error("SECONDARY_XAUUSD_CSV_NOT_FOUND");

let raw = fs.readFileSync(file, "utf8");
if (raw.charCodeAt(0) === 65279) raw = raw.slice(1);
const lines = raw.trim().split(/\r?\n/);
const headers = lines.shift().split(",").map(x => x.trim().toLowerCase());
const required = ["time", "open", "high", "low", "close", "spread"];
for (const key of required) if (!headers.includes(key)) throw new Error("CSV_MISSING_COLUMN:" + key);
const rows = lines.map(line => {
  const cells = line.split(",");
  const row = {};
  headers.forEach((key, i) => { row[key] = (cells[i] || "").trim(); });
  row.datetime = row.time.replace(" ", "T") + "Z";
  return row;
});
const candles = engine.normalizeHistoricalCandles(rows, Date.now());
if (candles.length < 5000) throw new Error("SECONDARY_DATA_TOO_SMALL");

const longGaps = [];
for (let i = 1; i < candles.length; i++) {
  const hours = (candles[i].time - candles[i - 1].time) / 3600000;
  if (hours > 72) longGaps.push({ beforeIndex: i - 1, afterIndex: i, hours });
}

// Split at every >72h closure. Start scoring only after 420 contiguous H1 bars
// so the engine can independently satisfy its 400-H1 / 100-H4 warmup.
const blocks = [];
let blockStart = 0;
for (const gap of longGaps) {
  blocks.push({ start: blockStart, end: gap.beforeIndex });
  blockStart = gap.afterIndex;
}
blocks.push({ start: blockStart, end: candles.length - 1 });

const periods = [];
for (let n = 0; n < blocks.length; n++) {
  const block = blocks[n];
  const scoreStart = block.start + 600;
  if (block.end - scoreStart < 500) continue;
  periods.push({
    name: "SEGMENT_" + String(periods.length + 1).padStart(2, "0"),
    start: new Date(candles[scoreStart].time).toISOString(),
    end: new Date(candles[block.end].time).toISOString(),
    firstBar: new Date(candles[scoreStart].time).toISOString(),
    lastBar: new Date(candles[block.end - 1].time).toISOString(),
    bars: block.end - scoreStart
  });
}
if (periods.length < 4) throw new Error("TOO_FEW_CONTIGUOUS_TEST_SEGMENTS");

const h4 = engine.makeH4(candles);
const indicators = engine.buildIndicators(candles);
const slippageScenarios = [0.10, 0.20, 0.30, 0.50];

function summarize(trades) {
  const ordered = [...trades].sort((a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime));
  let equity = 0, peak = 0, maxDD = 0, peakTime = ordered.length ? "START_OF_TEST" : null;
  let maxDDStart = null, maxDDEnd = null;
  let streak = 0, longest = 0, streakStart = null;
  let longestStreakStart = null, longestStreakEnd = null;
  // Illustrative fixed-fraction account path: risk 0.5% of current equity per trade.
  // This is a mathematical translation of R, not a broker-specific fill simulation.
  let equityMultiplier = 1, equityPeak = 1, maxEquityDrawdownPercent = 0;
  for (const t of ordered) {
    equity += t.netR;
    equityMultiplier *= Math.max(0, 1 + 0.005 * t.netR);
    equityPeak = Math.max(equityPeak, equityMultiplier);
    if (equityPeak > 0) {
      maxEquityDrawdownPercent = Math.max(
        maxEquityDrawdownPercent,
        (equityPeak - equityMultiplier) / equityPeak * 100
      );
    }
    if (equity > peak) {
      peak = equity;
      peakTime = t.exitTime;
    }
    const dd = peak - equity;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDStart = peakTime;
      maxDDEnd = t.exitTime;
    }
    if (t.netR < 0) {
      if (streak === 0) streakStart = t.exitTime;
      streak++;
      if (streak > longest) {
        longest = streak;
        longestStreakStart = streakStart;
        longestStreakEnd = t.exitTime;
      }
    } else if (t.netR > 0) {
      streak = 0;
      streakStart = null;
    }
  }
  function blockBootstrap(values, simulations = 2000, blockSize = 10) {
    if (values.length < blockSize * 5) return { status: "INSUFFICIENT_SAMPLE" };
    // Fixed-seed circular moving-block bootstrap preserves short-range sequencing.
    let seed = 0x51a7c0de;
    const random = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
    const finalR = [], maxDrawdowns = [];
    for (let sim = 0; sim < simulations; sim++) {
      let equityPath = 0, peakPath = 0, maxDDPath = 0, count = 0;
      while (count < values.length) {
        const start = Math.floor(random() * values.length);
        for (let k = 0; k < blockSize && count < values.length; k++, count++) {
          equityPath += values[(start + k) % values.length];
          peakPath = Math.max(peakPath, equityPath);
          maxDDPath = Math.max(maxDDPath, peakPath - equityPath);
        }
      }
      finalR.push(equityPath);
      maxDrawdowns.push(maxDDPath);
    }
    const quantile = (array, p) => {
      array.sort((a, b) => a - b);
      return +array[Math.min(array.length - 1, Math.floor((array.length - 1) * p))].toFixed(2);
    };
    return {
      status: "HISTORICAL_BLOCK_BOOTSTRAP_NOT_A_FORECAST",
      simulations, blockSizeTrades: blockSize,
      probabilityOfNegativeNetRPercent: +(finalR.filter(x => x < 0).length / simulations * 100).toFixed(2),
      finalNetRPercentiles: { p05: quantile(finalR, 0.05), p50: quantile(finalR, 0.50), p95: quantile(finalR, 0.95) },
      maxDrawdownRPercentiles: { p50: quantile(maxDrawdowns, 0.50), p95: quantile(maxDrawdowns, 0.95) }
    };
  }
  const group = list => {
    const wins = list.filter(t => t.netR > 0).length;
    const losses = list.filter(t => t.netR < 0).length;
    const gw = list.filter(t => t.netR > 0).reduce((a, t) => a + t.netR, 0);
    const gl = Math.abs(list.filter(t => t.netR < 0).reduce((a, t) => a + t.netR, 0));
    const net = list.reduce((a, t) => a + t.netR, 0);
    const n = list.length;
    const z = 1.96;
    const p = n ? wins / n : null;
    const denominator = n ? 1 + z * z / n : null;
    const center = n ? (p + z * z / (2 * n)) / denominator : null;
    const margin = n ? z * Math.sqrt((p * (1 - p) / n) + (z * z / (4 * n * n))) / denominator : null;
    return {
      trades: n, wins, losses,
      winRatePercent: n ? +(p * 100).toFixed(2) : null,
      winRateWilson95Percent: n ? [
        +((center - margin) * 100).toFixed(2),
        +((center + margin) * 100).toFixed(2)
      ] : null,
      profitFactor: gl ? +(gw / gl).toFixed(3) : null,
      netR: +net.toFixed(3),
      averageR: n ? +(net / n).toFixed(3) : null
    };
  };
  const byMonth = {}, byYear = {}, byQuarter = {}, byHourUTC = {}, byEntryHourUTC = {}, byEntryHourUTCAndSide = {};
  for (const t of ordered) {
    const entryDate = new Date(t.signalTime);
    const entryHour = String(entryDate.getUTCHours()).padStart(2, "0") + ":00";
    (byEntryHourUTC[entryHour] ||= []).push(t);
    const entryHourSide = entryHour + "_" + t.side;
    (byEntryHourUTCAndSide[entryHourSide] ||= []).push(t);
    const date = new Date(t.exitTime);
    const year = String(date.getUTCFullYear());
    const month = t.exitTime.slice(0, 7);
    const quarter = year + "-Q" + (Math.floor(date.getUTCMonth() / 3) + 1);
    const hour = String(date.getUTCHours()).padStart(2, "0") + ":00";
    (byMonth[month] ||= []).push(t);
    (byYear[year] ||= []).push(t);
    (byQuarter[quarter] ||= []).push(t);
    (byHourUTC[hour] ||= []).push(t);
  }
  const summarizeMap = map => Object.fromEntries(
    Object.entries(map).map(([key, list]) => [key, group(list)])
  );
  const volatilityBuckets = [
    { label: "LT_1_0", min: 0, max: 1 },
    { label: "1_0_TO_1_5", min: 1, max: 1.5 },
    { label: "1_5_TO_2_0", min: 1.5, max: 2 },
    { label: "2_0_TO_3_0", min: 2, max: 3 },
    { label: "GTE_3_0", min: 3, max: Infinity }
  ];
  const byVolatilityRegime = Object.fromEntries(volatilityBuckets.map(bucket => {
    const matched = ordered.filter(t => {
      const ratio = t?.volatilityShock?.ratio;
      return Number.isFinite(ratio) && ratio >= bucket.min && ratio < bucket.max;
    });
    return [bucket.label, {
      ...group(matched),
      BUY: group(matched.filter(t => t.side === "BUY")),
      SELL: group(matched.filter(t => t.side === "SELL"))
    }];
  }));
  const byEntryYearAndVolatilityRegime = {};
  for (const trade of ordered) {
    const ratio = trade?.volatilityShock?.ratio;
    if (!Number.isFinite(ratio)) continue;
    const bucket = volatilityBuckets.find(x => ratio >= x.min && ratio < x.max);
    if (!bucket) continue;
    const year = new Date(trade.signalTime).getUTCFullYear();
    const key = `${year}_${bucket.label}`;
    (byEntryYearAndVolatilityRegime[key] ||= []).push(trade);
  }
  const byEntryYearAndVolatilityRegimeSummary = Object.fromEntries(
    Object.entries(byEntryYearAndVolatilityRegime).map(([key, list]) => [key, {
      ...group(list),
      BUY: group(list.filter(t => t.side === "BUY")),
      SELL: group(list.filter(t => t.side === "SELL"))
    }])
  );
  return {
    overall: group(ordered),
    historicalBlockBootstrap: blockBootstrap(ordered.map(t => t.netR)),
    chronologicalMaxDrawdownR: +maxDD.toFixed(3),
    illustrativeRiskModel: {
      riskPercentOfCurrentEquityPerTrade: 0.5,
      finalEquityMultiplier: +equityMultiplier.toFixed(4),
      totalReturnPercent: +((equityMultiplier - 1) * 100).toFixed(2),
      maxPeakToTroughDrawdownPercent: +maxEquityDrawdownPercent.toFixed(2),
      assumption: "Sequential trades; fixed 0.5% fractional risk per trade; each netR applied to current equity; excludes broker-specific lot rounding, margin, financing and execution constraints."
    },
    maxDrawdownPeakTime: maxDDStart,
    maxDrawdownTroughTime: maxDDEnd,
    longestConsecutiveLosses: longest,
    longestLosingStreakStart: longestStreakStart,
    longestLosingStreakEnd: longestStreakEnd,
    BUY: group(ordered.filter(t => t.side === "BUY")),
    SELL: group(ordered.filter(t => t.side === "SELL")),
    byExitYear: summarizeMap(byYear),
    byExitQuarter: summarizeMap(byQuarter),
    byExitMonth: summarizeMap(byMonth),
    byExitHourUTC: summarizeMap(byHourUTC),
    byEntryHourUTC: summarizeMap(byEntryHourUTC),
    byEntryHourUTCAndSide: summarizeMap(byEntryHourUTCAndSide),
    byVolatilityRegime,
    byEntryYearAndVolatilityRegime: byEntryYearAndVolatilityRegimeSummary,
    volatilityRegimeInterpretation: "EXPLORATORY_DESCRIPTIVE_BINS_NOT_VALIDATED_FILTERS";
  };
}

const reports = [];
for (const slippage of slippageScenarios) {
  const trades = [];
  const segmentResults = [];
  for (const period of periods) {
    const result = engine.runBacktest(candles, h4, indicators, slippage, period, Date.now(), { includeTrades: true });
    segmentResults.push({
      period: period.name, start: period.start, end: period.end,
      bars: period.bars, status: result.periodStatus,
      continuityComplete: result.continuityComplete ?? null,
      warmupComplete: result.warmupComplete,
      metrics: result.metrics,
      warning: result.warning || null
    });
    if (result.periodStatus === "PERIOD_COMPLETE" && Array.isArray(result.closedTrades)) {
      trades.push(...result.closedTrades.map(t => ({ ...t, segment: period.name })));
    }
  }
  reports.push({
    slippagePerSideUSD: slippage,
    fixedFullSpreadUSD: 0.30,
    commissionIncluded: false,
    brokerCostsVerified: false,
    diagnostics: summarize(trades),
    segments: segmentResults
  });
}
const spreadValues = rows.map(r => Number(r.spread)).filter(Number.isFinite).sort((a, b) => a - b);
const percentile = p => spreadValues[Math.floor((spreadValues.length - 1) * p)];
const report = {
  report: "QUANT_PRO_LONG_HISTORY_SECONDARY_FEED_CROSS_CHECK",
  engine: "api/backtest.js current branch implementation; strategy unchanged",
  provider: "Sepaul Research public XAUUSD H1 raw-spread OTC dataset",
  feedIsXM: false,
  feedIsTwelveData: false,
  candleCount: candles.length,
  h4CandleCount: h4.length,
  firstCandle: new Date(candles[0].time).toISOString(),
  lastCandle: new Date(candles[candles.length - 1].time).toISOString(),
  dataQuality: {
    invalidOHLCRowsExcludedByNormalizer: rows.length - candles.length,
    longGapsOver72Hours: longGaps,
    spreadPoints: {
      zeroPercent: +(spreadValues.filter(x => x === 0).length / spreadValues.length * 100).toFixed(2),
      median: percentile(0.50), p90: percentile(0.90),
      p95: percentile(0.95), p99: percentile(0.99), max: percentile(1)
    }
  },
  methodology: {
    splitAtGapsOver72Hours: true,
    postGapWarmupBars: 600,
    minimumScoredBarsPerSegment: 500,
    fixedFullSpreadUSD: 0.30,
    slippagePerSideUSD: slippageScenarios,
    rawFeedSpreadColumnUsedInExecution: false,
    rawSpreadReason: "Feed spread is recorded in provider points; its executable USD conversion and broker mapping have not been independently verified. Fixed-spread stress model is used instead.",
    commissionIncluded: false,
    noStrategyOptimization: true
  },
  testedSegmentCount: periods.length,
  reports
};
const json = JSON.stringify(report, null, 2) + "\n";
process.stdout.write(json);
if (process.env.REPORT_OUTPUT) fs.writeFileSync(process.env.REPORT_OUTPUT, json, "utf8");
if (reports.some(r => r.diagnostics.overall.trades < 100 || r.segments.some(s => s.status !== "PERIOD_COMPLETE" || s.warmupComplete !== true || s.continuityComplete !== true))) {
  process.exitCode = 1;
}
