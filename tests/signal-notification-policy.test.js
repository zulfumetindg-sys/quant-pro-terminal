const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate, validateSignalIdentity } = require("../public/signal-notification-policy.js");

const candleClose = Date.parse("2026-11-27T15:00:00Z");
const validSignal = overrides => ({
  status: "BUY",
  signalId: "XAUUSD:BUY:" + candleClose,
  signalValidUntil: new Date(candleClose + 60 * 60 * 1000).toISOString(),
  ...overrides
});
const now = Date.parse("2026-11-27T15:15:00Z");

test("first observed signal is stored as baseline without alert", () => {
  assert.deepEqual(evaluate(validSignal(), null, now), {
    notify: false, nextId: "XAUUSD:BUY:" + candleClose, reason: "BASELINE_ONLY"
  });
});
test("new valid signal alerts once", () => {
  assert.equal(evaluate(validSignal(), "older-id", now).notify, true);
  assert.equal(evaluate(validSignal(), "XAUUSD:BUY:" + candleClose, now).reason, "DUPLICATE");
});
test("WAIT, missing id and expired signals never alert", () => {
  assert.equal(evaluate(validSignal({status:"WAIT"}), "older-id", now).notify, false);
  assert.equal(evaluate(validSignal({signalId:""}), "older-id", now).reason, "MISSING_SIGNAL_ID");
  assert.equal(evaluate(validSignal({signalValidUntil:"2026-11-27T15:00:00Z"}), "older-id", now).reason, "INVALID_SIGNAL_EXPIRY");
  assert.equal(evaluate(validSignal(), "older-id", candleClose + 60 * 60 * 1000).reason, "EXPIRED_OR_UNVERIFIABLE");
});
test("SELL signals use the same validated policy", () => {
  const sell = validSignal({status:"SELL",signalId:"XAUUSD:SELL:" + candleClose});
  assert.equal(evaluate(sell, "older-id", now).notify, true);
});
test("identity side must match signal direction", () => {
  assert.equal(validateSignalIdentity(validSignal({signalId:"XAUUSD:SELL:" + candleClose}), now).reason, "INVALID_SIGNAL_ID");
});
test("future, malformed and incorrectly expired identities are rejected", () => {
  assert.equal(validateSignalIdentity(validSignal({signalId:"XAUUSD:BUY:not-a-time"}), now).reason, "INVALID_SIGNAL_ID");
  const future = Date.parse("2026-11-27T15:30:00Z");
  assert.equal(validateSignalIdentity({
    status:"BUY",
    signalId:"XAUUSD:BUY:" + future,
    signalValidUntil:new Date(future + 60 * 60 * 1000).toISOString()
  }, now).reason, "EXPIRED_OR_UNVERIFIABLE");
  assert.equal(validateSignalIdentity(validSignal({signalValidUntil:new Date(candleClose + 2 * 60 * 60 * 1000).toISOString()}), now).reason, "INVALID_SIGNAL_EXPIRY");
});
