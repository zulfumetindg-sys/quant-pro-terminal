const test = require("node:test");
const assert = require("node:assert/strict");

const backtest = require("../api/backtest.js").__test;
const live = require("../api/signal-engine.js").__test;
const { measureVolatilityShock } = require("../api/volatility.js");
const journal = require("../api/manual-journal.js").__test;

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

test("volatility shock ratio compares latest H1 range only with preceding 14 bars", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const data = Array.from({ length: 20 }, (_, i) =>
    candle(base + i * 3600000, 100 + i * 0.1, 1)
  );
  const normal = measureVolatilityShock(data, 18);
  assert.equal(normal.available, true);
  assert.equal(normal.baselinePeriod, 14);
  assert.equal(normal.blocking, false);
  assert.ok(normal.ratio > 0);

  const shockData = data.map(x => ({ ...x }));
  shockData[19] = {
    ...shockData[19],
    high: shockData[19].high + 20,
    close: shockData[19].close + 10
  };
  const shock = measureVolatilityShock(shockData, 19);
  assert.equal(shock.available, true);
  assert.ok(shock.ratio > normal.ratio);
  assert.equal(measureVolatilityShock(data.slice(0, 10)).available, false);
});

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
  assert.equal(signal.riskRewardBasis, "GROSS_BEFORE_SPREAD_SLIPPAGE_AND_COMMISSION");
  assert.equal(signal.historicalWinProbability, "UNAVAILABLE");
  assert.equal(signal.executionStatus, "RESEARCH_ONLY_NOT_TRADE_READY");
});

test("live engine rejects missing, future and stale completed H1 candle data", () => {
  const now = Date.UTC(2026, 10, 26, 20, 30, 0);
  const fresh = [candle(now - 2 * 3600000, 2600)];
  const stale = [candle(now - 4 * 3600000, 2600)];
  const future = [candle(now, 2600)];
  assert.equal(live.checkLatestCompletedH1Freshness(fresh, now).fresh, true);
  assert.equal(live.checkLatestCompletedH1Freshness(stale, now).reason, "H1_CANDLES_STALE");
  assert.equal(live.checkLatestCompletedH1Freshness(future, now).reason, "H1_CANDLE_CLOSE_TIME_INVALID");
  assert.equal(live.checkLatestCompletedH1Freshness([], now).reason, "H1_CANDLES_UNAVAILABLE");
  const expired = [candle(now - 3 * 3600000, 2600)];
  assert.equal(live.checkLatestCompletedH1Freshness(expired, now).reason, "H1_CANDLES_STALE");
});

test("default H1 freshness limit is one hour after candle close", () => {
  const now = Date.UTC(2026, 10, 26, 20, 30, 0);
  const withinLimit = [candle(now - 2 * 3600000, 2600)];
  const beyondLimit = [candle(now - 3 * 3600000, 2600)];
  assert.equal(live.checkLatestCompletedH1Freshness(withinLimit, now).fresh, true);
  assert.equal(live.checkLatestCompletedH1Freshness(beyondLimit, now).reason, "H1_CANDLES_STALE");
});

