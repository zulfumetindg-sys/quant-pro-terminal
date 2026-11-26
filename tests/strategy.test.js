const test = require("node:test");
const assert = require("node:assert/strict");

const backtest = require("../api/backtest.js").__test;
const live = require("../api/signal-engine.js").__test;

function candle(time, price, range = 1) {
  return {
    time,
    datetime: new Date(time).toISOString(),
    open: price,
    high: price + range,
    low: price - range,
    close: price + 0.2
  };
}

test("H4 aggregation accepts only four contiguous completed H1 candles", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const complete = Array.from({ length: 4 }, (_, i) => candle(base + i * 3600000, 100 + i));
  const missing = complete.filter((_, i) => i !== 2);
  assert.equal(backtest.makeH4(complete).length, 1);
  assert.equal(backtest.makeH4(missing).length, 0);
});

test("live candle normalization removes duplicates, incomplete bars and invalid OHLC", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const valid = candle(base, 100);
  const duplicate = { ...candle(base, 101), close: 101.2 };
  const invalid = { ...candle(base + 3600000, 100), high: 90 };
  const future = candle(Date.now() + 3600000, 100);
  const normalized = live.normalizeCandles([valid, duplicate, invalid, future]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].open, duplicate.open);
});

test("indicator values at time t are invariant to all candles after t", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const data = Array.from({ length: 260 }, (_, i) =>
    candle(base + i * 3600000, 2300 + i * 0.13 + 7 * Math.sin(i / 8), 1.5)
  );
  const cut = 170;
  const original = backtest.buildIndicators(data);
  const altered = data.map((item, i) => i <= cut ? item : {
    ...item,
    open: item.open + 500,
    high: item.high + 500,
    low: item.low + 500,
    close: item.close + 500
  });
  const changed = backtest.buildIndicators(altered);
  for (const key of ["e20", "e50", "histogram", "atr"]) {
    assert.deepEqual(changed[key].slice(0, cut + 1), original[key].slice(0, cut + 1));
  }
});

test("same-bar stop and target collision is resolved conservatively as stop loss", () => {
  const data = [
    candle(0, 100, 1),
    { time: 3600000, open: 100, high: 104, low: 98, close: 100 }
  ];
  const trade = backtest.calculateTrade(
    data, 0, { side: "BUY", atr: 1 }, 0.1, 1, false
  );
  assert.equal(trade.exitReason, "STOP_LOSS");
  assert.ok(trade.netR < 0);
});

test("stop gaps fill at the worse opening price instead of the stop level", () => {
  const data = [
    candle(0, 100, 1),
    { time: 3600000, open: 100, high: 101, low: 99, close: 100 },
    { time: 7200000, open: 95, high: 96, low: 94, close: 95 }
  ];
  const trade = backtest.calculateTrade(
    data, 0, { side: "BUY", atr: 1 }, 0.1, 2, false
  );
  assert.equal(trade.exitReason, "STOP_LOSS");
  assert.ok(trade.exit < trade.stopLoss);
  assert.ok(trade.netR < -1);
});

test("metrics calculate win rate, profit factor, net R and drawdown deterministically", () => {
  const metrics = backtest.getMetrics([
    { netR: 2 }, { netR: -1 }, { netR: 1 }
  ]);
  assert.equal(metrics.tradeCount, 3);
  assert.equal(metrics.winRatePercent, 66.67);
  assert.equal(metrics.profitFactor, 3);
  assert.equal(metrics.netProfitR, 2);
  assert.equal(metrics.maxDrawdownR, 1);
  assert.equal(metrics.insufficientSample, true);
});

test("live signal entry and risk levels are based on the current provider quote estimate", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const data = Array.from({ length: 500 }, (_, i) =>
    candle(base + i * 3600000, 2000 + i * 0.25, 0.8)
  );
  const h4 = live.aggregateH4(data);
  const quote = data[data.length - 1].close + 0.1;
  const signal = live.createSignal(data, h4, quote);

  assert.equal(signal.status, "BUY");
  assert.equal(signal.entryReference, "LATEST_PROVIDER_PRICE_ESTIMATE");
  assert.equal(signal.entry, quote);
  assert.ok(signal.sl < quote);
  assert.ok(signal.tp > quote);
  assert.equal(signal.riskReward, "1:2.0");
  assert.equal(signal.historicalWinProbability, "UNAVAILABLE");
  assert.equal(signal.executionStatus, "RESEARCH_ONLY_NOT_TRADE_READY");
});

test("live and backtest H4 aggregation agree on identical candle history", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const data = Array.from({ length: 400 }, (_, i) =>
    candle(base + i * 3600000, 2300 + i * 0.08 + 5 * Math.sin(i / 11), 1)
  );
  const liveH4 = live.aggregateH4(data).map(x => [x.time, x.open, x.high, x.low, x.close]);
  const testH4 = backtest.makeH4(data).map(x => [x.time, x.open, x.high, x.low, x.close]);
  assert.deepEqual(liveH4, testH4);
});
