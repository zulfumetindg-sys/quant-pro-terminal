(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.QuantForwardArchive = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STORAGE_KEY = "quantProForwardArchiveV1";
  const MAX_RECORDS = 1000;
  const FIELDS = ["side", "signalTime", "exitTime", "entry", "stopLoss", "takeProfit", "exit", "netR", "exitReason"];

  function safeParse(value) {
    try { return value ? JSON.parse(value) : null; } catch (_) { return null; }
  }

  function sameTrade(a, b) {
    return FIELDS.every(key => {
      if (typeof a[key] === "number" || typeof b[key] === "number") {
        return Number.isFinite(Number(a[key])) && Number.isFinite(Number(b[key])) &&
          Math.abs(Number(a[key]) - Number(b[key])) < 1e-8;
      }
      return a[key] === b[key];
    });
  }

  function summarize(records, slippage) {
    const rows = records.filter(x => x.slippagePerSideUSD === slippage);
    const wins = rows.filter(x => x.netR > 0).length;
    const losses = rows.filter(x => x.netR < 0).length;
    return {
      slippagePerSideUSD: slippage,
      tradeCount: rows.length,
      wins,
      losses,
      netR: +rows.reduce((sum, x) => sum + x.netR, 0).toFixed(3),
      winRatePercent: rows.length >= 30 ? +(wins / rows.length * 100).toFixed(2) : null,
      sampleStatus: rows.length >= 30 ? "MINIMUM_30_REACHED_NOT_A_LIVE_PROBABILITY" : "INSUFFICIENT_SAMPLE"
    };
  }

  function capture(payload, storage) {
    if (!payload || !Number.isFinite(Date.parse(payload.generatedAt)) ||
        !Array.isArray(payload.results) || !payload.results.length) {
      return { ok: false, error: "INVALID_FORWARD_SNAPSHOT" };
    }
    if (!storage || typeof storage.getItem !== "function" ||
        typeof storage.setItem !== "function") {
      return { ok: false, error: "LOCAL_STORAGE_UNAVAILABLE" };
    }

    const observedAt = new Date(payload.generatedAt).toISOString();
    let archive = safeParse(storage.getItem(STORAGE_KEY));
    let started = false;

    if (archive === null) {
      archive = {
        schemaVersion: 1,
        symbol: "XAUUSD",
        fixedTestStart: payload.startTime || null,
        trackingStartedAt: observedAt,
        records: [],
        conflicts: []
      };
      started = true;
    } else if (
      archive.schemaVersion !== 1 ||
      !Array.isArray(archive.records) ||
      !Array.isArray(archive.conflicts) ||
      !Number.isFinite(Date.parse(archive.trackingStartedAt))
    ) {
      return { ok: false, error: "LOCAL_ARCHIVE_INVALID" };
    }

    let added = 0;
    for (const result of payload.results) {
      const slippage = Number(result && result.slippagePerSideUSD);
      if (!Number.isFinite(slippage) || !Array.isArray(result.closedTrades)) continue;

      for (const trade of result.closedTrades) {
        if (!trade || (trade.side !== "BUY" && trade.side !== "SELL")) continue;
        const signalMs = Date.parse(trade.signalTime);
        const exitMs = Date.parse(trade.exitTime);
        if (!Number.isFinite(signalMs) || signalMs <= Date.parse(archive.trackingStartedAt) ||
            !Number.isFinite(exitMs) || exitMs <= signalMs || exitMs > Date.parse(observedAt)) continue;
        if (![trade.entry, trade.stopLoss, trade.takeProfit, trade.exit, trade.netR].every(Number.isFinite)) continue;

        const key = slippage.toFixed(3) + "|" + trade.side + "|" + new Date(signalMs).toISOString();
        const candidate = {
          key,
          slippagePerSideUSD: slippage,
          side: trade.side,
          signalTime: new Date(signalMs).toISOString(),
          entry: trade.entry,
          stopLoss: trade.stopLoss,
          takeProfit: trade.takeProfit,
          exit: trade.exit,
          exitTime: new Date(exitMs).toISOString(),
          exitReason: String(trade.exitReason || "UNKNOWN"),
          netR: trade.netR,
          firstObservedAt: observedAt
        };
        const existing = archive.records.find(x => x.key === key);
        if (existing) {
          if (!sameTrade(existing, candidate) &&
              !archive.conflicts.some(x => x.key === key)) {
            archive.conflicts.push({
              key,
              firstObservedAt: existing.firstObservedAt,
              observedAt,
              note: "Provider replay changed an already archived trade; first snapshot retained."
            });
          }
          continue;
        }
        if (archive.records.length < MAX_RECORDS) {
          archive.records.push(candidate);
          added++;
        }
      }
    }

    archive.lastCheckedAt = observedAt;
    archive.conflicts = archive.conflicts.slice(-100);
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(archive));
    } catch (_) {
      return { ok: false, error: "LOCAL_ARCHIVE_SAVE_FAILED" };
    }

    return {
      ok: true,
      started,
      added,
      trackingStartedAt: archive.trackingStartedAt,
      lastCheckedAt: archive.lastCheckedAt,
      conflictCount: archive.conflicts.length,
      summaries: [0.1, 0.2].map(value => summarize(archive.records, value)),
      recordCount: archive.records.length
    };
  }

  return { STORAGE_KEY, capture, summarize };
});