test("live signal identity is stable for one completed H1 setup and changes on the next H1 close", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const data = Array.from({ length: 500 }, (_, i) =>
    candle(base + i * 3600000, 2000 + i * 0.25, 0.8)
  );
  const first = live.createSignal(data, live.aggregateH4(data), data[data.length - 1].close);
  const repeated = live.createSignal(data, live.aggregateH4(data), data[data.length - 1].close + 0.05);

  assert.equal(first.status, "BUY");
  assert.equal(repeated.signalId, first.signalId);
  assert.equal(first.signalCandleClosedAt, new Date(data[data.length - 1].time + 3600000).toISOString());
  assert.equal(first.signalValidUntil, new Date(data[data.length - 1].time + 2 * 3600000).toISOString());

  const next = [
    ...data,
    candle(data[data.length - 1].time + 3600000, data[data.length - 1].close + 0.25, 0.8)
  ];
  const nextSignal = live.createSignal(next, live.aggregateH4(next), next[next.length - 1].close);
  assert.equal(nextSignal.status, "BUY");
  assert.notEqual(nextSignal.signalId, first.signalId);
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
      status: "ok",
      is_market_open: true
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
      status: "ok",
      is_market_open: true
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

test("closed or unverified market status fails closed", async () => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  const now = Date.UTC(2026, 10, 26, 20, 0, 0);
  Date.now = () => now;
  try {
    for (const marketStatus of [false, undefined]) {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({
          close: "2650.25",
          timestamp: String(Math.floor(now / 1000)),
          last_quote_at: String(Math.floor((now - 30000) / 1000)),
          ...(marketStatus === undefined ? {} : { is_market_open: marketStatus }),
          status: "ok"
        })
      });
      await assert.rejects(
        live.getLatestQuote("test-key"),
        /MARKET_CLOSED_OR_STATUS_UNVERIFIED/
      );
    }
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
          status: "ok",
          is_market_open: true
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


test("forward test rejects gaps over 72 hours but permits normal weekend gaps", () => {
  const start = Date.UTC(2026, 10, 2, 0, 0, 0);
  const normal = [
    candle(start, 2600),
    candle(start + 48 * 3600000, 2601),
    candle(start + 49 * 3600000, 2602)
  ];
  const broken = [
    candle(start, 2600),
    candle(start + 73 * 3600000, 2601)
  ];

  assert.equal(backtest.hasForwardContinuity(normal, start), true);
  assert.equal(backtest.hasForwardContinuity(broken, start), false);
  assert.equal(backtest.hasForwardContinuity([], start), false);
});

test("incomplete historical period excludes an open trade instead of force-closing it", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const data = Array.from({ length: 120 }, (_, i) => {
    const price = 2300 + 0.0001 * i * i;
    return { time: base + i * 3600000, open: price, high: price + 0.5, low: price - 0.5, close: price + 0.005 };
  });
  const h4 = backtest.makeH4(data);
  const indicators = backtest.buildIndicators(data);
  const period = { name: "INCOMPLETE_TEST", start: new Date(base + 90 * 3600000).toISOString(), end: new Date(base + 120 * 3600000).toISOString() };
  const result = backtest.runBacktest(data, h4, indicators, 0.1, period);
  assert.equal(result.periodComplete, false);
  assert.equal(result.periodStatus, "PERIOD_STILL_RUNNING");
  assert.equal(result.metrics.tradeCount, 0);
  assert.ok(result.openTrade);
  assert.equal(result.openTrade.open, true);
});

test("completed historical period may close a still-open trade at its final candle", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const data = Array.from({ length: 121 }, (_, i) => {
    const price = 2300 + 0.0001 * i * i;
    return { time: base + i * 3600000, open: price, high: price + 0.5, low: price - 0.5, close: price + 0.005 };
  });
  const h4 = backtest.makeH4(data);
  const indicators = backtest.buildIndicators(data);
  const period = { name: "COMPLETE_TEST", start: new Date(base + 90 * 3600000).toISOString(), end: new Date(base + 120 * 3600000).toISOString() };
  const result = backtest.runBacktest(data, h4, indicators, 0.1, period);
  assert.equal(result.periodComplete, true);
  assert.equal(result.periodStatus, "PERIOD_COMPLETE");
  assert.equal(result.openTrade, null);
  assert.ok(result.metrics.tradeCount >= 1);
});

test("WAIT responses retain volatility shock diagnostics", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const data = Array.from({ length: 80 }, (_, i) =>
    candle(base + i * 3600000, 2300 + i * 0.1, 1)
  );
  const signal = live.createSignal(data, live.aggregateH4(data), null);
  assert.equal(signal.status, "WAIT");
  assert.equal(signal.reason, "LIVE_QUOTE_UNAVAILABLE");
  assert.equal(signal.volatilityShock.available, true);
  assert.equal(signal.volatilityShock.blocking, false);
});

test("volatility outcome buckets report closed-trade performance without creating blocking thresholds", () => {
  const trades = [
    { volatilityShock: { ratio: 0.8 }, netR: 2 },
    { volatilityShock: { ratio: 1.2 }, netR: -1 },
    { volatilityShock: { ratio: 1.8 }, netR: 1 },
    { volatilityShock: { ratio: 2.5 }, netR: -0.5 },
    { volatilityShock: { ratio: 3.2 }, netR: 2 },
    { netR: 5 }
  ];
  const summary = backtest.summarizeVolatilityOutcomes(trades);
  assert.equal(summary.interpretation, "EXPLORATORY_DESCRIPTIVE_BINS_NOT_VALIDATED_FILTERS");
  assert.deepEqual(summary.buckets.map(x => x.sampleCount), [1, 1, 1, 1, 1]);
  assert.equal(summary.buckets[0].metrics.winRatePercent, 100);
  assert.equal(summary.buckets[1].metrics.winRatePercent, 0);
  assert.equal(summary.buckets[3].metrics.netProfitR, -0.5);
});

