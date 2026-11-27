"use strict";

const crypto = require("node:crypto");
const KEY = "quant-pro:xm-bridge:goldm:v1";
const MAX_BODY = 4096;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function validSnapshot(x, now = Date.now()) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  if (x.schemaVersion !== 1 || x.source !== "XM_MT5_READ_ONLY_EA") return false;
  if (x.symbol !== "GOLDm#") return false;
  if (x.accountCurrency !== "EUR" || !Number.isFinite(x.balance) || x.balance <= 0) return false;
  if (![x.bid, x.ask, x.contractSize, x.tickSize, x.tickValue, x.minVolume, x.volumeStep].every(Number.isFinite)) return false;
  if (x.bid <= 0 || x.ask < x.bid || x.contractSize <= 0 || x.tickSize <= 0 || x.tickValue <= 0 || x.minVolume <= 0 || x.volumeStep <= 0) return false;
  const t = Date.parse(x.timestamp);
  if (!Number.isFinite(t) || t > now + 5000 || now - t > 120000) return false;
  return true;
}

async function redis(path, env, operation) {
  const base = String(env.KV_REST_API_URL || "").replace(/\/+$/, "");
  const token = env.KV_REST_API_TOKEN;
  if (!base || !token) throw new Error("XM_BRIDGE_STORAGE_NOT_CONFIGURED");
  const response = await fetch(base + path, {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("XM_BRIDGE_STORAGE_" + response.status);
  const payload = await response.json();
  if (payload.error) throw new Error("XM_BRIDGE_STORAGE_COMMAND_FAILED");
  return payload.result;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  const expected = process.env.XM_BRIDGE_TOKEN;
  const authorization = req.headers && req.headers.authorization;
  const supplied = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7) : "";
  if (!expected || !safeEqual(supplied, expected)) {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }

  try {
    if (req.method === "POST") {
      const rawLength = Number(req.headers && req.headers["content-length"] || 0);
      if (rawLength > MAX_BODY) return res.status(413).json({ ok: false, error: "PAYLOAD_TOO_LARGE" });
      const snapshot = req.body;
      if (!validSnapshot(snapshot)) return res.status(400).json({ ok: false, error: "XM_SNAPSHOT_INVALID_OR_STALE" });
      const value = encodeURIComponent(JSON.stringify(snapshot));
      await redis("/set/" + encodeURIComponent(KEY) + "/" + value + "?EX=90", process.env, "write");
      return res.status(200).json({ ok: true, accepted: true, symbol: snapshot.symbol, receivedAt: new Date().toISOString(), tradingEnabled: false });
    }

    const raw = await redis("/get/" + encodeURIComponent(KEY), process.env, "read");
    if (!raw) return res.status(404).json({ ok: false, status: "WAITING_FOR_XM_DATA" });
    let snapshot;
    try { snapshot = JSON.parse(raw); } catch { return res.status(502).json({ ok: false, error: "XM_SNAPSHOT_CORRUPT" }); }
    if (!validSnapshot(snapshot)) return res.status(404).json({ ok: false, status: "XM_DATA_STALE" });
    return res.status(200).json({ ok: true, snapshot, tradingEnabled: false });
  } catch (error) {
    console.error("[xm-bridge] storage failure", { message: error.message });
    return res.status(503).json({ ok: false, error: "XM_BRIDGE_STORAGE_UNAVAILABLE" });
  }
};
