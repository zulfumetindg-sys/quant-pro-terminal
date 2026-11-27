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

test("live engine requires recent H1/H4 history continuity and a current completed H4 bar", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const data = Array.from({ length: 520 }, (_, i) =>
    candle(base + i * 3600000, 2300 + i * 0.05 + 2 * Math.sin(i / 9), 1)
  );
  const h4 = live.aggregateH4(data);
  assert.equal(live.checkRecentMarketDataContinuity(data, h4).continuous, true);

  const gapData = data.filter((_, i) => i < 420 || i >= 500);
  const gap = live.checkRecentMarketDataContinuity(gapData, live.aggregateH4(gapData));
  assert.equal(gap.continuous, false);
  assert.equal(gap.reason, "H1_GAP_OVER_72H");

  const insufficient = live.checkRecentMarketDataContinuity(data.slice(-399), h4.slice(-99));
  assert.equal(insufficient.continuous, false);
  assert.equal(insufficient.reason, "H1_HISTORY_INSUFFICIENT");
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


test("forward trade integrity rejects pre-start, duplicate and invalid closed trades", () => {
  const start = Date.UTC(2026, 10, 26, 20, 0, 0);
  const trade = {
    side: "BUY",
    signalTime: new Date(start + 3600000).toISOString(),
    exitTime: new Date(start + 7200000).toISOString(),
    entry: 100, stopLoss: 99, takeProfit: 102, exit: 102, netR: 2
  };
  assert.equal(backtest.validateForwardTradeSequence([trade], null, start, start + 7200000).valid, true);
  assert.equal(backtest.validateForwardTradeSequence([trade, trade], null, start, start + 7200000).reason, "DUPLICATE_SIGNAL_TIME");
  const beforeStart = { ...trade, signalTime: new Date(start).toISOString() };
  assert.equal(backtest.validateForwardTradeSequence([beforeStart], null, start, start + 7200000).reason, "TRADE_NOT_STRICTLY_AFTER_FORWARD_START");
  const open = { ...trade, open: true, status: "OPEN_NOT_COUNTED" };
  assert.equal(backtest.validateForwardTradeSequence([], open, start, start + 7200000).openTradeExcluded, true);
  assert.equal(backtest.validateForwardTradeSequence([trade], open, start, start + 7200000).reason, "INVALID_OR_DUPLICATE_OPEN_TRADE");
});

test("forward test excludes the pinned start candle and all earlier signal closes", () => {
  const start = Date.UTC(2026, 10, 26, 20, 0, 0);
  assert.equal(backtest.isForwardSignalTime(start - 1), false);
  assert.equal(backtest.isForwardSignalTime(start), false);
  assert.equal(backtest.isForwardSignalTime(start + 1), true);
  assert.equal(backtest.isForwardSignalTime(Number.NaN), false);
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

  assert.equal(backtest.hasForwardContinuity(normal, start, start + 50 * 3600000), true);
  assert.equal(backtest.hasForwardContinuity(broken, start, start + 74 * 3600000), false);
  assert.equal(backtest.hasForwardContinuity([], start, start + 50 * 3600000), false);
  assert.equal(backtest.hasForwardContinuity(normal, start, start + 130 * 3600000), false);
});

test("incomplete historical period excludes an open trade instead of force-closing it", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const data = Array.from({ length: 430 }, (_, i) => {
    const price = 2300 + 0.0001 * i * i;
    return { time: base + i * 3600000, open: price, high: price + 0.5, low: price - 0.5, close: price + 0.005 };
  });
  const h4 = backtest.makeH4(data);
  const indicators = backtest.buildIndicators(data);
  const period = { name: "INCOMPLETE_TEST", start: new Date(base + 400 * 3600000).toISOString(), end: new Date(base + 430 * 3600000).toISOString() };
  const result = backtest.runBacktest(data, h4, indicators, 0.1, period, base + 430 * 3600000);
  assert.equal(result.periodComplete, false);
  assert.equal(result.periodStatus, "PERIOD_STILL_RUNNING");
  assert.equal(result.metrics.tradeCount, 0);
  assert.ok(result.openTrade);
  assert.equal(result.openTrade.open, true);
});

