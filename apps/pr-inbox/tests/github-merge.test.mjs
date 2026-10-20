import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../review-protocol/core.ts";
import { mergeReviewedPullRequest as runMergeReviewedPullRequest } from "../github-merge.ts";

const reviewSecret = "test-only-review-secret-0123456789abcdef";
const reviewWorkerUrl = "https://review.example.invalid";
const reviewOrigin = new URL(reviewWorkerUrl).origin;
const repository = { id: 123456789, fullName: "example-owner/example-repository" };

function mergeReviewedPullRequest(context, input) {
  return runMergeReviewedPullRequest(context, { ...input, repository, reviewWorkerUrl });
}
const headSha = "0123456789abcdef0123456789abcdef01234567";
const baseSha = "89abcdef0123456789abcdef0123456789abcdef";
const mergeSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const landedSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const title = "Bump example from 1.0.0 to 1.0.1";
const snapshotHash = "c".repeat(64);
const reviewId = "d".repeat(64);
const identity = { repository: "example-owner/example-repository", pullRequest: 42, headSha, testedBaseSha: baseSha };
const verdict = {
  decision: "reviewable",
  standards: { status: "pass", findings: [] },
  changeIntent: { status: "pass", findings: [] },
};

async function createContext(options = {}) {
  const events = [];
  let writes = 0;
  let merged = options.initiallyMerged ?? false;
  const currentBaseSha = options.currentBaseSha ?? baseSha;
  const context = {
    app: { accounts: { reviewService: { fields: { hmacSecret: reviewSecret } } } },
    user: { accounts: { github: { method: "token", fields: { token: "test-github-token" } } } },
    signal: new AbortController().signal,
    async fetch(input, init = {}) {
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      if (url.origin === reviewOrigin) {
        events.push("status");
        return Response.json({ reviewId, identity, snapshotHash, titleHash: await sha256Hex(title), status: "complete", verdict });
      }
      if (url.origin !== "https://api.github.com") throw new Error("Unexpected network destination");
      if (url.pathname === "/repos/example-owner/example-repository/pulls/42/merge" && method === "PUT") {
        writes += 1;
        events.push("put");
        if (options.throwOnMerge) {
          if (options.mergeBeforeThrow) merged = true;
          throw new Error("Mock network failure after merge request");
        }
        if (options.rejectMerge) return Response.json({ message: "conflict" }, { status: 409 });
        merged = true;
        return Response.json({ merged: true, sha: landedSha });
      }
      if (method !== "GET") throw new Error("Unexpected GitHub write");
      if (url.pathname === "/repos/example-owner/example-repository/pulls/42") {
        events.push("pr:get");
        return Response.json({
          number: 42,
          state: merged ? "closed" : "open",
          title,
          draft: false,
          merged,
          mergeable: options.mergeable ?? true,
          mergeable_state: options.mergeableState ?? "clean",
          merged_at: merged ? "2026-01-02T00:00:00Z" : null,
          merge_commit_sha: merged ? landedSha : null,
          user: { login: "dependabot[bot]", type: "Bot" },
          head: { sha: writes > 0 ? (options.readBackHeadSha ?? headSha) : headSha, ref: "dependabot/example-1.0.1", repo: { id: 123456789, full_name: "example-owner/example-repository" } },
          base: { sha: writes > 0 ? (options.readBackBaseSha ?? currentBaseSha) : (merged ? (options.mergedBaseSha ?? landedSha) : currentBaseSha), ref: "main", repo: { id: 123456789, full_name: "example-owner/example-repository" } },
        });
      }
      if (url.pathname === "/repos/example-owner/example-repository") return Response.json({ id: 123456789, full_name: "example-owner/example-repository", default_branch: "main" });
      if (url.pathname === "/repos/example-owner/example-repository/actions/runs") {
        events.push("ci:runs");
        if (options.rateLimitCi) return Response.json({ message: "private rate-limit details" }, { status: 429, headers: { "retry-after": "30" } });
        const status = options.ciStatus ?? "completed";
        return Response.json({ total_count: 1, workflow_runs: [{ id: 10, event: "pull_request", status, conclusion: status === "completed" ? (options.ciConclusion ?? "success") : null, head_sha: mergeSha, check_suite_id: 9, created_at: "2026-01-02T00:00:00Z", pull_requests: [{ number: 42 }] }] });
      }
      if (url.pathname === `/repos/example-owner/example-repository/commits/${mergeSha}`) {
        events.push("ci:commit");
        return Response.json({ sha: mergeSha, parents: [{ sha: baseSha }, { sha: headSha }] });
      }
      if (url.pathname === `/repos/example-owner/example-repository/commits/${mergeSha}/check-runs`) {
        events.push("ci:checks");
        const conclusion = options.requiredCheckConclusion ?? "success";
        const check_runs = ["web", "tui", "qiskit-backend"].map((name, index) => ({ id: index + 1, name, head_sha: mergeSha, status: "completed", conclusion, check_suite: { id: 9 }, app: { slug: "github-actions" } }));
        return Response.json({ total_count: check_runs.length, check_runs });
      }
      throw new Error(`Unexpected API read ${url.pathname}`);
    },
  };
  return { context, events, writes: () => writes };
}

