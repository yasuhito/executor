import assert from "node:assert/strict";
import test from "node:test";
import { createLeasedReviewPort, notificationsForResult } from "../processor.ts";

const identity = {
  repository: "example-owner/example-repository",
  pullRequest: 42,
  headSha: "0123456789abcdef0123456789abcdef01234567",
  testedBaseSha: "89abcdef0123456789abcdef0123456789abcdef",
};
const reviewId = "c".repeat(64);
const snapshotHash = "a".repeat(64);
const leaseExpiresAt = Date.now() + 10 * 60_000;
const queueItem = {
  delivery_id: "11111111-2222-4333-8444-555555555555",
  repository: "example-owner/example-repository",
  pull_request_number: 42,
  event_head_sha: identity.headSha,
  event_base_sha: identity.testedBaseSha,
  attempts: 1,
};

test("successful merges do not create Telegram notification records", async () => {
  const result = {
    kind: "merged",
    notices: [{ kind: "merged", identity, snapshotHash, detail: "Merged successfully." }],
  };

  assert.deepEqual(await notificationsForResult(queueItem, result), []);
});

test("actionable failures produce a queued Telegram notification record", async () => {
  const result = {
    kind: "needs-attention",
    notices: [
      {
        kind: "needs-attention",
        identity: null,
        snapshotHash: null,
        detail: "Required CI is unproven.",
      },
    ],
  };
  const records = await notificationsForResult(queueItem, result);

  assert.deepEqual(
    records.map(({ kind, headSha, testedBaseSha }) => ({ kind, headSha, testedBaseSha })),
    [
      {
        kind: "needs-attention",
        headSha: identity.headSha,
        testedBaseSha: null,
      },
    ],
  );
});

test("notifications without a resolved review identity deduplicate by webhook base", async () => {
  const result = {
    kind: "needs-attention",
    notices: [
      {
        kind: "needs-attention",
        identity: null,
        snapshotHash: null,
        detail: "The webhook base could not be reviewed.",
      },
    ],
  };
  const first = await notificationsForResult(queueItem, result);
  const otherBase = "fedcba9876543210fedcba9876543210fedcba98";
  const second = await notificationsForResult({ ...queueItem, event_base_sha: otherBase }, result);

  assert.notEqual(first[0].notificationId, second[0].notificationId);
});

test("review invalidation sends the queue mutation's lease expiry", async () => {
  const renewalSteps = [];
  let invalidationBody;
  const stepContext = {
    app: {
      accounts: {
        reviewService: { fields: { hmacSecret: "test-only-review-secret-0123456789abcdef" } },
      },
    },
    signal: new AbortController().signal,
    fetch: async (_url, init) => {
      invalidationBody = JSON.parse(init.body);
      return Response.json({ reviewId, status: "stale" });
    },
  };
  const context = {
    runId: "test-workflow-run",
    step: {
      async runMutation(name) {
        renewalSteps.push(name);
        return leaseExpiresAt;
      },
      async do(_name, _options, run) {
        return run(stepContext);
      },
      async sleep() {},
    },
  };
  const item = {
    delivery_id: "11111111-2222-4333-8444-555555555555",
    repository: "example-owner/example-repository",
    pull_request_number: 42,
    event_head_sha: identity.headSha,
    attempts: 1,
  };
  const port = createLeasedReviewPort(
    context,
    item,
    7,
    { id: 123456789, fullName: "example-owner/example-repository" },
    "https://review.example.invalid",
  );

  await port.invalidate(reviewId);

  assert.deepEqual(
    { renewalSteps: renewalSteps.length, body: invalidationBody },
    {
      renewalSteps: 2,
      body: { reviewId, leaseExpiresAt },
    },
  );
});

test("notifications exclude arbitrary detail, findings, evidence and failure strings", async () => {
  const secret = "PRIVATE-DIFF-SECRET";
  const notice = {
    kind: "needs-attention",
    identity,
    snapshotHash,
    detail: secret,
    verdict: {
      standards: {
        status: "findings",
        findings: [{ path: secret, summary: secret, evidence: secret }],
      },
      changeIntent: { status: "pass", findings: [] },
    },
  };
  const generic = await notificationsForResult(queueItem, {
    failureCode: secret,
    notices: [notice],
  });
  const ciFailure = await notificationsForResult(queueItem, {
    failureCode: "required_ci_failed",
    notices: [notice],
  });
  const reauth = await notificationsForResult(queueItem, {
    failureCode: "reauth_required",
    notices: [notice],
  });

  assert.deepEqual(
    {
      secretLeaked: generic[0].message.includes(secret),
      standardsSummaryIncluded: generic[0].message.includes("Standards: findings (1)"),
      genericCode: generic[0].message.includes("Failure code: review_attention"),
      ciFailureCode: ciFailure[0].message.includes("Failure code: required_ci_failed"),
      reauthCode: reauth[0].message.includes("Failure code: reauth_required"),
    },
    {
      secretLeaked: false,
      standardsSummaryIncluded: true,
      genericCode: true,
      ciFailureCode: true,
      reauthCode: true,
    },
  );
});
