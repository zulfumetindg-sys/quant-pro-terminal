const webpush = require("web-push");
const { backgroundPushConfigured, encodePushBody } = require("./push-utils");
const { validateSignalIdentity } = require("../public/signal-notification-policy");

async function redis(command) {
  const response = await fetch(process.env.KV_REST_API_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.KV_REST_API_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error("PUSH_STORAGE_UNAVAILABLE");
  return result.result;
}

function authorized(req) {
  const expected = "Bearer " + (process.env.CRON_SECRET || "");
  const actual = req.headers.authorization || "";
  return expected.length > 20 && actual.length === expected.length && actual === expected;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (!backgroundPushConfigured()) {
    return res.status(200).json({ ok: true, status: "DISABLED_NO_OP" });
  }

  try {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    const origin = process.env.VERCEL_URL
      ? "https://" + process.env.VERCEL_URL
      : process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL
        : null;
    if (!origin) return res.status(503).json({ ok: false, error: "DEPLOYMENT_ORIGIN_UNAVAILABLE" });

    const response = await fetch(origin + "/api/signal-engine", {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok || !payload.signal) {
      return res.status(502).json({ ok: false, error: "SIGNAL_SOURCE_UNAVAILABLE" });
    }

    const signal = payload.signal;
    const identity = validateSignalIdentity(signal, Date.now());
    if (!identity.valid) {
      return res.status(200).json({ ok: true, status: "NO_VALID_NEW_SIGNAL", reason: identity.reason });
    }

    const lastId = await redis(["GET", "quant:push:last-signal-id"]);
    if (!lastId) {
      await redis(["SET", "quant:push:last-signal-id", signal.signalId, "EX", "604800"]);
      return res.status(200).json({ ok: true, status: "BASELINE_SET", delivered: 0 });
    }
    if (lastId === signal.signalId) {
      return res.status(200).json({ ok: true, status: "NO_NEW_SIGNAL", delivered: 0 });
    }

    const keys = await redis(["SMEMBERS", "quant:push:subscriptions"]);
    const subscriptionKeys = Array.isArray(keys) ? keys.slice(0, 500) : [];
    const body = JSON.stringify(encodePushBody(signal));
    let delivered = 0;
    let removed = 0;
    let failed = 0;

    for (const key of subscriptionKeys) {
      const raw = await redis(["GET", key]);
      if (!raw) {
        await redis(["SREM", "quant:push:subscriptions", key]);
        removed++;
        continue;
      }
      let subscription;
      try { subscription = JSON.parse(raw); } catch (_) {
        await redis(["DEL", key]);
        await redis(["SREM", "quant:push:subscriptions", key]);
        removed++;
        continue;
      }
      try {
        await webpush.sendNotification(subscription, body, { TTL: 3600 });
        delivered++;
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await redis(["DEL", key]);
          await redis(["SREM", "quant:push:subscriptions", key]);
          removed++;
        } else {
          failed++;
        }
      }
    }

    // Keep the signal pending if any endpoint failed transiently. The next hourly
    // run retries; notification tags prevent repeated visible alerts on devices.
    if (failed === 0) {
      await redis(["SET", "quant:push:last-signal-id", signal.signalId, "EX", "604800"]);
    }
    return res.status(200).json({
      ok: true,
      status: "DISPATCHED",
      signalId: signal.signalId,
      subscriptionCount: subscriptionKeys.length,
      delivered,
      removed,
      failed
    });
  } catch (_) {
    return res.status(503).json({ ok: false, error: "PUSH_DISPATCH_FAILED" });
  }
};