test("completed historical period may close a still-open trade at its final candle", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const data = Array.from({ length: 431 }, (_, i) => {
    const price = 2300 + 0.0001 * i * i;
    return { time: base + i * 3600000, open: price, high: price + 0.5, low: price - 0.5, close: price + 0.005 };
  });
  const h4 = backtest.makeH4(data);
  const indicators = backtest.buildIndicators(data);
  const period = { name: "COMPLETE_TEST", start: new Date(base + 400 * 3600000).toISOString(), end: new Date(base + 430 * 3600000).toISOString() };
  const result = backtest.runBacktest(data, h4, indicators, 0.1, period, base + 431 * 3600000);
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

  const sellSignal = {
    ...signal,
    status: "SELL",
    signalId: "XAUUSD:SELL:" + candleClosedAt,
    sl: 2660,
    tp: 2630
  };
  assert.equal(journal.validateOpenPayload({ signal: sellSignal, fillPrice: 2650 }, now).ok, true);

  assert.equal(journal.validateOpenPayload({ signal: { ...signal, symbol: "EURUSD" }, fillPrice: 2650 }, now).error, "XAUUSD_ONLY");
  assert.equal(journal.validateOpenPayload({ signal: { ...signal, status: "WAIT" }, fillPrice: 2650 }, now).error, "LIVE_BUY_OR_SELL_REQUIRED");
  const expiredClose = now - 3600001;
  assert.equal(journal.validateOpenPayload({ signal: { ...signal, signalId: "XAUUSD:BUY:" + expiredClose, signalCandleClosedAt: new Date(expiredClose).toISOString(), signalValidUntil: new Date(expiredClose + 3600000).toISOString() }, fillPrice: 2650 }, now).error, "SIGNAL_EXPIRED_OR_INVALID");
  assert.equal(journal.validateOpenPayload({ signal, fillPrice: 2653 }, now).error, "ACTUAL_FILL_TOO_FAR_FROM_SIGNAL");
  assert.equal(journal.validateOpenPayload({ signal, fillPrice: 2651 }, now).error, "ACTUAL_FILL_RR_BELOW_1_8");
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

test("manual journal Redis mutation arguments preserve atomic Lua parameter positions", () => {
  const openArgs = journal.buildMutationArguments("open", ['{"tradeId":"t"}']);
  assert.deepEqual(openArgs, ["open", '{"tradeId":"t"}', "", "", "500"]);
  const closeArgs = journal.buildMutationArguments("close", ["2660", "2026-11-26T22:00:00.000Z", "11111111-1111-4111-8111-111111111111"]);
  assert.deepEqual(closeArgs, ["close", "2660", "2026-11-26T22:00:00.000Z", "11111111-1111-4111-8111-111111111111", "500"]);
  assert.throws(() => journal.buildMutationArguments("delete", []), /ACTION_INVALID/);
});

test("manual journal API fails closed without authentication or Redis configuration", async () => {
  const handler = require("../api/manual-journal.js");
  const response = () => ({
    code: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  });

  const originalAccess = process.env.JOURNAL_ACCESS_TOKEN;
  const originalUrl = process.env.KV_REST_API_URL;
  const originalRedisToken = process.env.KV_REST_API_TOKEN;
  try {
    delete process.env.JOURNAL_ACCESS_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    const unauthorized = response();
    await handler({ method: "GET", headers: {} }, unauthorized);
    assert.equal(unauthorized.code, 401);
    assert.equal(unauthorized.body.error, "UNAUTHORIZED");

    process.env.JOURNAL_ACCESS_TOKEN = "x".repeat(64);
    const notConfigured = response();
    await handler({ method: "GET", headers: { authorization: "Bearer " + process.env.JOURNAL_ACCESS_TOKEN } }, notConfigured);
    assert.equal(notConfigured.code, 503);
    assert.equal(notConfigured.body.error, "JOURNAL_STORAGE_NOT_CONFIGURED");
  } finally {
    if (originalAccess === undefined) delete process.env.JOURNAL_ACCESS_TOKEN;
    else process.env.JOURNAL_ACCESS_TOKEN = originalAccess;
    if (originalUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = originalUrl;
    if (originalRedisToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = originalRedisToken;
  }
});

test("manual journal API reads Redis and sends an authenticated atomic open command", async () => {
  const handler = require("../api/manual-journal.js");
  const originalFetch = global.fetch;
  const saved = {
    access: process.env.JOURNAL_ACCESS_TOKEN,
    url: process.env.KV_REST_API_URL,
    redis: process.env.KV_REST_API_TOKEN
  };
  const token = "journal-test-token-".padEnd(64, "x");
  let requestedUrl = "";
  let command = null;
  const response = (result) => ({ ok: true, status: 200, json: async () => ({ result }) });
  const makeRes = () => ({
    code: 200, body: null, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  });

  try {
    process.env.JOURNAL_ACCESS_TOKEN = token;
    process.env.KV_REST_API_URL = "https://redis.example.test";
    process.env.KV_REST_API_TOKEN = "redis-secret";
    global.fetch = async (url, options = {}) => {
      requestedUrl = String(url);
      if (options.method === "GET") return response(null);
      command = JSON.parse(options.body);
      const incoming = JSON.parse(command[5]);
      return response(JSON.stringify({
        ok: true,
        state: { trades: [incoming], activeTradeId: incoming.tradeId }
      }));
    };

    const getRes = makeRes();
    await handler({ method: "GET", headers: { authorization: "Bearer " + token } }, getRes);
    assert.equal(getRes.code, 200);
    assert.deepEqual(getRes.body.state, { trades: [], activeTradeId: "" });
    assert.match(requestedUrl, /\/get\//);

    const candleClosedAt = Date.now() - 30 * 60000;
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
    const postRes = makeRes();
    await handler({
      method: "POST",
      headers: { authorization: "Bearer " + token },
      body: { action: "open", signal, fillPrice: 2650 }
    }, postRes);
    assert.equal(postRes.code, 200);
    assert.equal(postRes.body.ok, true);
    assert.equal(requestedUrl, "https://redis.example.test");
    assert.equal(command[0], "EVAL");
    assert.equal(command[2], "1");
    assert.equal(command[3], "quant-pro:xauusd:manual-journal:v1");
    assert.equal(command[4], "open");
    assert.equal(command[6], "");
    assert.equal(command[7], "");
    assert.equal(command[8], "500");
  } finally {
    global.fetch = originalFetch;
    if (saved.access === undefined) delete process.env.JOURNAL_ACCESS_TOKEN;
    else process.env.JOURNAL_ACCESS_TOKEN = saved.access;
    if (saved.url === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = saved.url;
    if (saved.redis === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = saved.redis;
  }
});


test("manual journal classifies provider failures without exposing provider messages", () => {
  assert.equal(journal.providerErrorCategory("Unauthorized: invalid token"), "AUTH");
  assert.equal(journal.providerErrorCategory("ERR unknown command EVAL"), "COMMAND");
  assert.equal(journal.providerErrorCategory("rate limit exceeded"), "RATE_LIMIT");
  assert.equal(journal.providerErrorCategory("request timed out"), "TIMEOUT");
  assert.equal(journal.providerErrorCategory("unexpected upstream response"), "PROVIDER_ERROR");
});

test("manual journal Redis HTTP failures are logged with safe metadata and return a stable API error", async () => {
  const handler = require("../api/manual-journal.js");
  const originalFetch = global.fetch;
  const originalError = console.error;
  const saved = {
    access: process.env.JOURNAL_ACCESS_TOKEN,
    url: process.env.KV_REST_API_URL,
    redis: process.env.KV_REST_API_TOKEN
  };
  const token = "journal-test-token-".padEnd(64, "x");
  const redisSecret = "redis-secret-do-not-log";
  const logs = [];
  const res = {
    code: 200, body: null,
    setHeader() {},
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };

  try {
    process.env.JOURNAL_ACCESS_TOKEN = token;
    process.env.KV_REST_API_URL = "https://redis.example.test";
    process.env.KV_REST_API_TOKEN = redisSecret;
    console.error = (...args) => logs.push(args);
    global.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "Unauthorized: " + redisSecret })
    });

    await handler({
      method: "GET",
      headers: { authorization: "Bearer " + token }
    }, res);

    assert.equal(res.code, 502);
    assert.equal(res.body.error, "JOURNAL_SERVICE_UNAVAILABLE");
    assert.equal(res.body.diagnosticCode, "UPSTREAM_AUTH");
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0][1], {
      operation: "GET_STATE",
      httpStatus: 401,
      providerCategory: "AUTH"
    });
    assert.equal(JSON.stringify(logs).includes(redisSecret), false);
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
    if (saved.access === undefined) delete process.env.JOURNAL_ACCESS_TOKEN;
    else process.env.JOURNAL_ACCESS_TOKEN = saved.access;
    if (saved.url === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = saved.url;
    if (saved.redis === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = saved.redis;
  }
});

test("manual journal reports network failures without leaking credentials", async () => {
  const handler = require("../api/manual-journal.js");
  const originalFetch = global.fetch;
  const originalError = console.error;
  const saved = {
    access: process.env.JOURNAL_ACCESS_TOKEN,
    url: process.env.KV_REST_API_URL,
    redis: process.env.KV_REST_API_TOKEN
  };
  const token = "journal-test-token-".padEnd(64, "x");
  const logs = [];
  const res = {
    code: 200, body: null,
    setHeader() {},
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };

  try {
    process.env.JOURNAL_ACCESS_TOKEN = token;
    process.env.KV_REST_API_URL = "https://redis.example.test";
    process.env.KV_REST_API_TOKEN = "redis-secret";
    console.error = (...args) => logs.push(args);
    global.fetch = async () => { throw new TypeError("fetch failed"); };

    await handler({
      method: "GET",
      headers: { authorization: "Bearer " + token }
    }, res);

    assert.equal(res.code, 502);
    assert.equal(res.body.error, "JOURNAL_SERVICE_UNAVAILABLE");
    assert.equal(res.body.diagnosticCode, "UPSTREAM_NETWORK");
    assert.deepEqual(logs[0][1], { operation: "GET_STATE", code: "NETWORK" });
    assert.equal(JSON.stringify(logs).includes("redis-secret"), false);
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
    if (saved.access === undefined) delete process.env.JOURNAL_ACCESS_TOKEN;
    else process.env.JOURNAL_ACCESS_TOKEN = saved.access;
    if (saved.url === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = saved.url;
    if (saved.redis === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = saved.redis;
  }
});


test("manual journal reports Redis command rejection with a safe diagnostic code", async () => {
  const handler = require("../api/manual-journal.js");
  const originalFetch = global.fetch;
  const originalError = console.error;
  const saved = {
    access: process.env.JOURNAL_ACCESS_TOKEN,
    url: process.env.KV_REST_API_URL,
    redis: process.env.KV_REST_API_TOKEN
  };
  const token = "journal-test-token-".padEnd(64, "x");
  const logs = [];
  const res = {
    code: 200, body: null,
    setHeader() {},
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };

  try {
    process.env.JOURNAL_ACCESS_TOKEN = token;
    process.env.KV_REST_API_URL = "https://redis.example.test";
    process.env.KV_REST_API_TOKEN = "redis-secret";
    console.error = (...args) => logs.push(args);
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: "ERR unknown command EVAL" })
    });

    await handler({
      method: "GET",
      headers: { authorization: "Bearer " + token }
    }, res);

    assert.equal(res.code, 502);
    assert.equal(res.body.error, "JOURNAL_SERVICE_UNAVAILABLE");
    assert.equal(res.body.diagnosticCode, "UPSTREAM_COMMAND_COMMAND");
    assert.deepEqual(logs[0][1], {
      operation: "GET_STATE",
      providerCategory: "COMMAND"
    });
    assert.equal(JSON.stringify(logs).includes("redis-secret"), false);
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
    if (saved.access === undefined) delete process.env.JOURNAL_ACCESS_TOKEN;
    else process.env.JOURNAL_ACCESS_TOKEN = saved.access;
    if (saved.url === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = saved.url;
    if (saved.redis === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = saved.redis;
  }
});

test("manual journal rejects malformed Redis responses with a safe diagnostic code", async () => {
  const handler = require("../api/manual-journal.js");
  const originalFetch = global.fetch;
  const originalError = console.error;
  const saved = {
    access: process.env.JOURNAL_ACCESS_TOKEN,
    url: process.env.KV_REST_API_URL,
    redis: process.env.KV_REST_API_TOKEN
  };
  const token = "journal-test-token-".padEnd(64, "x");
  const logs = [];
  const res = {
    code: 200, body: null,
    setHeader() {},
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };

  try {
    process.env.JOURNAL_ACCESS_TOKEN = token;
    process.env.KV_REST_API_URL = "https://redis.example.test";
    process.env.KV_REST_API_TOKEN = "redis-secret";
    console.error = (...args) => logs.push(args);
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("invalid JSON"); }
    });

    await handler({
      method: "GET",
      headers: { authorization: "Bearer " + token }
    }, res);

    assert.equal(res.code, 502);
    assert.equal(res.body.error, "JOURNAL_SERVICE_UNAVAILABLE");
    assert.equal(res.body.diagnosticCode, "UPSTREAM_INVALID_RESPONSE");
    assert.deepEqual(logs[0][1], {
      operation: "GET_STATE",
      httpStatus: 200
    });
    assert.equal(JSON.stringify(logs).includes("redis-secret"), false);
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
    if (saved.access === undefined) delete process.env.JOURNAL_ACCESS_TOKEN;
    else process.env.JOURNAL_ACCESS_TOKEN = saved.access;
    if (saved.url === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = saved.url;
    if (saved.redis === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = saved.redis;
  }
});


test("manual journal rejects Redis payloads that omit the result field", async () => {
  const handler = require("../api/manual-journal.js");
  const originalFetch = global.fetch;
  const originalError = console.error;
  const saved = {
    access: process.env.JOURNAL_ACCESS_TOKEN,
    url: process.env.KV_REST_API_URL,
    redis: process.env.KV_REST_API_TOKEN
  };
  const token = "journal-test-token-".padEnd(64, "x");
  const logs = [];
  const res = {
    code: 200, body: null,
    setHeader() {},
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };

  try {
    process.env.JOURNAL_ACCESS_TOKEN = token;
    process.env.KV_REST_API_URL = "https://redis.example.test";
    process.env.KV_REST_API_TOKEN = "redis-secret";
    console.error = (...args) => logs.push(args);
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: "shape" })
    });

    await handler({
      method: "GET",
      headers: { authorization: "Bearer " + token }
    }, res);

    assert.equal(res.code, 502);
    assert.equal(res.body.error, "JOURNAL_SERVICE_UNAVAILABLE");
    assert.equal(res.body.diagnosticCode, "UPSTREAM_INVALID_RESPONSE");
    assert.deepEqual(logs[0][1], { operation: "GET_STATE", httpStatus: 200 });
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
    if (saved.access === undefined) delete process.env.JOURNAL_ACCESS_TOKEN;
    else process.env.JOURNAL_ACCESS_TOKEN = saved.access;
    if (saved.url === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = saved.url;
    if (saved.redis === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = saved.redis;
  }
});