test("manual journal requires a strong exact bearer token and compares it safely", () => {
  const token = "a".repeat(40);
  assert.equal(journal.safeEqual(token, token), true);
  assert.equal(journal.safeEqual(token, "b".repeat(40)), false);
  assert.equal(journal.safeEqual(token, "short"), false);
  assert.equal(journal.safeEqual(null, token), false);
});

test("manual journal accepts only fresh XAUUSD BUY or SELL signals with at least 1.8R at actual fill", () => {
  const now = Date.UTC(2026, 10, 26, 22, 0, 0);
  const candleClosedAt = now - 30 * 60000;
  const signal = {
    symbol: "XAUUSD",
    status: "BUY",
    signalId: "XAUUSD:BUY:" + candleClosedAt,
    signalCandleClosedAt: new Date(candleClosedAt).toISOString(),
    signalValidUntil: new Date(candleClosedAt + 3600000).toISOString(),
    entry: 2650,
    sl: 2640,
    tp: 2670
  };
  const valid = journal.validateOpenPayload({ signal, fillPrice: 2650 }, now);
  assert.equal(valid.ok, true);
  assert.equal(valid.trade.actualFillRiskReward, 2);
  assert.equal(valid.trade.actualFillDistancePercent, 0);
  assert.equal(valid.trade.status, "OPEN");
  assert.equal(valid.trade.costs, "NOT_INCLUDED");

  assert.equal(journal.validateOpenPayload({ signal: { ...signal, symbol: "EURUSD" }, fillPrice: 2650 }, now).error, "XAUUSD_ONLY");
  assert.equal(journal.validateOpenPayload({ signal: { ...signal, status: "WAIT" }, fillPrice: 2650 }, now).error, "LIVE_BUY_OR_SELL_REQUIRED");
  const expiredClose = now - 3600001;
  assert.equal(journal.validateOpenPayload({ signal: { ...signal, signalId: "XAUUSD:BUY:" + expiredClose, signalCandleClosedAt: new Date(expiredClose).toISOString(), signalValidUntil: new Date(expiredClose + 3600000).toISOString() }, fillPrice: 2650 }, now).error, "SIGNAL_EXPIRED_OR_INVALID");
  assert.equal(journal.validateOpenPayload({ signal, fillPrice: 2653 }, now).error, "ACTUAL_FILL_TOO_FAR_FROM_SIGNAL");
  assert.equal(journal.validateOpenPayload({ signal, fillPrice: 2659 }, now).error, "ACTUAL_FILL_RR_BELOW_1_8");
});

test("manual journal validates close prices and calculates realized R from actual fill", () => {
  const now = Date.UTC(2026, 10, 26, 22, 0, 0);
  assert.equal(journal.validateClosePayload({ tradeId: "bad", exitPrice: 2660 }, now).error, "TRADE_ID_INVALID");
  assert.equal(journal.validateClosePayload({ tradeId: "11111111-1111-4111-8111-111111111111", exitPrice: -1 }, now).error, "EXIT_PRICE_INVALID");
  const trade = { side: "BUY", fillPrice: 2650, stopLoss: 2640 };
  assert.equal(journal.calculateRealizedR(trade, 2670), 2);
  assert.equal(journal.calculateRealizedR({ ...trade, side: "SELL" }, 2640), 1);
});

test("manual journal state parser rejects corrupted state and initializes empty state", () => {
  assert.deepEqual(journal.parseRedisState(null), { trades: [], activeTradeId: "" });
  assert.deepEqual(journal.parseRedisState({ trades: [], activeTradeId: "" }), { trades: [], activeTradeId: "" });
  assert.throws(() => journal.parseRedisState("{broken"));
  assert.throws(() => journal.parseRedisState({ trades: {} , activeTradeId: "" }));
});
