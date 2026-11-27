const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, sign } = require("node:crypto");
const { verifyGithubOidcToken, EXPECTED } = require("../lib/push-auth");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "unit-test-key", use: "sig", alg: "RS256" };

function makeToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "unit-test-key" })).toString("base64url");
  const claims = {
    iss: EXPECTED.issuer,
    aud: EXPECTED.audience,
    repository: EXPECTED.repository,
    repository_id: EXPECTED.repositoryId,
    ref: EXPECTED.ref,
    workflow_ref: EXPECTED.workflowRef,
    event_name: "schedule",
    iat: now,
    exp: now + 300,
    ...overrides
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = header + "." + payload;
  return signingInput + "." + sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
}

const options = {
  fetchImpl: async url => ({
    ok: url === "https://token.actions.githubusercontent.com/.well-known/jwks",
    json: async () => ({ keys: [jwk] })
  })
};

test("GitHub OIDC accepts a correctly signed token from the pinned workflow", async () => {
  assert.equal(await verifyGithubOidcToken(makeToken(), options), true);
});

test("GitHub OIDC rejects a token from another repository, ref, workflow, or event", async () => {
  assert.equal(await verifyGithubOidcToken(makeToken({ repository: "attacker/repo" }), options), false);
  assert.equal(await verifyGithubOidcToken(makeToken({ ref: "refs/heads/feature" }), options), false);
  assert.equal(await verifyGithubOidcToken(makeToken({ workflow_ref: "attacker/workflow.yml@refs/heads/main" }), options), false);
  assert.equal(await verifyGithubOidcToken(makeToken({ event_name: "pull_request" }), options), false);
});

test("GitHub OIDC rejects expired, wrong-audience, and malformed tokens", async () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await verifyGithubOidcToken(makeToken({ exp: now - 1 }), options), false);
  assert.equal(await verifyGithubOidcToken(makeToken({ aud: "other-audience" }), options), false);
  assert.equal(await verifyGithubOidcToken("not-a-jwt", options), false);
});

test("GitHub OIDC rejects an invalid signature", async () => {
  const token = makeToken();
  const parts = token.split(".");
  parts[2] = Buffer.from("invalid-signature").toString("base64url");
  assert.equal(await verifyGithubOidcToken(parts.join("."), options), false);
});
