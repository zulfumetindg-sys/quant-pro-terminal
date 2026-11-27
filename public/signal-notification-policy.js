(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.QuantSignalNotifications = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SIGNAL_LIFETIME_MS = 60 * 60 * 1000;

  function validateSignalIdentity(signal, now) {
    if (!signal || (signal.status !== "BUY" && signal.status !== "SELL")) {
      return { valid: false, reason: "NOT_ACTIONABLE" };
    }
    if (typeof signal.signalId !== "string" || !signal.signalId.trim()) {
      return { valid: false, reason: "MISSING_SIGNAL_ID" };
    }

    // The engine's identity is XAUUSD:<side>:<signal-candle-close-ms>.
    // Bind side and expiry to that identity so malformed/stale payloads cannot alert.
    const match = /^XAUUSD:(BUY|SELL):(\d{13})$/.exec(signal.signalId);
    if (!match || match[1] !== signal.status) {
      return { valid: false, reason: "INVALID_SIGNAL_ID" };
    }

    const candleCloseMs = Number(match[2]);
    const validUntil = Date.parse(signal.signalValidUntil || "");
    if (!Number.isSafeInteger(candleCloseMs) || candleCloseMs <= 0 ||
        !Number.isFinite(validUntil) ||
        validUntil !== candleCloseMs + SIGNAL_LIFETIME_MS) {
      return { valid: false, reason: "INVALID_SIGNAL_EXPIRY" };
    }
    if (candleCloseMs > now || validUntil <= now) {
      return { valid: false, reason: "EXPIRED_OR_UNVERIFIABLE" };
    }
    return { valid: true };
  }

  function evaluate(signal, previousSignalId, now = Date.now()) {
    const validation = validateSignalIdentity(signal, now);
    if (!validation.valid) {
      return { notify: false, nextId: null, reason: validation.reason };
    }
    if (!previousSignalId) {
      return { notify: false, nextId: signal.signalId, reason: "BASELINE_ONLY" };
    }
    if (previousSignalId === signal.signalId) {
      return { notify: false, nextId: null, reason: "DUPLICATE" };
    }
    return { notify: true, nextId: signal.signalId, reason: "NEW_VALID_SIGNAL" };
  }

  return { evaluate, validateSignalIdentity };
});
