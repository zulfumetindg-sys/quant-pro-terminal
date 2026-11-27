(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.QuantSignalNotifications = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function evaluate(signal, previousSignalId, now = Date.now()) {
    if (!signal || (signal.status !== "BUY" && signal.status !== "SELL")) {
      return { notify: false, nextId: null, reason: "NOT_ACTIONABLE" };
    }
    if (typeof signal.signalId !== "string" || !signal.signalId.trim()) {
      return { notify: false, nextId: null, reason: "MISSING_SIGNAL_ID" };
    }
    const validUntil = Date.parse(signal.signalValidUntil || "");
    if (!Number.isFinite(validUntil) || validUntil <= now) {
      return { notify: false, nextId: null, reason: "EXPIRED_OR_UNVERIFIABLE" };
    }
    if (!previousSignalId) {
      return { notify: false, nextId: signal.signalId, reason: "BASELINE_ONLY" };
    }
    if (previousSignalId === signal.signalId) {
      return { notify: false, nextId: null, reason: "DUPLICATE" };
    }
    return { notify: true, nextId: signal.signalId, reason: "NEW_VALID_SIGNAL" };
  }
  return { evaluate };
});