test("manual journal marks malformed stored state as an invalid upstream response", () => {
  const invalid = error => error.message === "JOURNAL_STATE_INVALID" &&
    error.diagnosticCode === "UPSTREAM_INVALID_RESPONSE";
  assert.throws(() => journal.parseRedisState("{broken"), invalid);
  assert.throws(() => journal.parseRedisState(""), invalid);
  assert.throws(() => journal.parseRedisState({ trades: {}, activeTradeId: "" }), invalid);
  assert.throws(() => journal.parseRedisState({
    trades: [{
      tradeId: "11111111-1111-4111-8111-111111111111",
      signalId: "XAUUSD:BUY:1795730400000",
      symbol: "XAUUSD", side: "BUY", status: "OPEN",
      fillPrice: 2650, stopLoss: 2640, takeProfit: 2670
    }],
    activeTradeId: ""
  }), invalid);
  assert.throws(() => journal.parseRedisState({
    trades: [], activeTradeId: "11111111-1111-4111-8111-111111111111"
  }), invalid);
  assert.deepEqual(journal.parseRedisState(null), { trades: [], activeTradeId: "" });
});

test("manual journal rejects malformed mutation payloads instead of returning false success", async () => {
  const handler = require("../api/manual-journal.js");
  const originalFetch = global.fetch;
  const saved = {
    access: process.env.JOURNAL_ACCESS_TOKEN,
    url: process.env.KV_REST_API_URL,
    redis: process.env.KV_REST_API_TOKEN
  };
  const token = "journal-test-token-".padEnd(64, "x");
  const res = {
    code: 200, body: null,
    setHeader() {},
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
  try {
    process.env.JOURNAL_ACCESS_TOKEN = token;
    process.env.KV_REST_API_URL = "https://redis.example.test";
    process.env.KV_REST_API_TOKEN = "redis-secret";
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: "not-json" })
    });
    const closedAt = Date.now() - 30 * 60000;
    const signal = {
      symbol: "XAUUSD",
      status: "BUY",
      signalId: "XAUUSD:BUY:" + closedAt,
      signalCandleClosedAt: new Date(closedAt).toISOString(),
      signalValidUntil: new Date(closedAt + 3600000).toISOString(),
      entry: 2650,
      sl: 2640,
      tp: 2670
    };
    await handler({
      method: "POST",
      headers: { authorization: "Bearer " + token },
      body: { action: "open", signal, fillPrice: 2650 }
    }, res);
    assert.equal(res.code, 502);
    assert.equal(res.body.error, "JOURNAL_SERVICE_UNAVAILABLE");
    assert.equal(res.body.diagnosticCode, "UPSTREAM_INVALID_RESPONSE");
  } finally {
    global.fetch = originalFetch;
    if (saved.access === undefined) delete process.env.JOURNAL_ACCESS_TOKEN;
    else process.env.JOURNAL_ACCESS_TOKEN = saved.access;
    if (saved.url === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = saved.url;
    if (saved.redis === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = saved.redis;
  }
});


