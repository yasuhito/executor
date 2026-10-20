import assert from "node:assert/strict";
import test from "node:test";
import { proveRequiredCi } from "../src/ci-proof.ts";

const headSha = "0123456789abcdef0123456789abcdef01234567";
const baseSha = "89abcdef0123456789abcdef0123456789abcdef";
const mergeSha = "fedcba9876543210fedcba9876543210fedcba98";
const run = {
  id: 7,
  event: "pull_request",
  status: "completed",
  conclusion: "success",
  headSha: mergeSha,
  checkSuiteId: 19,
  createdAt: "2026-01-01T00:00:00Z",
  pullRequests: [{ number: 42 }],
};
const commit = { sha: mergeSha, parents: [baseSha, headSha] };
const evidence = { testedBaseSha: baseSha, testedHeadSha: headSha, mergeSha, runId: 7 };
const checkRuns = ["web", "tui", "qiskit-backend"].map((name, index) => ({
  id: index + 1,
  name,
  headSha: mergeSha,
  status: "completed",
  conclusion: "success",
  checkSuiteId: 19,
  appSlug: "github-actions",
}));

function prove(overrides = {}) {
  return proveRequiredCi({
    pullRequestNumber: 42,
    headSha,
    baseSha,
    runs: [run],
    commits: [commit],
    checkRuns,
    ...overrides,
  });
}

test("CI pending remains distinct from success", () => {
  const result = prove({ runs: [{ ...run, status: "in_progress", conclusion: null }] });

  assert.deepEqual(result, { kind: "pending", evidence });
});

test("a failed required check is a failure, not a green result", () => {
  const result = prove({ checkRuns: checkRuns.map((check) => check.name === "tui" ? { ...check, conclusion: "failure" } : check) });

  assert.deepEqual(result, { kind: "failed", reason: "Required check tui did not succeed.", evidence });
});

test("a successful check suite proves tested base from the merge commit parents", () => {
  const result = prove();

  assert.deepEqual(result, { kind: "passed", testedBaseSha: baseSha, testedHeadSha: headSha, mergeSha, runId: 7 });
});

test("a pull request base SHA alone does not prove which base CI tested", () => {
  const result = prove({ commits: [{ sha: mergeSha, parents: [headSha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] }] });

  assert.deepEqual(result, { kind: "unproven", reason: "No pull_request workflow run proves the tested head/base merge commit." });
});

test("missing required checks make the result unproven", () => {
  const result = prove({ checkRuns: checkRuns.filter((check) => check.name !== "qiskit-backend") });

  assert.deepEqual(result, { kind: "unproven", reason: "Required check qiskit-backend is absent from the tested check suite.", evidence });
});

test("a completed required check without a success conclusion is not accepted", () => {
  const result = prove({ checkRuns: checkRuns.map((check) => check.name === "web" ? { ...check, conclusion: "skipped" } : check) });

  assert.deepEqual(result, { kind: "failed", reason: "Required check web did not succeed.", evidence });
});

test("only a workflow run explicitly linked to this PR can prove its checks", () => {
  const result = prove({ runs: [{ ...run, pullRequests: [{ number: 43 }] }] });

  assert.deepEqual(result, { kind: "pending" });
});
