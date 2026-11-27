const { createPublicKey, verify } = require("node:crypto");

const JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const EXPECTED = Object.freeze({
  issuer: "https://token.actions.githubusercontent.com",
  audience: "quant-pro-push-dispatch",
  repository: "zulfumetindg-sys/quant-pro-terminal",
  repositoryId: "1472907287",
  ref: "refs/heads/main",
  workflowRef: "zulfumetindg-sys/quant-pro-terminal/.github/workflows/background-push-dispatch.yml@refs/heads/main"
});

let jwksCache = null;
let jwksExpiresAt = 0;
let jwksRequest = null;

function decodeJsonPart(part) {
  if (typeof part !== "string" || part.length > 20000) throw new Error("INVALID_TOKEN");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

async function getJwks(fetchImpl, now) {
  if (jwksCache && now < jwksExpiresAt) return jwksCache;
  if (jwksRequest) return jwksRequest;
  jwksRequest = (async () => {
    const response = await fetchImpl(JWKS_URL, { headers: { Accept: "application/json" } });
    if (!response || !response.ok) throw new Error("JWKS_UNAVAILABLE");
    const data = await response.json();
    if (!data || !Array.isArray(data.keys) || data.keys.length < 1 || data.keys.length > 20) {
      throw new Error("INVALID_JWKS");
    }
    jwksCache = data.keys;
    jwksExpiresAt = now + 10 * 60 * 1000;
    return jwksCache;
  })();
  try {
    return await jwksRequest;
  } finally {
    jwksRequest = null;
  }
}

async function verifyGithubOidcToken(token, options = {}) {
  try {
    if (typeof token !== "string" || token.length > 20000) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const header = decodeJsonPart(parts[0]);
    const claims = decodeJsonPart(parts[1]);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return false;

    const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const expected = options.expected || EXPECTED;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== expected.issuer ||
        !audience.includes(expected.audience) ||
        claims.repository !== expected.repository ||
        String(claims.repository_id) !== expected.repositoryId ||
        claims.ref !== expected.ref ||
        claims.workflow_ref !== expected.workflowRef ||
        !["schedule", "workflow_dispatch"].includes(claims.event_name) ||
        !Number.isFinite(claims.exp) || claims.exp <= nowSec ||
        !Number.isFinite(claims.iat) || claims.iat > nowSec + 30 ||
        claims.iat < nowSec - 600 ||
        (Number.isFinite(claims.nbf) && claims.nbf > nowSec + 30)) {
      return false;
    }

    const fetchImpl = options.fetchImpl || fetch;
    const keys = await getJwks(fetchImpl, nowMs);
    const jwk = keys.find(key => key && key.kid === header.kid && key.kty === "RSA" &&
      (!key.use || key.use === "sig") && (!key.alg || key.alg === "RS256"));
    if (!jwk) return false;

    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    const signedContent = Buffer.from(parts[0] + "." + parts[1]);
    const signature = Buffer.from(parts[2], "base64url");
    return verify("RSA-SHA256", signedContent, publicKey, signature);
  } catch (_) {
    return false;
  }
}

async function verifyGithubOidcRequest(req, options = {}) {
  const authorization = req && req.headers && req.headers.authorization;
  const match = typeof authorization === "string" ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization) : null;
  if (!match) return false;
  return verifyGithubOidcToken(match[1], options);
}

module.exports = { verifyGithubOidcToken, verifyGithubOidcRequest, EXPECTED };
