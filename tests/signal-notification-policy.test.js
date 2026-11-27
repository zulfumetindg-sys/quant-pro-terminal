const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate } = require("../public/signal-notification-policy.js");

const validSignal = overrides => ({
  status: "BUY",
  signalId: "xau-h1-2026-11-27T15:00:00Z",
  signalValidUntil: "2026-11-27T16:00:00Z",
  ...overrides
});
const now = Date.parse("2026-11-27T15:15:00Z");

test("first observed signal is stored as baseline without alert", () => {
  assert.deepEqual(evaluate(validSignal(), null, now), {
    notify: false, nextId: "xau-h1-2026-11-27T15:00:00Z", reason: "BASELINE_ONLY"
  });
});
test("new valid signal alerts once", () => {
  assert.equal(evaluate(validSignal(), "older-id", now).notify, true);
  assert.equal(evaluate(validSignal(), "xau-h1-2026-11-27T15:00:00Z", now).reason, "DUPLICATE");
});
test("WAIT, missing id and expired signals never alert", () => {
  assert.equal(evaluate(validSignal({status:"WAIT"}), "older-id", now).notify, false);
  assert.equal(evaluate(validSignal({signalId:""}), "older-id", now).reason, "MISSING_SIGNAL_ID");
  assert.equal(evaluate(validSignal({signalValidUntil:"2026-11-27T15:00:00Z"}), "older-id", now).reason, "EXPIRED_OR_UNVERIFIABLE");
});
test("SELL signals use the same validated policy", () => {
  assert.equal(evaluate(validSignal({status:"SELL"}), "older-id", now).notify, true);
});