test("manual journal rejects incomplete negative mutation results", async () => {
  const handler = require("../api/manual-journal.js");
  const originalFetch = global.fetch;
  const saved = {
    access: process.env.JOURNAL_ACCESS_TOKEN,
    url: process.env.KV_REST_API_URL,
    redis: process.env.KV_REST_API_TOKEN
  };
  const token = "journal-test-token-".padEnd(64, "x");
  const res = {
    code: 200, body: null,
    setHeader() {},
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
  try {
    process.env.JOURNAL_ACCESS_TOKEN = token;
    process.env.KV_REST_API_URL = "https://redis.example.test";
    process.env.KV_REST_API_TOKEN = "redis-secret";
    global.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ result: JSON.stringify({ ok: false }) })
    });
    const closedAt = Date.now() - 30 * 60000;
    const signal = {
      symbol: "XAUUSD", status: "BUY",
      signalId: "XAUUSD:BUY:" + closedAt,
      signalCandleClosedAt: new Date(closedAt).toISOString(),
      signalValidUntil: new Date(closedAt + 3600000).toISOString(),
      entry: 2650, sl: 2640, tp: 2670
    };
    await handler({
      method: "POST",
      headers: { authorization: "Bearer " + token },
      body: { action: "open", signal, fillPrice: 2650 }
    }, res);
    assert.equal(res.code, 502);
    assert.equal(res.body.error, "JOURNAL_SERVICE_UNAVAILABLE");
    assert.equal(res.body.diagnosticCode, "UPSTREAM_INVALID_RESPONSE");
  } finally {
    global.fetch = originalFetch;
    if (saved.access === undefined) delete process.env.JOURNAL_ACCESS_TOKEN;
    else process.env.JOURNAL_ACCESS_TOKEN = saved.access;
    if (saved.url === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = saved.url;
    if (saved.redis === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = saved.redis;
  }
});


