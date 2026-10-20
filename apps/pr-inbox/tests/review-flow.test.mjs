import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../review-protocol/core.ts";
import { processDependabotPullRequest as runProcessDependabotPullRequest } from "../review-flow.ts";

const repository = "example-owner/example-repository";
const headSha = "0123456789abcdef0123456789abcdef01234567";
const baseSha = "89abcdef0123456789abcdef0123456789abcdef";

function processDependabotPullRequest(pullRequest, expectedHead, expectedBase, deliveryId, port) {
  return runProcessDependabotPullRequest(repository, pullRequest, expectedHead, expectedBase, deliveryId, port);
}
const title = "Bump example from 1.0.0 to 1.0.1";
const pullRequest = (base = baseSha, patch = {}) => ({
  repository: "example-owner/example-repository",
  pullRequest: 42,
  state: "open",
  authorLogin: "dependabot[bot]",
  authorType: "Bot",
  headRepository: "example-owner/example-repository",
  baseRepository: "example-owner/example-repository",
  headSha,
  baseSha: base,
  headRef: "dependabot/example-1.0.1",
  baseRef: "main",
  defaultBranch: "main",
  title,
  draft: false,
  merged: false,
  mergeable: true,
  mergeableState: "clean",
  mergedAt: null,
  mergeCommitSha: null,
  ...patch,
});
const passVerdict = {
  decision: "reviewable",
  standards: { status: "pass", findings: [] },
  changeIntent: { status: "pass", findings: [] },
};
const concernVerdict = {
  decision: "needs-attention",
  standards: { status: "findings", findings: [{ path: "Cargo.toml", summary: "Unexpected change", evidence: "A non-dependency section changed." }] },
  changeIntent: { status: "pass", findings: [] },
};

async function response(status = "complete", options = {}) {
  const operationId = options.operationId ?? await sha256Hex("executor-dependabot-review-v1:event:base:0");
  return {
    status,
    reviewId: await sha256Hex(`executor-review-operation-v1:${operationId}`),
    ...(options.candidate === undefined ? {} : { candidate: options.candidate }),
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    ...(options.snapshotHash === undefined ? {} : { snapshotHash: options.snapshotHash }),
    ...(options.titleHash === undefined ? {} : { titleHash: options.titleHash }),
    ...(options.verdict === undefined ? {} : { verdict: options.verdict }),
    ...(options.failureCode === undefined ? {} : { failureCode: options.failureCode }),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
  };
}

async function operationId(deliveryId = "11111111-2222-4333-8444-555555555555", baseAttempt = 0) {
  return sha256Hex(`executor-dependabot-review-v1:${deliveryId}:base:${baseAttempt}`);
}

async function passedReview(base = baseSha, verdict = passVerdict, opId) {
  return response("complete", {
    operationId: opId ?? await operationId(),
    candidate: { headSha, baseSha: base },
    identity: { repository: "example-owner/example-repository", pullRequest: 42, headSha, testedBaseSha: base },
    snapshotHash: "a".repeat(64),
    titleHash: await sha256Hex(title),
    verdict,
  });
}

function port(overrides = {}) {
  return {
    readPullRequest: async () => pullRequest(),
    submitReview: async () => null,
    readReview: async () => null,
    invalidate: async () => {},
    mergeVerified: async () => ({ status: "merged" }),
    renewLease: async () => true,
    sleep: async () => {},
    ...overrides,
  };
}

test("review service receives only the canonical PR URL and operation ID before guarded merge", async () => {
  const calls = [];
  const serviceResult = await passedReview(baseSha, passVerdict, await operationId());
  const result = await processDependabotPullRequest(42, headSha, baseSha, "11111111-2222-4333-8444-555555555555", port({
    submitReview: async (...args) => { calls.push(args); return serviceResult; },
  }));

  assert.deepEqual({ calls, state: result.state, kind: result.kind }, {
    calls: [["https://github.com/example-owner/example-repository/pull/42", await sha256Hex("executor-dependabot-review-v1:11111111-2222-4333-8444-555555555555:base:0")]],
    state: "complete",
    kind: "merged",
  });
});

