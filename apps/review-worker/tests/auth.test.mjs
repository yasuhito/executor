import assert from "node:assert/strict";
import test from "node:test";
import { signRequest, verifyRequest } from "../src/auth.ts";

const secret = "local-test-shared-key-with-at-least-32-bytes";
const path = "/v1/review";
const body = new TextEncoder().encode("{\"identity\":\"fixture\"}");
const timestamp = 1_800_000_000;
const nonce = "11111111-2222-4333-8444-555555555555";

async function signedRequest({ requestBody = body, requestPath = path, at = timestamp } = {}) {
  const signed = await signRequest(secret, "POST", requestPath, requestBody, at, nonce);
  return new Request(`https://review.example.invalid${requestPath}`, {
    method: "POST",
    headers: {
      "x-executor-timestamp": signed.timestamp,
      "x-executor-nonce": signed.nonce,
      "x-executor-signature": signed.signature,
    },
    body: requestBody,
  });
}

test("authenticates the exact method, path, body, timestamp, and nonce", async () => {
  const request = await signedRequest();
  const valid = await verifyRequest(secret, request, body, timestamp);

  assert.equal(valid, true);
});

test("rejects a body altered after its signature was made", async () => {
  const request = await signedRequest();
  const altered = new TextEncoder().encode("{\"identity\":\"changed\"}");
  const valid = await verifyRequest(secret, request, altered, timestamp);

  assert.equal(valid, false);
});

test("rejects authenticated requests outside the five-minute window", async () => {
  const request = await signedRequest();
  const valid = await verifyRequest(secret, request, body, timestamp + 301);

  assert.equal(valid, false);
});

test("rejects malformed signatures and nonces", async () => {
  const request = await signedRequest();
  request.headers.set("x-executor-nonce", "not-a-uuid");
  const valid = await verifyRequest(secret, request, body, timestamp);

  assert.equal(valid, false);
});

test("rejects signatures made with a different HMAC secret", async () => {
  const request = await signedRequest();
  const valid = await verifyRequest(`${secret}-wrong`, request, body, timestamp);

  assert.equal(valid, false);
});

test("binds authentication to the exact Worker endpoint path", async () => {
  const signed = await signedRequest({ requestPath: "/v1/status" });
  const request = new Request(`https://review.example.invalid${path}`, {
    method: "POST",
    headers: signed.headers,
    body,
  });
  const valid = await verifyRequest(secret, request, body, timestamp);

  assert.equal(valid, false);
});