test("historical period is not scored when its candles contain a gap over 72 hours", () => {
  const base = Date.UTC(2026, 4, 1, 0, 0, 0);
  const data = Array.from({ length: 1100 }, (_, i) =>
    candle(base + i * 3600000 + (i >= 700 ? 96 * 3600000 : 0),
      2300 + i * 0.03 + 2 * Math.sin(i / 9), 1)
  );
  const h4 = backtest.makeH4(data);
  const indicators = backtest.buildIndicators(data);
  const result = backtest.runBacktest(
    data, h4, indicators, 0.1,
    {
      name: "GAPPED_PERIOD",
      start: new Date(base + 500 * 3600000).toISOString(),
      end: new Date(base + 900 * 3600000).toISOString()
    }
  );
  assert.equal(result.periodStatus, "PERIOD_DATA_GAP");
  assert.equal(result.continuityComplete, false);
  assert.equal(result.metrics, null);
});

test("incomplete historical period is not scored when its last candle is over 72 hours stale", () => {
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  const data = Array.from({ length: 1000 }, (_, i) =>
    candle(base + i * 3600000, 2300 + i * 0.03 + 2 * Math.sin(i / 9), 1)
  );
  const h4 = backtest.makeH4(data);
  const indicators = backtest.buildIndicators(data);
  const period = {
    name: "STALE_INCOMPLETE",
    start: new Date(base + 500 * 3600000).toISOString(),
    end: new Date(base + 1100 * 3600000).toISOString()
  };
  const now = base + 1100 * 3600000;
  const result = backtest.runBacktest(data, h4, indicators, 0.1, period, now);
  assert.equal(result.periodStatus, "PERIOD_DATA_GAP");
  assert.equal(result.metrics, null);
  assert.equal(result.continuityComplete, false);
});

