const test = require("node:test");
const assert = require("node:assert/strict");
const { readSignalEnginePayload } = require("../api/push-dispatch").__test;

test("push dispatcher reads the signal engine in-process", async () => {
  const expected = { ok: true, signal: { status: "WAIT", reason: "MARKET_CLOSED" } };
  const handler = async (req, res) => {
    assert.equal(req.method, "GET");
    res.status(200).json(expected);
  };

  assert.deepEqual(await readSignalEnginePayload(handler), expected);
});

test("push dispatcher rejects a failed signal-engine response", async () => {
  const handler = async (_req, res) => {
    res.status(502).json({ ok: false, error: "PROVIDER_UNAVAILABLE" });
  };

  await assert.rejects(
    () => readSignalEnginePayload(handler),
    /SIGNAL_SOURCE_UNAVAILABLE/
  );
});

test("push dispatcher rejects payloads without a signal", async () => {
  const handler = async (_req, res) => {
    res.status(200).json({ ok: true });
  };

  await assert.rejects(
    () => readSignalEnginePayload(handler),
    /SIGNAL_SOURCE_UNAVAILABLE/
  );
});
