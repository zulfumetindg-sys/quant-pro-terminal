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

test("live signal and historical engine agree on identical completed H1/H4 data and entry quote", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const data = Array.from({ length: 500 }, (_, i) =>
    candle(base + i * 3600000, 2300 + i * 0.08 + 5 * Math.sin(i / 11), 1)
  );

  // The signal is confirmed at H1 candle 495 close; candle 496 open
  // is the common reproducible entry-price reference for both engines.
  const signalIndex = 495;
  const liveHistory = data.slice(0, signalIndex + 1);
  const liveH4 = live.aggregateH4(liveHistory);
  const indicators = backtest.buildIndicators(data);
  const h4 = backtest.makeH4(data);
  const signalCloseTime = data[signalIndex].time + 3600000;
  const h4Index = h4.findIndex(x => x.end === signalCloseTime);
  const quote = data[signalIndex + 1].open;

  assert.ok(h4Index >= 19);
  const liveSignal = live.createSignal(liveHistory, liveH4, quote);
  const historicalSignal = backtest.getSignal(
    data, h4, indicators, signalIndex, h4Index
  );

  assert.equal(
    liveSignal.status,
    historicalSignal ? historicalSignal.side : "WAIT"
  );
  if (historicalSignal) {
    assert.equal(liveSignal.entry, quote);
    assert.equal(liveSignal.riskReward, "1:2.0");
    assert.ok(Math.abs(liveSignal.atr - historicalSignal.atr) < 1e-9);
  } else {
    assert.equal(liveSignal.status, "WAIT");
  }
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


test("missing or stale quote timestamp fails closed and cannot create a trade signal", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const data = Array.from({ length: 500 }, (_, i) =>
    candle(base + i * 3600000, 2000 + i * 0.25, 0.8)
  );
  const h4 = live.aggregateH4(data);
  const signal = live.createSignal(data, h4, null);
  assert.equal(signal.status, "WAIT");
  assert.equal(signal.reason, "LIVE_QUOTE_UNAVAILABLE");
  assert.equal(signal.sl, undefined);
  assert.equal(signal.tp, undefined);
});

test("live signal rejects a provider quote more than 0.10 percent from the completed H1 close", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const data = Array.from({ length: 500 }, (_, i) =>
    candle(base + i * 3600000, 2000 + i * 0.25, 0.8)
  );
  const h4 = live.aggregateH4(data);
  const distantQuote = data[data.length - 1].close * 1.01;
  const signal = live.createSignal(data, h4, distantQuote);
  assert.equal(signal.status, "WAIT");
  assert.equal(signal.reason, "ENTRY_TOO_FAR_FROM_PRICE");
  assert.equal(signal.sl, undefined);
  assert.equal(signal.tp, undefined);
});


test("quote freshness requires last_quote_at and never falls back to interval timestamp", async () => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  const now = Date.UTC(2026, 10, 26, 20, 0, 0);
  Date.now = () => now;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      close: "2650.25",
      timestamp: String(Math.floor(now / 1000)),
      status: "ok"
    })
  });
  try {
    await assert.rejects(
      live.getLatestQuote("test-key"),
      /QUOTE_TIMESTAMP_UNAVAILABLE/
    );
  } finally {
    global.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("fresh last_quote_at is accepted even when interval timestamp is old", async () => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  const now = Date.UTC(2026, 10, 26, 20, 0, 0);
  Date.now = () => now;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      close: "2650.25",
      timestamp: String(Math.floor((now - 3600000) / 1000)),
      last_quote_at: String(Math.floor((now - 30000) / 1000)),
      status: "ok"
    })
  });
  try {
    const quote = await live.getLatestQuote("test-key");
    assert.equal(quote.status, "ok");
    assert.equal(quote.price, 2650.25);
    assert.equal(quote.ageSeconds, 30);
  } finally {
    global.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("stale and future last_quote_at values are rejected", async () => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  const now = Date.UTC(2026, 10, 26, 20, 0, 0);
  Date.now = () => now;
  try {
    for (const timestamp of [
      String(Math.floor((now - 181000) / 1000)),
      String(Math.floor((now + 1000) / 1000))
    ]) {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({
          close: "2650.25",
          timestamp: String(Math.floor(now / 1000)),
          last_quote_at: timestamp,
          status: "ok"
        })
      });
      await assert.rejects(
        live.getLatestQuote("test-key"),
        /QUOTE_STALE_OR_FUTURE/
      );
    }
  } finally {
    global.fetch = originalFetch;
    Date.now = originalNow;
  }
});


test("forward test requires 400 H1 and 100 completed H4 warmup candles", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const start = base + 400 * 3600000;
  const history = Array.from({ length: 400 }, (_, i) =>
    candle(base + i * 3600000, 2300 + i * 0.05, 1)
  );

  assert.equal(backtest.hasForwardWarmup(history, start), true);
  assert.equal(backtest.hasForwardWarmup(history.slice(1), start), false);
  assert.equal(backtest.hasForwardWarmup(history, start + 100 * 3600000), false);
  assert.equal(backtest.hasForwardWarmup([], start), false);
});
