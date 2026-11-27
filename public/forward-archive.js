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

  function validRecord(row) {
    if (!row || typeof row !== "object" || typeof row.key !== "string" ||
        ![0.1, 0.2].includes(Number(row.slippagePerSideUSD)) ||
        !["BUY", "SELL"].includes(row.side) ||
        !Number.isFinite(Date.parse(row.signalTime)) ||
        !Number.isFinite(Date.parse(row.exitTime)) ||
        Date.parse(row.exitTime) <= Date.parse(row.signalTime) ||
        !Number.isFinite(Date.parse(row.firstObservedAt)) ||
        ![row.entry, row.stopLoss, row.takeProfit, row.exit, row.netR].every(Number.isFinite) ||
        typeof row.exitReason !== "string") return false;
    const canonicalKey = Number(row.slippagePerSideUSD).toFixed(3) + "|" +
      row.side + "|" + new Date(Date.parse(row.signalTime)).toISOString();
    return row.key === canonicalKey;
  }

  function validConflict(row) {
    return !!row && typeof row === "object" &&
      typeof row.key === "string" && row.key.length <= 160 &&
      Number.isFinite(Date.parse(row.firstObservedAt)) &&
      Number.isFinite(Date.parse(row.observedAt)) &&
      typeof row.note === "string" && row.note.length <= 240;
  }

  function summarize(records, slippage) {
    const rows = records
      .filter(x => x.slippagePerSideUSD === slippage)
      .sort((a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime));
    const wins = rows.filter(x => x.netR > 0);
    const losses = rows.filter(x => x.netR < 0);
    const grossWinR = wins.reduce((sum, x) => sum + x.netR, 0);
    const grossLossR = Math.abs(losses.reduce((sum, x) => sum + x.netR, 0));
    const netR = rows.reduce((sum, x) => sum + x.netR, 0);
    let equity = 0;
    let peak = 0;
    let maxDrawdownR = 0;
    for (const row of rows) {
      equity += row.netR;
      peak = Math.max(peak, equity);
      maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
    }
    return {
      slippagePerSideUSD: slippage,
      tradeCount: rows.length,
      wins: wins.length,
      losses: losses.length,
      breakEven: rows.length - wins.length - losses.length,
      grossWinR: +grossWinR.toFixed(3),
      grossLossR: +grossLossR.toFixed(3),
      profitFactor: grossLossR > 0 ? +(grossWinR / grossLossR).toFixed(3) : grossWinR > 0 ? "NO_LOSSES" : null,
      netR: +netR.toFixed(3),
      averageR: rows.length ? +(netR / rows.length).toFixed(3) : null,
      maxDrawdownR: +maxDrawdownR.toFixed(3),
      winRatePercent: rows.length >= 30 ? +(wins.length / rows.length * 100).toFixed(2) : null,
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
    const storedValue = storage.getItem(STORAGE_KEY);
    let archive = safeParse(storedValue);
    let started = false;
    if (storedValue !== null && archive === null) {
      return { ok: false, error: "LOCAL_ARCHIVE_INVALID" };
    }

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
      archive.symbol !== "XAUUSD" ||
      !Number.isFinite(Date.parse(archive.trackingStartedAt)) ||
      !Array.isArray(archive.records) || archive.records.length > MAX_RECORDS ||
      !archive.records.every(validRecord) ||
      !Array.isArray(archive.conflicts) || archive.conflicts.length > 100 ||
      !archive.conflicts.every(validConflict)
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

  function read(storage) {
    return safeParse(storage && storage.getItem(STORAGE_KEY));
  }

  function exportBackup(storage) {
    const archive = read(storage);
    if (!archive || archive.schemaVersion !== 1 || archive.symbol !== "XAUUSD" ||
        !Array.isArray(archive.records) || !Array.isArray(archive.conflicts)) return null;
    return JSON.stringify({
      backupType: "QUANT_PRO_FORWARD_ARCHIVE",
      exportedAt: new Date().toISOString(),
      archive
    }, null, 2);
  }

  function restoreBackup(json, storage) {
    if (!storage || typeof storage.getItem !== "function" ||
        typeof storage.setItem !== "function") return { ok: false, error: "LOCAL_STORAGE_UNAVAILABLE" };
    if (typeof json !== "string" || json.length > 1_000_000) {
      return { ok: false, error: "INVALID_FORWARD_BACKUP" };
    }
    const backup = safeParse(json);
    const incoming = backup && backup.archive;
    if (!backup || backup.backupType !== "QUANT_PRO_FORWARD_ARCHIVE" ||
        !Number.isFinite(Date.parse(backup.exportedAt)) ||
        !incoming || incoming.schemaVersion !== 1 || incoming.symbol !== "XAUUSD" ||
        !Number.isFinite(Date.parse(incoming.trackingStartedAt)) ||
        !Number.isFinite(Date.parse(incoming.lastCheckedAt || incoming.trackingStartedAt)) ||
        (incoming.fixedTestStart != null && !Number.isFinite(Date.parse(incoming.fixedTestStart))) ||
        !Array.isArray(incoming.records) || incoming.records.length > MAX_RECORDS ||
        !Array.isArray(incoming.conflicts) || incoming.conflicts.length > 100) {
      return { ok: false, error: "INVALID_FORWARD_BACKUP" };
    }

    const seen = new Set();
    for (const row of incoming.records) {
      if (!validRecord(row) || seen.has(row.key)) {
        return { ok: false, error: "INVALID_FORWARD_BACKUP" };
      }
      seen.add(row.key);
    }
    if (!incoming.conflicts.every(validConflict)) {
      return { ok: false, error: "INVALID_FORWARD_BACKUP" };
    }

    const currentRaw = storage.getItem(STORAGE_KEY);
    const current = safeParse(currentRaw);
    if (currentRaw !== null && current === null) {
      return { ok: false, error: "LOCAL_ARCHIVE_INVALID" };
    }
    if (current !== null && (current.schemaVersion !== 1 || current.symbol !== "XAUUSD" ||
        !Number.isFinite(Date.parse(current.trackingStartedAt)) ||
        !Array.isArray(current.records) || current.records.length > MAX_RECORDS ||
        !current.records.every(validRecord) ||
        !Array.isArray(current.conflicts) || current.conflicts.length > 100 ||
        !current.conflicts.every(validConflict))) {
      return { ok: false, error: "LOCAL_ARCHIVE_INVALID" };
    }
    const merged = current || {
      schemaVersion: 1, symbol: "XAUUSD",
      fixedTestStart: incoming.fixedTestStart || null,
      trackingStartedAt: incoming.trackingStartedAt,
      lastCheckedAt: incoming.lastCheckedAt || incoming.trackingStartedAt,
      records: [], conflicts: []
    };
    const existingByKey = new Map(merged.records.map(row => [row.key, row]));
    let added = 0;
    for (const row of incoming.records) {
      const prior = existingByKey.get(row.key);
      if (!prior) {
        if (merged.records.length >= MAX_RECORDS) continue;
        merged.records.push(row);
        existingByKey.set(row.key, row);
        added++;
      } else if (!sameTrade(prior, row) &&
          !merged.conflicts.some(x => x.key === row.key)) {
        merged.conflicts.push({
          key: row.key,
          firstObservedAt: prior.firstObservedAt,
          observedAt: new Date().toISOString(),
          note: "Imported archive conflicts with existing first-seen record; existing value retained."
        });
      }
    }
    if (Date.parse(incoming.trackingStartedAt) < Date.parse(merged.trackingStartedAt)) {
      merged.trackingStartedAt = incoming.trackingStartedAt;
    }
    if (Date.parse(incoming.lastCheckedAt || incoming.trackingStartedAt) > Date.parse(merged.lastCheckedAt)) {
      merged.lastCheckedAt = incoming.lastCheckedAt || incoming.trackingStartedAt;
    }
    const conflictByKey = new Map(merged.conflicts.map(item => [item.key, item]));
    for (const conflict of incoming.conflicts) {
      if (!conflictByKey.has(conflict.key)) {
        merged.conflicts.push(conflict);
        conflictByKey.set(conflict.key, conflict);
      }
    }
    merged.conflicts = merged.conflicts.slice(-100);
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch (_) {
      return { ok: false, error: "LOCAL_ARCHIVE_SAVE_FAILED" };
    }
    return { ok: true, added, recordCount: merged.records.length, conflictCount: merged.conflicts.length };
  }

  return { STORAGE_KEY, capture, summarize, read, exportBackup, restoreBackup };
});
