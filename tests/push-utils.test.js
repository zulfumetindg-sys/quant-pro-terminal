const test = require("node:test");
const assert = require("node:assert/strict");
const {
  backgroundPushConfigured,
  subscriptionEndpointAllowed,
  validateSubscription,
  subscriptionKey,
  encodePushBody
} = require("../lib/push-utils");

const validSubscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-token",
  keys: { p256dh: "B".repeat(65), auth: "A".repeat(24) }
};

test("background push remains disabled until every required setting and feature flag exists", () => {
  assert.equal(backgroundPushConfigured({}), false);
  assert.equal(backgroundPushConfigured({
    ENABLE_BACKGROUND_PUSH: "true",
    VAPID_PUBLIC_KEY: "public",
    VAPID_PRIVATE_KEY: "private",
    VAPID_SUBJECT: "mailto:ops@example.org",
    KV_REST_API_URL: "https://kv.example",
    KV_REST_API_TOKEN: "token"
  }), true);
  assert.equal(backgroundPushConfigured({
    ENABLE_BACKGROUND_PUSH: "false",
    VAPID_PUBLIC_KEY: "public",
    VAPID_PRIVATE_KEY: "private",
    VAPID_SUBJECT: "mailto:ops@example.org",
    KV_REST_API_URL: "https://kv.example",
    KV_REST_API_TOKEN: "token"
  }), false);
});

test("only known HTTPS browser push providers are accepted", () => {
  assert.equal(subscriptionEndpointAllowed(validSubscription.endpoint), true);
  assert.equal(subscriptionEndpointAllowed("http://fcm.googleapis.com/token"), false);
  assert.equal(subscriptionEndpointAllowed("https://127.0.0.1/internal"), false);
  assert.equal(subscriptionEndpointAllowed("https://attacker.example/push"), false);
});

test("subscription payload shape and key bounds are validated", () => {
  assert.equal(validateSubscription(validSubscription).valid, true);
  assert.equal(validateSubscription({ ...validSubscription, endpoint: "https://attacker.example/x" }).valid, false);
  assert.equal(validateSubscription({ ...validSubscription, keys: {} }).valid, false);
  assert.equal(validateSubscription(null).valid, false);
});

test("subscription storage key does not expose endpoint", () => {
  const key = subscriptionKey(validSubscription.endpoint);
  assert.match(key, /^quant:push:sub:[a-f0-9]{64}$/);
  assert.equal(key.includes("fcm"), false);
});

test("push payload contains signal identity and no order action", () => {
  const payload = encodePushBody({
    status: "BUY",
    signalId: "XAUUSD:BUY:1795791600000",
    entry: 3600,
    sl: 3580,
    tp: 3640
  });
  assert.equal(payload.title, "QUANT PRO · XAUUSD AL");
  assert.equal(payload.tag, "quant-pro-XAUUSD:BUY:1795791600000");
  assert.equal(payload.renotify, false);
  assert.equal(payload.data.url, "/");
  assert.equal("order" in payload, false);
});
