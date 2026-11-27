const { backgroundPushConfigured } = require("../lib/push-utils");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });

  const enabled = backgroundPushConfigured();
  return res.status(200).json({
    ok: true,
    enabled,
    publicKey: enabled ? process.env.VAPID_PUBLIC_KEY : null,
    mode: enabled ? "BACKGROUND_WEB_PUSH" : "FOREGROUND_ONLY",
    message: enabled
      ? "Background push is configured."
      : "Background push is not configured; foreground notifications remain available."
  });
};