test("historical period is not scored without its own 400 H1 and 100 H4 warmup", () => {
  const base = Date.UTC(2026, 4, 1, 0, 0, 0);
  const data = Array.from({ length: 1000 }, (_, i) =>
    candle(base + i * 3600000, 2300 + i * 0.03 + 2 * Math.sin(i / 9), 1)
  );
  const h4 = backtest.makeH4(data);
  const indicators = backtest.buildIndicators(data);
  const tooEarly = backtest.runBacktest(
    data, h4, indicators, 0.1,
    { name: "NO_WARMUP", start: new Date(base).toISOString(), end: new Date(base + 48 * 3600000).toISOString() }
  );
  assert.equal(tooEarly.periodStatus, "PERIOD_WARMUP_INCOMPLETE");
  assert.equal(tooEarly.metrics, null);
  assert.equal(tooEarly.warmupAvailable.completedH1, 0);

  const warmed = backtest.runBacktest(
    data, h4, indicators, 0.1,
    { name: "WARMED", start: new Date(base + 500 * 3600000).toISOString(), end: new Date(base + 600 * 3600000).toISOString() },
    base + 601 * 3600000
  );
  assert.notEqual(warmed.periodStatus, "PERIOD_WARMUP_INCOMPLETE");
  assert.equal(warmed.warmupComplete, undefined);
});


const forwardArchive = require("../public/forward-archive.js");

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); }
  };
}

function forwardPayload(generatedAt, trades = []) {
  return {
    startTime: "2026-11-26T20:00:00.000Z",
    generatedAt,
    results: [
      { slippagePerSideUSD: 0.1, closedTrades: trades },
      { slippagePerSideUSD: 0.2, closedTrades: trades.map(t => ({ ...t, entry: t.entry + 0.1, stopLoss: t.stopLoss + 0.1, takeProfit: t.takeProfit + 0.1 })) }
    ]
  };
}

function sampleForwardTrade(signalTime, exitTime, netR = 1.9) {
  return {
    side: "BUY", signalTime, exitTime, entry: 100, stopLoss: 99,
    takeProfit: 102, exit: 101.9, exitReason: "TAKE_PROFIT", netR
  };
}

test("forward archive starts now and does not import trades from before tracking", () => {
  const storage = memoryStorage();
  const oldTrade = sampleForwardTrade("2026-11-27T05:00:00.000Z", "2026-11-27T10:00:00.000Z");
  const first = forwardArchive.capture(forwardPayload("2026-11-27T11:00:00.000Z", [oldTrade]), storage);
  assert.equal(first.ok, true);
  assert.equal(first.started, true);
  assert.equal(first.added, 0);
  assert.equal(first.recordCount, 0);
});

