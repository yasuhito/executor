import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signRequest } from "../src/auth.ts";

const secret = "test-only-review-secret-0123456789abcdef";
const reviewId = "a".repeat(64);
const operationId = "b".repeat(64);

async function signed(mf, path, value, nonce) {
  const body = JSON.stringify(value);
  const signature = await signRequest(
    secret,
    "POST",
    path,
    new TextEncoder().encode(body),
    Math.floor(Date.now() / 1_000),
    nonce,
  );
  const response = await mf.dispatchFetch(`https://review.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-executor-timestamp": signature.timestamp,
      "x-executor-nonce": signature.nonce,
      "x-executor-signature": signature.signature,
    },
    body,
  });
  return { status: response.status, body: await response.json() };
}

async function setup(t, { omitReviewHmacSecret = false } = {}) {
  const persistencePath = await mkdtemp(join(tmpdir(), "executor-review-worker-http-"));
  const scriptPath = join(persistencePath, "worker.mjs");
  await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: scriptPath,
    external: ["cloudflare:*", "node:*"],
    conditions: ["workerd", "worker", "browser"],
    logLevel: "silent",
  });
  let outbound = 0;
  const bindings = {
    REPOSITORIES: JSON.stringify([{ fullName: "example-owner/example-repository", id: 123456789 }]),
    CREDENTIAL_BOOTSTRAP_SECRET: "test-only-bootstrap-secret-0123456789",
    CREDENTIAL_ENCRYPTION_KEY: "test-only-encryption-key-0123456789",
    OPENAI_MODEL: "gpt-6.1-sol",
    ...(omitReviewHmacSecret ? {} : { REVIEW_HMAC_SECRET: secret }),
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      modulesRoot: persistencePath,
      scriptPath,
      compatibilityDate: "2026-10-18",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        REVIEWS: { className: "ReviewDurableObject", useSQLite: true },
        CREDENTIALS: { className: "CredentialDurableObject", useSQLite: true },
      },
      bindings,
      outboundService: () => {
        outbound += 1;
        throw new Error("No external calls in protocol tests");
      },
    }),
  );
  t.after(async () => {
    await mf.dispose();
    await rm(persistencePath, { recursive: true, force: true });
  });
  return { mf, outbound: () => outbound };
}

test("health exposes only availability when runtime configuration is present", {
  timeout: 45_000,
}, async (t) => {
  const { mf } = await setup(t);
  const response = await mf.dispatchFetch("https://review.example/health");

  assert.deepEqual([response.status, await response.json()], [200, { status: "ok" }]);
});

test("health rejects missing runtime secrets without exposing binding details", {
  timeout: 45_000,
}, async (t) => {
  const { mf } = await setup(t, { omitReviewHmacSecret: true });
  const response = await mf.dispatchFetch("https://review.example/health");

  assert.deepEqual(
    [response.status, await response.json()],
    [503, { status: "configuration_unavailable" }],
  );
});

test("a missing review HMAC secret rejects requests with a nonce without crashing", {
  timeout: 45_000,
}, async (t) => {
  const { mf, outbound } = await setup(t, { omitReviewHmacSecret: true });
  const response = await mf.dispatchFetch("https://review.example/v1/review", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-executor-nonce": "550e8400-e29b-41d4-a716-446655440000",
    },
    body: "{}",
  });

  assert.deepEqual(
    [response.status, await response.json(), outbound()],
    [401, { status: "unauthorized" }, 0],
  );
});

test("the URL-only Worker rejects nonce replays and stale lease proofs", {
  timeout: 45_000,
}, async (t) => {
  const { mf } = await setup(t);
  const status = { reviewId };
  const first = await signed(mf, "/v1/status", status, "550e8400-e29b-41d4-a716-446655440000");
  const replay = await signed(mf, "/v1/status", status, "550e8400-e29b-41d4-a716-446655440000");
  const expired = await signed(
    mf,
    "/v1/invalidate",
    { reviewId, leaseExpiresAt: Date.now() - 1 },
    "550e8400-e29b-41d4-a716-446655440001",
  );
  const tooSoon = await signed(
    mf,
    "/v1/invalidate",
    { reviewId, leaseExpiresAt: Date.now() + 7 * 60_000 },
    "550e8400-e29b-41d4-a716-446655440002",
  );
  const tooFar = await signed(
    mf,
    "/v1/invalidate",
    { reviewId, leaseExpiresAt: Date.now() + 16 * 60_000 },
    "550e8400-e29b-41d4-a716-446655440003",
  );
  const fresh = await signed(
    mf,
    "/v1/invalidate",
    { reviewId, leaseExpiresAt: Date.now() + 10 * 60_000 },
    "550e8400-e29b-41d4-a716-446655440004",
  );

  assert.deepEqual(
    [
      [first.status, first.body.status],
      [replay.status, replay.body.status],
      [expired.status, expired.body.status],
      [tooSoon.status, tooSoon.body.status],
      [tooFar.status, tooFar.body.status],
      [fresh.status, fresh.body.status],
    ],
    [
      [404, "not_found"],
      [409, "replayed_request"],
      [400, "invalid_review_request"],
      [400, "invalid_review_request"],
      [400, "invalid_review_request"],
      [404, "not_found"],
    ],
  );
});

test("malicious URLs and snapshot-shaped requests are rejected before GitHub fetch", {
  timeout: 45_000,
}, async (t) => {
  const { mf, outbound } = await setup(t);
  const malicious = await signed(
    mf,
    "/v1/review",
    {
      pullRequestUrl: "https://github.com.evil.example/example-owner/example-repository/pull/42",
      operationId,
    },
    "550e8400-e29b-41d4-a716-446655440010",
  );
  const unknownRepository = await signed(
    mf,
    "/v1/review",
    {
      pullRequestUrl: "https://github.com/example-other/repository/pull/42",
      operationId,
    },
    "550e8400-e29b-41d4-a716-446655440011",
  );
  const snapshot = await signed(
    mf,
    "/v1/review",
    {
      identity: {
        repository: "example-owner/example-repository",
        pullRequest: 42,
        headSha: "0".repeat(40),
        testedBaseSha: "1".repeat(40),
      },
      title: "injected",
      files: [{ path: "Cargo.toml", status: "modified", patch: "+secret" }],
    },
    "550e8400-e29b-41d4-a716-446655440012",
  );

  assert.deepEqual(
    [
      [malicious.status, malicious.body.status],
      [unknownRepository.status, unknownRepository.body.status],
      [snapshot.status, snapshot.body.status],
      outbound(),
    ],
    [
      [400, "invalid_review_request"],
      [400, "invalid_review_request"],
      [400, "invalid_review_request"],
      0,
    ],
  );
});
