import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { claimNext, claimNextNotification, enqueueNotification, finishQueueItem, finishQueueItemWithNotifications, markSendingNotificationsUnknown, pendingWorkExists, recordTelegramNotification, renewQueueLease } from "../queue-store.ts";

async function createSql() {
  const database = new DatabaseSync(":memory:");
  for (const migrationName of ["0001_webhook_receipts.sql", "0002_dependabot_review_queue.sql", "0003_url_only_review_telegram_pending.sql", "0004_multi_repository_config.sql"]) {
    database.exec(await readFile(new URL(`../migrations/${migrationName}`, import.meta.url), "utf8"));
  }
  const sql = {
    exec(statement, ...bindings) {
      const prepared = database.prepare(statement);
      if (prepared.columns().length > 0) {
        const rows = prepared.all(...bindings);
        return { rowsWritten: 0, rowsRead: rows.length, toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
      }
      const result = prepared.run(...bindings);
      return { rowsWritten: Number(result.changes), rowsRead: 0, toArray: () => [], one: () => { throw new Error("no row"); }, [Symbol.iterator]: () => [][Symbol.iterator]() };
    },
    transaction(work) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = work(sql);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { database, sql };
}

function addJob(sql, deliveryId, receivedAt, pullRequest = 42, baseSha = null) {
  sql.transaction((transaction) => {
    transaction.exec(
      `INSERT INTO webhook_receipts (delivery_id, event, action, repository, pull_request_number, head_sha, event_base_sha, pull_request_url, received_at, ping)
       VALUES (?, 'pull_request', 'opened', 'example-owner/example-repository', ?, ?, ?, ?, ?, 0)`,
      deliveryId,
      pullRequest,
      "0123456789abcdef0123456789abcdef01234567",
      baseSha,
      `https://github.com/example-owner/example-repository/pull/${pullRequest}`,
      receivedAt,
    );
    transaction.exec(
      `INSERT INTO review_queue (delivery_id, repository, pull_request_number, event_head_sha, event_base_sha, state, received_at, updated_at)
       VALUES (?, 'example-owner/example-repository', ?, ?, ?, 'queued', ?, ?)`,
      deliveryId,
      pullRequest,
      "0123456789abcdef0123456789abcdef01234567",
      baseSha,
      receivedAt,
      receivedAt,
    );
  });
}

function completion(claim, deliveryId, now, state = "complete") {
  return {
    repository: "example-owner/example-repository",
    deliveryId,
    runId: "run-a",
    fencing: claim.fencing,
    state,
    testedBaseSha: "89abcdef0123456789abcdef0123456789abcdef",
    snapshotHash: "a".repeat(64),
    reviewDecision: "reviewable",
    outcomeKind: "merged",
    failureCode: null,
    now,
    leaseMs: 300_000,
  };
}

function notification() {
  return {
    notificationId: "a".repeat(64),
    dedupeKey: "same-identity-same-outcome",
    repository: "example-owner/example-repository",
    pullRequestNumber: 42,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    testedBaseSha: null,
    kind: "needs-attention",
    message: "Dependabot review: needs-attention",
    now: 10,
  };
}

test("concurrent repository runs serialize behind one durable lock", async () => {
  const { sql } = await createSql();
  addJob(sql, "11111111-2222-4333-8444-555555555555", 1);
  const first = claimNext(sql, { repository: "example-owner/example-repository", runId: "run-a", leaseMs: 300_000, now: 10 });
  const second = claimNext(sql, { repository: "example-owner/example-repository", runId: "run-b", leaseMs: 300_000, now: 11 });

  assert.deepEqual({ first: first.kind, second: second.kind }, { first: "claimed", second: "busy" });
});

test("expired workers lose the fencing token and cannot complete the reclaimed item", async () => {
  const { sql } = await createSql();
  const deliveryId = "11111111-2222-4333-8444-555555555555";
  addJob(sql, deliveryId, 1);
  const oldClaim = claimNext(sql, { repository: "example-owner/example-repository", runId: "run-a", leaseMs: 100, now: 10 });
  const newClaim = claimNext(sql, { repository: "example-owner/example-repository", runId: "run-b", leaseMs: 100, now: 111 });
  const oldCompletion = finishQueueItem(sql, completion(oldClaim, deliveryId, 112));

  assert.deepEqual({ newOwner: newClaim.kind, newFence: newClaim.fencing, oldCompletion }, { newOwner: "claimed", newFence: 2, oldCompletion: false });
});

test("an expired duplicate is superseded before the queued follow-up is reclaimed", async () => {
  const { sql } = await createSql();
  const firstId = "33333333-4444-4555-8666-777777777777";
  const secondId = "44444444-5555-4666-8777-888888888888";
  const baseSha = "89abcdef0123456789abcdef0123456789abcdef";
  addJob(sql, firstId, 1, 42, baseSha);
  const expired = claimNext(sql, { repository: "example-owner/example-repository", runId: "run-a", leaseMs: 100, now: 10 });
  addJob(sql, secondId, 20, 42, baseSha);
  const followUp = claimNext(sql, { repository: "example-owner/example-repository", runId: "run-b", leaseMs: 100, now: 111 });
  const rows = sql.exec("SELECT delivery_id, state, failure_code FROM review_queue ORDER BY delivery_id").toArray();

  assert.deepEqual({
    expired: expired.kind,
    followUp: followUp.kind === "claimed" ? [followUp.item.delivery_id, followUp.fencing] : followUp.kind,
    rows: rows.map(({ ...row }) => row),
  }, {
    expired: "claimed",
    followUp: [secondId, 2],
    rows: [
      { delivery_id: firstId, state: "needs-attention", failure_code: "lease_expired_superseded" },
      { delivery_id: secondId, state: "processing", failure_code: null },
    ],
  });
});

test("lease renewal returns its expiry only for the current fencing owner", async () => {
  const { sql } = await createSql();
  addJob(sql, "11111111-2222-4333-8444-555555555555", 1);
  const claim = claimNext(sql, { repository: "example-owner/example-repository", runId: "run-a", leaseMs: 100, now: 10 });
  if (claim.kind !== "claimed") throw new Error("Expected a queue claim.");
  const renewed = renewQueueLease(sql, { repository: "example-owner/example-repository", runId: "run-a", fencing: claim.fencing, leaseMs: 300_000, now: 20 });
  const lostOwner = renewQueueLease(sql, { repository: "example-owner/example-repository", runId: "run-b", fencing: claim.fencing + 1, leaseMs: 300_000, now: 20 });

  assert.deepEqual({ renewed, lostOwner }, { renewed: 300_020, lostOwner: null });
});

test("queue claims preserve receipt order", async () => {
  const { sql } = await createSql();
  addJob(sql, "11111111-2222-4333-8444-555555555555", 20, 42);
  addJob(sql, "22222222-3333-4444-8555-666666666666", 10, 43);
  const claim = claimNext(sql, { repository: "example-owner/example-repository", runId: "run-a", leaseMs: 300_000, now: 30 });

  assert.equal(claim.kind === "claimed" ? claim.item.pull_request_number : null, 43);
});

test("notification outbox stores deduplicated actionable messages as queued work", async () => {
  const { sql } = await createSql();
  const input = notification();
  const first = enqueueNotification(sql, input);
  const duplicate = enqueueNotification(sql, input);
  const row = sql.exec("SELECT kind, message, status, failure_code, attempts, next_attempt_at FROM notification_outbox WHERE notification_id = ?", input.notificationId).toArray()[0];

  assert.deepEqual({ first, duplicate, row: { ...row }, hasPendingWork: pendingWorkExists(sql, "example-owner/example-repository", 10) }, {
    first: true,
    duplicate: false,
    row: { kind: "needs-attention", message: input.message, status: "queued", failure_code: null, attempts: 0, next_attempt_at: 10 },
    hasPendingWork: true,
  });
});

test("queue completion and Telegram notification are recorded atomically", async () => {
  const { sql } = await createSql();
  const deliveryId = "11111111-2222-4333-8444-555555555555";
  addJob(sql, deliveryId, 1);
  const claim = claimNext(sql, { repository: "example-owner/example-repository", runId: "run-a", leaseMs: 300_000, now: 10 });
  if (claim.kind !== "claimed") throw new Error("Expected a queue claim.");
  const inserted = finishQueueItemWithNotifications(sql, completion(claim, deliveryId, 20), [notification()]);
  const queue = sql.exec("SELECT state, outcome_kind FROM review_queue WHERE delivery_id = ?", deliveryId).toArray()[0];
  const outbox = sql.exec("SELECT status, failure_code, attempts FROM notification_outbox WHERE notification_id = ?", "a".repeat(64)).toArray()[0];

  assert.deepEqual({ inserted, queue: { ...queue }, outbox: { ...outbox } }, {
    inserted: true,
    queue: { state: "complete", outcome_kind: "merged" },
    outbox: { status: "queued", failure_code: null, attempts: 0 },
  });
});

test("sent notification is terminal and leaves no pending work", async () => {
  const { sql } = await createSql();
  const deliveryId = "11111111-2222-4333-8444-555555555555";
  addJob(sql, deliveryId, 1);
  const queueClaim = claimNext(sql, { repository: "example-owner/example-repository", runId: "run-a", leaseMs: 300_000, now: 10 });
  if (queueClaim.kind !== "claimed") throw new Error("Expected a queue claim.");
  finishQueueItemWithNotifications(sql, completion(queueClaim, deliveryId, 20), [notification()]);
  const sending = claimNextNotification(sql, { repository: "example-owner/example-repository", runId: "run-a", fencing: queueClaim.fencing, now: 21 });
  if (sending === null) throw new Error("Expected a notification claim.");
  const recorded = recordTelegramNotification(sql, {
    repository: "example-owner/example-repository", notificationId: sending.notification_id, runId: "run-a", fencing: queueClaim.fencing,
    outcome: { status: "sent" }, now: 22,
  });
  const row = sql.exec("SELECT status, failure_code, attempts FROM notification_outbox WHERE notification_id = ?", sending.notification_id).toArray()[0];

  assert.deepEqual({ recorded, row: { ...row }, pending: pendingWorkExists(sql, "example-owner/example-repository", 22) }, {
    recorded: true,
    row: { status: "sent", failure_code: null, attempts: 1 },
    pending: false,
  });
});

test("Telegram rate limits requeue only after the provided delay", async () => {
  const { sql } = await createSql();
  const deliveryId = "11111111-2222-4333-8444-555555555555";
  addJob(sql, deliveryId, 1);
  const queueClaim = claimNext(sql, { repository: "example-owner/example-repository", runId: "run-a", leaseMs: 300_000, now: 10 });
  if (queueClaim.kind !== "claimed") throw new Error("Expected a queue claim.");
  finishQueueItemWithNotifications(sql, completion(queueClaim, deliveryId, 20), [notification()]);
  const sending = claimNextNotification(sql, { repository: "example-owner/example-repository", runId: "run-a", fencing: queueClaim.fencing, now: 21 });
  if (sending === null) throw new Error("Expected a notification claim.");
  recordTelegramNotification(sql, {
    repository: "example-owner/example-repository", notificationId: sending.notification_id, runId: "run-a", fencing: queueClaim.fencing,
    outcome: { status: "retry", failureCode: "telegram_rate_limited", retryAfterMs: 60_000 }, now: 22,
  });
  const early = claimNextNotification(sql, { repository: "example-owner/example-repository", runId: "run-a", fencing: queueClaim.fencing, now: 60_021 });
  const due = claimNextNotification(sql, { repository: "example-owner/example-repository", runId: "run-a", fencing: queueClaim.fencing, now: 60_022 });

  assert.deepEqual({ early, due: due && { status: due.status, attempts: due.attempts } }, { early: null, due: { status: "sending", attempts: 2 } });
});

test("a recovered in-flight Telegram send is marked unknown and never retried", async () => {
  const { sql } = await createSql();
  const deliveryId = "11111111-2222-4333-8444-555555555555";
  addJob(sql, deliveryId, 1);
  const queueClaim = claimNext(sql, { repository: "example-owner/example-repository", runId: "run-a", leaseMs: 300_000, now: 10 });
  if (queueClaim.kind !== "claimed") throw new Error("Expected a queue claim.");
  finishQueueItemWithNotifications(sql, completion(queueClaim, deliveryId, 20), [notification()]);
  const sending = claimNextNotification(sql, { repository: "example-owner/example-repository", runId: "run-a", fencing: queueClaim.fencing, now: 21 });
  if (sending === null) throw new Error("Expected a notification claim.");
  const recovered = markSendingNotificationsUnknown(sql, { repository: "example-owner/example-repository", runId: "run-b", fencing: queueClaim.fencing + 1, now: 30 });
  const row = sql.exec("SELECT status, failure_code FROM notification_outbox WHERE notification_id = ?", sending.notification_id).toArray()[0];

  assert.deepEqual({ recovered, row: { ...row }, pending: pendingWorkExists(sql, "example-owner/example-repository", 30) }, {
    recovered: 0,
    row: { status: "sending", failure_code: null },
    pending: true,
  });
});


test("only the active fenced lock may claim, recover, or record sends", async () => {
  const { sql } = await createSql();
  enqueueNotification(sql, notification());
  const claim = claimNext(sql, { repository: "example-owner/example-repository", runId: "run-a", leaseMs: 100, now: 10 });
  const owner = { repository: "example-owner/example-repository", runId: "run-a", fencing: claim.fencing, now: 11 };
  const invalidClaim = claimNextNotification(sql, { ...owner, fencing: claim.fencing + 1 });
  const sending = claimNextNotification(sql, owner);
  if (sending === null) throw new Error("Expected a notification claim.");
  const successor = claimNext(sql, { repository: "example-owner/example-repository", runId: "run-b", leaseMs: 100, now: 111 });
  const staleRecord = recordTelegramNotification(sql, { ...owner, now: 112, notificationId: sending.notification_id, outcome: { status: "sent" } });
  const nextOwner = { repository: "example-owner/example-repository", runId: "run-b", fencing: successor.fencing, now: 112 };
  const recovered = markSendingNotificationsUnknown(sql, nextOwner);
  const retryClaim = claimNextNotification(sql, nextOwner);
  const pending = pendingWorkExists(sql, "example-owner/example-repository", 112);
  const row = sql.exec("SELECT status, failure_code FROM notification_outbox").toArray()[0];

  assert.deepEqual({
    invalidClaim,
    claimed: sending.status,
    successor: successor.kind,
    staleRecord,
    recovered,
    retryClaim,
    pending,
    row: { ...row },
  }, {
    invalidClaim: null,
    claimed: "sending",
    successor: "idle",
    staleRecord: false,
    recovered: 1,
    retryClaim: null,
    pending: false,
    row: { status: "unknown", failure_code: "telegram_delivery_unknown" },
  });
});

test("future rate limits are not pending until due, and terminal failure cannot be resent", async () => {
  const { sql } = await createSql();
  enqueueNotification(sql, notification());
  const claim = claimNext(sql, { repository: "example-owner/example-repository", runId: "run-a", leaseMs: 300000, now: 10 });
  const owner = { repository: "example-owner/example-repository", runId: "run-a", fencing: claim.fencing, now: 11 };
  const sending = claimNextNotification(sql, owner);
  if (sending === null) throw new Error("Expected a notification claim.");
  const rateLimitRecorded = recordTelegramNotification(sql, { ...owner, notificationId: sending.notification_id,
    outcome: { status: "retry", failureCode: "telegram_rate_limited", retryAfterMs: 1000 } });
  const pendingBeforeDue = pendingWorkExists(sql, "example-owner/example-repository", 1010);
  const pendingAtDue = pendingWorkExists(sql, "example-owner/example-repository", 1011);
  const dueOwner = { ...owner, now: 1011 };
  const retrySending = claimNextNotification(sql, dueOwner);
  if (retrySending === null) throw new Error("Expected the rate-limited notification to become due.");
  const terminalFailure = recordTelegramNotification(sql, { ...dueOwner, notificationId: sending.notification_id,
    outcome: { status: "failed", failureCode: "telegram_auth_failed" } });
  const claimAfterFailure = claimNextNotification(sql, dueOwner);
  const retryAfterFailure = recordTelegramNotification(sql, { ...dueOwner, notificationId: sending.notification_id,
    outcome: { status: "retry", failureCode: "telegram_rate_limited", retryAfterMs: 1000 } });

  assert.deepEqual({
    rateLimitRecorded,
    pendingBeforeDue,
    pendingAtDue,
    retryAttempts: retrySending.attempts,
    terminalFailure,
    claimAfterFailure,
    retryAfterFailure,
  }, {
    rateLimitRecorded: true,
    pendingBeforeDue: false,
    pendingAtDue: true,
    retryAttempts: 2,
    terminalFailure: true,
    claimAfterFailure: null,
    retryAfterFailure: false,
  });
});