test("forward archive stores only post-start closed signals and deduplicates repeated checks", () => {
  const storage = memoryStorage();
  forwardArchive.capture(forwardPayload("2026-11-27T11:00:00.000Z"), storage);
  const fresh = sampleForwardTrade("2026-11-27T12:00:00.000Z", "2026-11-27T14:00:00.000Z");
  const payload = forwardPayload("2026-11-27T15:00:00.000Z", [fresh]);
  const first = forwardArchive.capture(payload, storage);
  assert.equal(first.added, 2);
  assert.equal(first.recordCount, 2);
  const repeated = forwardArchive.capture(payload, storage);
  assert.equal(repeated.added, 0);
  assert.equal(repeated.recordCount, 2);
});

test("forward archive excludes signals before tracking even if they close afterward", () => {
  const storage = memoryStorage();
  forwardArchive.capture(forwardPayload("2026-11-27T11:00:00.000Z"), storage);
  const oldSignal = sampleForwardTrade("2026-11-27T10:00:00.000Z", "2026-11-27T13:00:00.000Z");
  const result = forwardArchive.capture(forwardPayload("2026-11-27T14:00:00.000Z", [oldSignal]), storage);
  assert.equal(result.added, 0);
  assert.equal(result.recordCount, 0);
});

test("forward archive retains first snapshot and flags provider replay changes", () => {
  const storage = memoryStorage();
  forwardArchive.capture(forwardPayload("2026-11-27T11:00:00.000Z"), storage);
  const original = sampleForwardTrade("2026-11-27T12:00:00.000Z", "2026-11-27T14:00:00.000Z", 1.9);
  forwardArchive.capture(forwardPayload("2026-11-27T15:00:00.000Z", [original]), storage);
  const revised = { ...original, netR: 1.7 };
  const result = forwardArchive.capture(forwardPayload("2026-11-27T16:00:00.000Z", [revised]), storage);
  assert.equal(result.recordCount, 2);
  assert.equal(result.conflictCount, 2);
  const saved = JSON.parse(storage.getItem(forwardArchive.STORAGE_KEY));
  assert.equal(saved.records[0].netR, 1.9);
});

test("forward archive refuses malformed API snapshots and invalid stored archives", () => {
  const storage = memoryStorage();
  assert.equal(forwardArchive.capture({}, storage).error, "INVALID_FORWARD_SNAPSHOT");
  storage.setItem(forwardArchive.STORAGE_KEY, JSON.stringify({ schemaVersion: 9 }));
  assert.equal(forwardArchive.capture(forwardPayload("2026-11-27T11:00:00.000Z"), storage).error, "LOCAL_ARCHIVE_INVALID");
});


test("forward archive backup exports and restores records without duplication", () => {
  const source = memoryStorage();
  forwardArchive.capture(forwardPayload("2026-11-27T11:00:00.000Z"), source);
  const trade = sampleForwardTrade("2026-11-27T12:00:00.000Z", "2026-11-27T14:00:00.000Z");
  forwardArchive.capture(forwardPayload("2026-11-27T15:00:00.000Z", [trade]), source);
  const backup = forwardArchive.exportBackup(source);
  assert.ok(backup.includes("QUANT_PRO_FORWARD_ARCHIVE"));
  const destination = memoryStorage();
  const restored = forwardArchive.restoreBackup(backup, destination);
  assert.equal(restored.ok, true);
  assert.equal(restored.added, 2);
  assert.equal(restored.recordCount, 2);
  const repeated = forwardArchive.restoreBackup(backup, destination);
  assert.equal(repeated.added, 0);
  assert.equal(repeated.recordCount, 2);
});

test("forward archive backup rejects malformed files and preserves existing data", () => {
  const storage = memoryStorage();
  forwardArchive.capture(forwardPayload("2026-11-27T11:00:00.000Z"), storage);
  const invalid = forwardArchive.restoreBackup('{"backupType":"WRONG"}', storage);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, "INVALID_FORWARD_BACKUP");
  assert.equal(forwardArchive.read(storage).records.length, 0);
});

test("forward archive backup merge preserves existing first-seen result on conflict", () => {
  const a = memoryStorage(), b = memoryStorage();
  forwardArchive.capture(forwardPayload("2026-11-27T11:00:00.000Z"), a);
  forwardArchive.capture(forwardPayload("2026-11-27T11:00:00.000Z"), b);
  const tradeA = sampleForwardTrade("2026-11-27T12:00:00.000Z", "2026-11-27T14:00:00.000Z", 1.9);
  const tradeB = sampleForwardTrade("2026-11-27T12:00:00.000Z", "2026-11-27T14:00:00.000Z", 1.7);
  forwardArchive.capture(forwardPayload("2026-11-27T15:00:00.000Z", [tradeA]), a);
  forwardArchive.capture(forwardPayload("2026-11-27T15:00:00.000Z", [tradeB]), b);
  const result = forwardArchive.restoreBackup(forwardArchive.exportBackup(b), a);
  assert.equal(result.ok, true);
  assert.equal(result.conflictCount, 2);
  const saved = forwardArchive.read(a);
  assert.equal(saved.records[0].netR, 1.9);
});


