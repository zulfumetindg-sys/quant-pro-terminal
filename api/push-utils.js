const { createHash } = require("node:crypto");

const SUBSCRIPTION_TTL_SECONDS = 60 * 24 * 60 * 60;
const MAX_SUBSCRIPTIONS = 500;

function backgroundPushConfigured(env = process.env) {
  return env.ENABLE_BACKGROUND_PUSH === "true" &&
    !!env.VAPID_PUBLIC_KEY &&
    !!env.VAPID_PRIVATE_KEY &&
    !!env.VAPID_SUBJECT &&
    !!env.KV_REST_API_URL &&
    !!env.KV_REST_API_TOKEN &&
    !!env.CRON_SECRET;
}

function subscriptionEndpointAllowed(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return host === "fcm.googleapis.com" ||
      host.endsWith(".fcm.googleapis.com") ||
      host === "updates.push.services.mozilla.com" ||
      host === "push.services.mozilla.com" ||
      host === "web.push.apple.com" ||
      host.endsWith(".notify.windows.com");
  } catch (_) {
    return false;
  }
}

function validateSubscription(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, reason: "INVALID_SUBSCRIPTION" };
  }
  if (typeof value.endpoint !== "string" ||
      value.endpoint.length > 2048 ||
      !subscriptionEndpointAllowed(value.endpoint)) {
    return { valid: false, reason: "INVALID_PUSH_ENDPOINT" };
  }
  const keys = value.keys;
  if (!keys || typeof keys !== "object" ||
      typeof keys.p256dh !== "string" || keys.p256dh.length < 20 || keys.p256dh.length > 256 ||
      typeof keys.auth !== "string" || keys.auth.length < 8 || keys.auth.length > 128) {
    return { valid: false, reason: "INVALID_PUSH_KEYS" };
  }
  return { valid: true };
}

function subscriptionKey(endpoint) {
  return "quant:push:sub:" + createHash("sha256").update(endpoint).digest("hex");
}

function encodePushBody(signal) {
  const side = signal.status === "BUY" ? "AL" : "SAT";
  return {
    title: "QUANT PRO · XAUUSD " + side,
    body: "Yeni H1 + tamamlanmış H4 sinyali. Giriş: " +
      (signal.entry ?? "—") + " · SL: " + (signal.sl ?? "—") +
      " · TP: " + (signal.tp ?? "—"),
    tag: "quant-pro-" + signal.signalId,
    data: { url: "/" },
    renotify: false
  };
}

module.exports = {
  SUBSCRIPTION_TTL_SECONDS,
  MAX_SUBSCRIPTIONS,
  backgroundPushConfigured,
  subscriptionEndpointAllowed,
  validateSubscription,
  subscriptionKey,
  encodePushBody
};