test("merge is guarded by a review identity, exact-base CI, fresh mergeability, and exact head SHA", async () => {
  const { context, events, writes } = await createContext();
  const result = await mergeReviewedPullRequest(context, { reviewId, identity, snapshotHash, titleHash: await sha256Hex(title) });

  assert.deepEqual({ result, writes: writes(), mergeBody: events.includes("put"), tail: events.slice(-4) }, {
    result: { status: "merged" },
    writes: 1,
    mergeBody: true,
    tail: ["status", "pr:get", "put", "pr:get"],
  });
});

test("a pre-existing merge is never confirmed without the exact response SHA", async () => {
  const baseMoved = await createContext({ initiallyMerged: true, mergedBaseSha: landedSha });
  const baseUnchanged = await createContext({ initiallyMerged: true, mergedBaseSha: baseSha });
  const titleHash = await sha256Hex(title);
  const [movedResult, unchangedResult] = await Promise.all([
    mergeReviewedPullRequest(baseMoved.context, { reviewId, identity, snapshotHash, titleHash }),
    mergeReviewedPullRequest(baseUnchanged.context, { reviewId, identity, snapshotHash, titleHash }),
  ]);

  assert.deepEqual([
    [movedResult.status, movedResult.failureCode, baseMoved.writes()],
    [unchangedResult.status, unchangedResult.failureCode, baseUnchanged.writes()],
  ], [
    ["blocked", "merge_outcome_unverified", 0],
    ["blocked", "merge_outcome_unverified", 0],
  ]);
});

test("pending or failed required CI never writes a merge", async () => {
  const pending = await createContext({ ciStatus: "in_progress" });
  const failed = await createContext({ requiredCheckConclusion: "failure" });
  const [pendingResult, failedResult] = await Promise.all([
    mergeReviewedPullRequest(pending.context, { reviewId, identity, snapshotHash, titleHash: await sha256Hex(title) }),
    mergeReviewedPullRequest(failed.context, { reviewId, identity, snapshotHash, titleHash: await sha256Hex(title) }),
  ]);

  assert.deepEqual([[pendingResult.status, pending.writes()], [failedResult.status, failedResult.failureCode, failed.writes()]], [
    ["retry", 0],
    ["blocked", "required_ci_failed", 0],
  ]);
});

test("a final-check rate limit backs off instead of becoming approval or failure", async () => {
  const limited = await createContext({ rateLimitCi: true });
  const result = await mergeReviewedPullRequest(limited.context, { reviewId, identity, snapshotHash, titleHash: await sha256Hex(title) });

  assert.deepEqual([result.status, result.retryAfterMs, limited.writes()], ["retry", 30_000, 0]);
});

test("a changed tested base or unmergeable PR cannot pass the merge guard", async () => {
  const changedBase = await createContext({ currentBaseSha: "fedcba9876543210fedcba9876543210fedcba98" });
  const unmergeable = await createContext({ mergeable: false });
  const [baseResult, mergeabilityResult] = await Promise.all([
    mergeReviewedPullRequest(changedBase.context, { reviewId, identity, snapshotHash, titleHash: await sha256Hex(title) }),
    mergeReviewedPullRequest(unmergeable.context, { reviewId, identity, snapshotHash, titleHash: await sha256Hex(title) }),
  ]);

  assert.deepEqual([[baseResult.status, baseResult.failureCode, changedBase.writes()], [mergeabilityResult.status, mergeabilityResult.failureCode, unmergeable.writes()]], [
    ["stale", "base_changed", 0],
    ["blocked", "pull_request_not_mergeable", 0],
  ]);
});

test("an ambiguous write is read back but never claimed landed without its merge SHA", async () => {
  const landed = await createContext({ throwOnMerge: true, mergeBeforeThrow: true });
  const unknown = await createContext({ throwOnMerge: true, mergeBeforeThrow: false });
  const [landedResult, unknownResult] = await Promise.all([
    mergeReviewedPullRequest(landed.context, { reviewId, identity, snapshotHash, titleHash: await sha256Hex(title) }),
    mergeReviewedPullRequest(unknown.context, { reviewId, identity, snapshotHash, titleHash: await sha256Hex(title) }),
  ]);

  assert.deepEqual([[landedResult.status, landedResult.failureCode, landed.writes()], [unknownResult.status, unknownResult.failureCode, unknown.writes()]], [
    ["blocked", "merge_outcome_unverified", 1],
    ["blocked", "merge_outcome_unknown", 1],
  ]);
});

test("an ambiguous merge read-back invalidates changed head or base", async () => {
  const headChanged = await createContext({ throwOnMerge: true, readBackHeadSha: "f".repeat(40) });
  const baseChanged = await createContext({ throwOnMerge: true, readBackBaseSha: "e".repeat(40) });
  const [headResult, baseResult] = await Promise.all([
    mergeReviewedPullRequest(headChanged.context, { reviewId, identity, snapshotHash, titleHash: await sha256Hex(title) }),
    mergeReviewedPullRequest(baseChanged.context, { reviewId, identity, snapshotHash, titleHash: await sha256Hex(title) }),
  ]);

  assert.deepEqual([
    [headResult.status, headResult.failureCode, headChanged.writes()],
    [baseResult.status, baseResult.failureCode, baseChanged.writes()],
  ], [
    ["stale", "head_changed", 1],
    ["stale", "base_changed", 1],
  ]);
});
