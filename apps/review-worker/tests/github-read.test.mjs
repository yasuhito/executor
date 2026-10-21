import assert from "node:assert/strict";
import test from "node:test";
import { GitHubRateLimitError, parsePullRequestUrl, readRequiredCi } from "../src/github-read.ts";

const headSha = "0123456789abcdef0123456789abcdef01234567";
const baseSha = "89abcdef0123456789abcdef0123456789abcdef";
const latestMergeSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const olderMergeSha = "fedcba9876543210fedcba9876543210fedcba98";
const repository = { id: 123456789, fullName: "example-owner/example-repository" };
const pullRequest = {
  pullRequest: 42,
  headSha,
  baseSha,
  headRef: "dependabot/cargo/example-1.0.1",
};
const runs = [
  {
    id: 8,
    event: "pull_request",
    status: "completed",
    conclusion: "failure",
    head_sha: latestMergeSha,
    check_suite_id: 20,
    created_at: "2026-01-02T00:00:00Z",
    pull_requests: [{ number: 42 }],
  },
  {
    id: 7,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: olderMergeSha,
    check_suite_id: 19,
    created_at: "2026-01-01T00:00:00Z",
    pull_requests: [{ number: 42 }],
  },
];
const checkRuns = ["web", "tui", "qiskit-backend"].map((name, index) => ({
  id: index + 1,
  name,
  head_sha: olderMergeSha,
  status: "completed",
  conclusion: "success",
  check_suite: { id: 19 },
  app: { slug: "github-actions" },
}));

function context(fetch) {
  return { repository, fetch, signal: new AbortController().signal };
}

test("an unreadable newest completed run cannot fall back to an older successful CI run", async () => {
  const proof = await readRequiredCi(
    context(async (input) => {
      const url = new URL(String(input));
      if (url.origin !== "https://api.github.com") throw new Error("Unexpected origin");
      if (url.pathname.endsWith("/actions/runs"))
        return Response.json({ total_count: runs.length, workflow_runs: runs });
      if (url.pathname.endsWith(`/commits/${latestMergeSha}`))
        return new Response("untrusted body", { status: 503 });
      if (url.pathname.endsWith(`/commits/${olderMergeSha}`)) {
        return Response.json({ sha: olderMergeSha, parents: [{ sha: baseSha }, { sha: headSha }] });
      }
      if (url.pathname.endsWith(`/commits/${olderMergeSha}/check-runs`))
        return Response.json({ total_count: checkRuns.length, check_runs: checkRuns });
      throw new Error("Unexpected test endpoint");
    }),
    pullRequest,
  );

  assert.deepEqual(proof, {
    kind: "unproven",
    reason: "A completed workflow run's merge commit could not be verified.",
  });
});

test("only canonical GitHub pull-request URLs are parsed", () => {
  const inputs = [
    "https://github.com/example-owner/example-repository/pull/42",
    "http://github.com/example-owner/example-repository/pull/42",
    "https://github.com.evil.example/example-owner/example-repository/pull/42",
    "https://attacker@github.com/example-owner/example-repository/pull/42",
    "https://github.com/example-other/repository/pull/42",
    "https://github.com/example-owner/example-repository/pull/042",
    "https://github.com/example-owner/example-repository/pull/42?diff=1",
    "https://github.com/example-owner/example-repository/pull/42/",
    "https://github.com/example-owner/example-repository/pull/42%2f..%2fadmin",
    "https://github.com/example-owner/example-repository/pull/9007199254740992",
  ];
  const parsed = inputs.map((value) => parsePullRequestUrl(value));

  assert.deepEqual(parsed, [
    { url: inputs[0], repository: "example-owner/example-repository", pullRequestNumber: 42 },
    null,
    null,
    null,
    { url: inputs[4], repository: "example-other/repository", pullRequestNumber: 42 },
    ...Array(5).fill(null),
  ]);
});

test("public GitHub API rate limits are classified without exposing response bodies", async () => {
  const error = await readRequiredCi(
    context(
      async () =>
        new Response("fixture token must not surface", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
          },
        }),
    ),
    pullRequest,
  ).then(
    () => null,
    (value) => value,
  );

  assert.deepEqual(
    [
      error instanceof GitHubRateLimitError,
      error.retryAfterMs > 0,
      error.message.includes("fixture token"),
    ],
    [true, true, false],
  );
});