test("a completed review waits for polling and merges only after a reviewable two-axis result", async () => {
  const calls = [];
  const completed = await passedReview();
  const result = await processDependabotPullRequest(42, headSha, baseSha, "11111111-2222-4333-8444-555555555555", port({
    submitReview: async () => response("awaiting_ci", { operationId: await operationId(), candidate: { headSha, baseSha } }),
    readReview: async (id) => { calls.push(id); return completed; },
    sleep: async () => { calls.push("sleep"); },
    mergeVerified: async (input) => { calls.push(input.snapshotHash); return { status: "merged" }; },
  }));

  assert.deepEqual({ state: result.state, kind: result.kind, calls: [calls[0], calls[1] === completed.reviewId, calls[2] === completed.snapshotHash] }, {
    state: "complete",
    kind: "merged",
    calls: ["sleep", true, true],
  });
});

test("a review finding blocks merge and records an actionable result", async () => {
  let merges = 0;
  const result = await processDependabotPullRequest(42, headSha, baseSha, "11111111-2222-4333-8444-555555555555", port({
    submitReview: async () => passedReview(baseSha, concernVerdict, await operationId()),
    mergeVerified: async () => { merges += 1; return { status: "merged" }; },
  }));

  assert.deepEqual({ merges, state: result.state, kind: result.kind, decision: result.decision }, {
    merges: 0,
    state: "needs-attention",
    kind: "needs-attention",
    decision: "needs-attention",
  });
});

test("a base change while CI is pending invalidates the result and stops as stale", async () => {
  const submitted = [];
  const invalidated = [];
  let reads = 0;
  const secondBase = "fedcba9876543210fedcba9876543210fedcba98";
  const result = await processDependabotPullRequest(42, headSha, baseSha, "11111111-2222-4333-8444-555555555555", port({
    readPullRequest: async () => { reads += 1; return pullRequest(reads === 1 ? baseSha : secondBase); },
    submitReview: async (url, operationId) => {
      submitted.push([url, operationId]);
      return response("awaiting_ci", { operationId, candidate: { headSha, baseSha } });
    },
    invalidate: async (id) => { invalidated.push(id); },
  }));

  assert.deepEqual({ state: result.state, kind: result.kind, failureCode: result.failureCode, submissions: submitted.length, invalidated: invalidated.length }, {
    state: "stale",
    kind: "stale",
    failureCode: "base_changed",
    submissions: 1,
    invalidated: 1,
  });
});

test("a review bound to another tested base is stale and cannot merge", async () => {
  let merges = 0;
  const otherBase = "fedcba9876543210fedcba9876543210fedcba98";
  const result = await processDependabotPullRequest(42, headSha, baseSha, "11111111-2222-4333-8444-555555555555", port({
    submitReview: async () => passedReview(otherBase, passVerdict, await operationId()),
    mergeVerified: async () => { merges += 1; return { status: "merged" }; },
  }));

  assert.deepEqual([merges, result.state, result.failureCode], [0, "stale", "base_changed"]);
});

test("a queue item without a valid webhook base cannot be reviewed or merged", async () => {
  let submissions = 0;
  const result = await processDependabotPullRequest(42, headSha, null, "11111111-2222-4333-8444-555555555555", port({
    submitReview: async () => { submissions += 1; return passedReview(baseSha, passVerdict, await operationId()); },
  }));

  assert.deepEqual([submissions, result.state, result.failureCode], [0, "needs-attention", "webhook_identity_unproven"]);
});

test("a stale webhook head never reaches the reviewer or merge adapter", async () => {
  let submissions = 0;
  const result = await processDependabotPullRequest(42, "f".repeat(40), baseSha, "11111111-2222-4333-8444-555555555555", port({
    submitReview: async () => { submissions += 1; return passedReview(baseSha, passVerdict, await operationId()); },
  }));

  assert.deepEqual([submissions, result.state, result.kind, result.failureCode], [0, "stale", "stale", "head_changed"]);
});
