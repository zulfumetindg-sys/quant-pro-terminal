const {
  SUBSCRIPTION_TTL_SECONDS,
  MAX_SUBSCRIPTIONS,
  backgroundPushConfigured,
  validateSubscription,
  subscriptionKey
} = require("./push-utils");

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

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Vary", "Origin");

  if (req.method !== "POST" && req.method !== "DELETE") {
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }
  if (!backgroundPushConfigured()) {
    return res.status(503).json({ ok: false, error: "BACKGROUND_PUSH_NOT_CONFIGURED" });
  }

  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const checked = validateSubscription(body);
    if (!checked.valid) return res.status(400).json({ ok: false, error: checked.reason });

    const key = subscriptionKey(body.endpoint);
    if (req.method === "DELETE") {
      await redis(["DEL", key]);
      await redis(["SREM", "quant:push:subscriptions", key]);
      return res.status(200).json({ ok: true, removed: true });
    }

    const members = await redis(["SCARD", "quant:push:subscriptions"]);
    const exists = await redis(["SISMEMBER", "quant:push:subscriptions", key]);
    if (!exists && Number(members) >= MAX_SUBSCRIPTIONS) {
      return res.status(429).json({ ok: false, error: "SUBSCRIPTION_LIMIT_REACHED" });
    }

    await redis(["SET", key, JSON.stringify(body), "EX", String(SUBSCRIPTION_TTL_SECONDS)]);
    await redis(["SADD", "quant:push:subscriptions", key]);
    await redis(["EXPIRE", "quant:push:subscriptions", String(SUBSCRIPTION_TTL_SECONDS)]);
    return res.status(200).json({ ok: true, saved: true });
  } catch (_) {
    return res.status(503).json({ ok: false, error: "PUSH_STORAGE_UNAVAILABLE" });
  }
};