test("forward archive repeated conflict imports remain idempotent", () => {
  const a = memoryStorage(), b = memoryStorage();
  forwardArchive.capture(forwardPayload("2026-11-27T11:00:00.000Z"), a);
  forwardArchive.capture(forwardPayload("2026-11-27T11:00:00.000Z"), b);
  const tradeA = sampleForwardTrade("2026-11-27T12:00:00.000Z", "2026-11-27T14:00:00.000Z", 1.9);
  const tradeB = sampleForwardTrade("2026-11-27T12:00:00.000Z", "2026-11-27T14:00:00.000Z", 1.7);
  forwardArchive.capture(forwardPayload("2026-11-27T15:00:00.000Z", [tradeA]), a);
  forwardArchive.capture(forwardPayload("2026-11-27T15:00:00.000Z", [tradeB]), b);
  const backup = forwardArchive.exportBackup(b);
  assert.equal(forwardArchive.restoreBackup(backup, a).conflictCount, 2);
  assert.equal(forwardArchive.restoreBackup(backup, a).conflictCount, 2);
});

test("forward archive restore rejects tampered record keys and malformed conflicts atomically", () => {
  const storage = memoryStorage();
  forwardArchive.capture(forwardPayload("2026-11-27T11:00:00.000Z"), storage);
  const trade = sampleForwardTrade("2026-11-27T12:00:00.000Z", "2026-11-27T14:00:00.000Z");
  forwardArchive.capture(forwardPayload("2026-11-27T15:00:00.000Z", [trade]), storage);
  const backup = JSON.parse(forwardArchive.exportBackup(storage));
  backup.archive.records[0].key = "forged-key";
  const before = storage.getItem(forwardArchive.STORAGE_KEY);
  const invalid = forwardArchive.restoreBackup(JSON.stringify(backup), storage);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, "INVALID_FORWARD_BACKUP");
  assert.equal(storage.getItem(forwardArchive.STORAGE_KEY), before);

  const malformedConflict = JSON.parse(forwardArchive.exportBackup(storage));
  malformedConflict.archive.conflicts.push({ key: "bad", note: {} });
  const invalidConflict = forwardArchive.restoreBackup(JSON.stringify(malformedConflict), storage);
  assert.equal(invalidConflict.ok, false);
  assert.equal(storage.getItem(forwardArchive.STORAGE_KEY), before);
});

test("forward archive restore rejects corrupted local records without overwriting them", () => {
  const storage = memoryStorage();
  const malformed = {
    schemaVersion: 1, symbol: "XAUUSD",
    trackingStartedAt: "2026-11-27T11:00:00.000Z",
    records: [{ key: "tampered" }], conflicts: []
  };
  storage.setItem(forwardArchive.STORAGE_KEY, JSON.stringify(malformed));
  const source = memoryStorage();
  forwardArchive.capture(forwardPayload("2026-11-27T11:00:00.000Z"), source);
  const result = forwardArchive.restoreBackup(forwardArchive.exportBackup(source), storage);
  assert.equal(result.ok, false);
  assert.equal(result.error, "LOCAL_ARCHIVE_INVALID");
  assert.deepEqual(forwardArchive.read(storage), malformed);
});


test("forward archive refuses malformed local JSON instead of resetting or overwriting it", () => {
  const captureStorage = memoryStorage();
  captureStorage.setItem(forwardArchive.STORAGE_KEY, "{broken-json");
  const captureBefore = captureStorage.getItem(forwardArchive.STORAGE_KEY);
  const captured = forwardArchive.capture(forwardPayload("2026-11-27T11:00:00.000Z"), captureStorage);
  assert.equal(captured.ok, false);
  assert.equal(captured.error, "LOCAL_ARCHIVE_INVALID");
  assert.equal(captureStorage.getItem(forwardArchive.STORAGE_KEY), captureBefore);

  const restoreStorage = memoryStorage();
  restoreStorage.setItem(forwardArchive.STORAGE_KEY, "{broken-json");
  const source = memoryStorage();
  forwardArchive.capture(forwardPayload("2026-11-27T11:00:00.000Z"), source);
  const restored = forwardArchive.restoreBackup(forwardArchive.exportBackup(source), restoreStorage);
  assert.equal(restored.ok, false);
  assert.equal(restored.error, "LOCAL_ARCHIVE_INVALID");
  assert.equal(restoreStorage.getItem(forwardArchive.STORAGE_KEY), "{broken-json");
});
