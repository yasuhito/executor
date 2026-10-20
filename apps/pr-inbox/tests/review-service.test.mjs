import assert from "node:assert/strict";
import test from "node:test";
import { invalidateReview, readReviewStatus, submitReview } from "../review-service.ts";
import { verifyRequest } from "../review-protocol/auth.ts";

const secret = "test-only-review-secret-0123456789abcdef";
const pullRequestUrl = "https://github.com/example-owner/example-repository/pull/42";
const workerUrl = "https://review.example.invalid";
const repository = "example-owner/example-repository";
const operationId = "b".repeat(64);
const reviewId = "a".repeat(64);
const context = {
  app: { accounts: { reviewService: { fields: { hmacSecret: secret } } } },
  signal: new AbortController().signal,
  fetch: async () => Response.json({ status: "replayed_request" }, { status: 409 }),
};

function captureContext(responseValue, responseStatus = 200) {
  const captured = { path: "", body: null, signed: false };
  const signed = {
    ...context,
    async fetch(input, init) {
      const request = new Request(String(input), init);
      captured.path = new URL(request.url).pathname;
      captured.body = JSON.parse(String(init.body));
      captured.signed = await verifyRequest(secret, request, new TextEncoder().encode(String(init.body)));
      return Response.json(responseValue, { status: responseStatus });
    },
  };
  return { captured, context: signed };
}

test("Executor signs only the exact PR URL and technical operation identity", async () => {
  const { captured, context: signedContext } = captureContext({ reviewId, status: "awaiting_ci" }, 202);
  await submitReview(signedContext, workerUrl, pullRequestUrl, operationId, repository);

  assert.deepEqual(captured, {
    path: "/v1/review",
    body: { pullRequestUrl, operationId },
    signed: true,
  });
});

test("status polling carries only the opaque review operation ID", async () => {
  const { captured, context: signedContext } = captureContext({ reviewId, status: "awaiting_ci" }, 202);
  await readReviewStatus(signedContext, workerUrl, reviewId);

  assert.deepEqual(captured, {
    path: "/v1/status",
    body: { reviewId },
    signed: true,
  });
});

test("invalidation binds only the review operation ID and fresh lease proof", async () => {
  const leaseExpiresAt = Date.now() + 600_000;
  const { captured, context: signedContext } = captureContext({ reviewId, status: "stale" }, 409);
  await invalidateReview(signedContext, workerUrl, reviewId, leaseExpiresAt);

  assert.deepEqual(captured, {
    path: "/v1/invalidate",
    body: { reviewId, leaseExpiresAt },
    signed: true,
  });
});

test("malicious or unsupported URLs are rejected before any request", async () => {
  let requests = 0;
  const noNetwork = { ...context, fetch: async () => { requests += 1; return Response.json({ reviewId, status: "awaiting_ci" }, { status: 202 }); } };
  const failures = await Promise.all([
    submitReview(noNetwork, workerUrl, "https://github.com.evil.example/example-owner/example-repository/pull/42", operationId, repository).then(() => false, () => true),
    submitReview(noNetwork, workerUrl, "https://github.com/example-owner/example-repository/pull/42?redirect=https://evil.example", operationId, repository).then(() => false, () => true),
    submitReview(noNetwork, workerUrl, "https://github.com/example-owner/example-repository/pull/42", "invalid-operation-id", repository).then(() => false, () => true),
  ]);

  assert.deepEqual([failures, requests], [Array(3).fill(true), 0]);
});

test("a durable nonce replay is surfaced without echoing request data", async () => {
  await assert.rejects(submitReview(context, workerUrl, pullRequestUrl, operationId, repository), /replayed request nonce/i);
});
