import type { Sql, SqlReader, SqlRow } from "apps";
import type { TelegramOutcome } from "./telegram.ts";

interface LockRow extends SqlRow {
  run_id: string;
  lease_until: number;
  fencing: number;
  job_delivery_id: string | null;
}

export interface QueueItem extends SqlRow {
  delivery_id: string;
  repository: string;
  pull_request_number: number;
  event_head_sha: string;
  event_base_sha: string | null;
  attempts: number;
}

export type QueueClaim =
  | { kind: "busy"; retryAfterMs: number }
  | { kind: "idle"; fencing: number }
  | { kind: "claimed"; item: QueueItem; fencing: number };

export interface ClaimInput {
  repository: string;
  runId: string;
  leaseMs: number;
  now: number;
}

export function claimNext(sql: Sql, input: ClaimInput): QueueClaim {
  return sql.transaction((transaction) => {
    const existing = transaction.exec<LockRow>(
      "SELECT run_id, lease_until, fencing, job_delivery_id FROM repository_locks WHERE repository = ?",
      input.repository,
    ).toArray()[0];
    if (existing !== undefined && existing.run_id !== input.runId && existing.lease_until > input.now) {
      return { kind: "busy", retryAfterMs: existing.lease_until - input.now };
    }

    let fencing = existing?.fencing ?? 0;
    if (existing === undefined || existing.run_id !== input.runId) fencing += 1;
    if (existing !== undefined && existing.lease_until <= input.now) {
      transaction.exec(
        `UPDATE review_queue SET state = 'needs-attention', run_id = NULL, fencing = NULL, lease_until = NULL,
           outcome_kind = 'lease_expired_superseded', failure_code = 'lease_expired_superseded', updated_at = ?
         WHERE state = 'processing' AND lease_until <= ? AND event_base_sha IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM review_queue queued
             WHERE queued.repository = review_queue.repository
               AND queued.pull_request_number = review_queue.pull_request_number
               AND queued.event_head_sha = review_queue.event_head_sha
               AND queued.event_base_sha = review_queue.event_base_sha
               AND queued.state = 'queued'
           )`,
        input.now,
        input.now,
      );
      transaction.exec(
        `UPDATE review_queue SET state = 'queued', run_id = NULL, fencing = NULL, lease_until = NULL, updated_at = ?
         WHERE state = 'processing' AND lease_until <= ?`,
        input.now,
        input.now,
      );
    }
    const leaseUntil = input.now + input.leaseMs;
    transaction.exec(
      `INSERT INTO repository_locks (repository, run_id, lease_until, fencing, job_delivery_id)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(repository) DO UPDATE SET run_id = excluded.run_id, lease_until = excluded.lease_until,
         fencing = excluded.fencing, job_delivery_id = NULL`,
      input.repository,
      input.runId,
      leaseUntil,
      fencing,
    );

    if (existing?.run_id === input.runId && existing.job_delivery_id !== null) {
      const current = transaction.exec<QueueItem>(
        `SELECT delivery_id, repository, pull_request_number, event_head_sha, event_base_sha, attempts
         FROM review_queue WHERE delivery_id = ? AND state = 'processing' AND run_id = ? AND fencing = ?`,
        existing.job_delivery_id,
        input.runId,
        fencing,
      ).toArray()[0];
      if (current !== undefined) {
        transaction.exec(
          "UPDATE repository_locks SET job_delivery_id = ? WHERE repository = ? AND run_id = ? AND fencing = ?",
          current.delivery_id,
          input.repository,
          input.runId,
          fencing,
        );
        transaction.exec(
          "UPDATE review_queue SET lease_until = ?, updated_at = ? WHERE delivery_id = ? AND state = 'processing' AND run_id = ? AND fencing = ?",
          leaseUntil,
          input.now,
          current.delivery_id,
          input.runId,
          fencing,
        );
        return { kind: "claimed", item: current, fencing };
      }
    }

    const item = transaction.exec<QueueItem>(
      `SELECT delivery_id, repository, pull_request_number, event_head_sha, event_base_sha, attempts
       FROM review_queue WHERE repository = ? AND state = 'queued'
       ORDER BY received_at ASC, delivery_id ASC LIMIT 1`,
      input.repository,
    ).toArray()[0];
    if (item === undefined) {
      transaction.exec(
        "UPDATE repository_locks SET lease_until = ?, job_delivery_id = NULL WHERE repository = ? AND run_id = ? AND fencing = ?",
        leaseUntil,
        input.repository,
        input.runId,
        fencing,
      );
      return { kind: "idle", fencing };
    }

    transaction.exec(
      `UPDATE review_queue SET state = 'processing', run_id = ?, fencing = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
       WHERE delivery_id = ? AND state = 'queued'`,
      input.runId,
      fencing,
      leaseUntil,
      input.now,
      item.delivery_id,
    );
    transaction.exec(
      "UPDATE repository_locks SET job_delivery_id = ? WHERE repository = ? AND run_id = ? AND fencing = ?",
      item.delivery_id,
      input.repository,
      input.runId,
      fencing,
    );
    return { kind: "claimed", item: { ...item, attempts: item.attempts + 1 }, fencing };
  });
}

export function releaseRepositoryLock(sql: Sql, input: { repository: string; runId: string; fencing: number; now: number }): boolean {
  return sql.exec(
    `UPDATE repository_locks SET lease_until = ?, job_delivery_id = NULL
     WHERE repository = ? AND run_id = ? AND fencing = ? AND job_delivery_id IS NULL`,
    input.now,
    input.repository,
    input.runId,
    input.fencing,
  ).rowsWritten === 1;
}

export function renewQueueLease(sql: Sql, input: {
  repository: string;
  runId: string;
  fencing: number;
  leaseMs: number;
  now: number;
}): number | null {
  return sql.transaction((transaction) => {
    const leaseUntil = input.now + input.leaseMs;
    const lock = transaction.exec(
      `UPDATE repository_locks SET lease_until = ?
       WHERE repository = ? AND run_id = ? AND fencing = ?`,
      leaseUntil,
      input.repository,
      input.runId,
      input.fencing,
    );
    if (lock.rowsWritten !== 1) return null;
    transaction.exec(
      `UPDATE review_queue SET lease_until = ?, updated_at = ?
       WHERE state = 'processing' AND run_id = ? AND fencing = ?`,
      leaseUntil,
      input.now,
      input.runId,
      input.fencing,
    );
    return leaseUntil;
  });
}

export interface QueueCompletion {
  repository: string;
  deliveryId: string;
  runId: string;
  fencing: number;
  state: "complete" | "needs-attention" | "stale";
  testedBaseSha: string | null;
  snapshotHash: string | null;
  reviewDecision: "reviewable" | "needs-attention" | null;
  outcomeKind: string;
  failureCode: string | null;
  now: number;
  leaseMs: number;
}

function finishInTransaction(transaction: SqlReader, input: QueueCompletion): boolean {
  const lock = transaction.exec(
    `SELECT run_id FROM repository_locks WHERE repository = ? AND run_id = ? AND fencing = ? AND job_delivery_id = ?`,
    input.repository,
    input.runId,
    input.fencing,
    input.deliveryId,
  ).toArray()[0];
  if (lock === undefined) return false;
  const updated = transaction.exec(
    `UPDATE review_queue SET state = ?, run_id = NULL, fencing = NULL, lease_until = NULL,
       tested_base_sha = ?, snapshot_hash = ?, review_decision = ?, outcome_kind = ?, failure_code = ?, updated_at = ?
     WHERE delivery_id = ? AND state = 'processing' AND run_id = ? AND fencing = ?`,
    input.state,
    input.testedBaseSha,
    input.snapshotHash,
    input.reviewDecision,
    input.outcomeKind,
    input.failureCode,
    input.now,
    input.deliveryId,
    input.runId,
    input.fencing,
  );
  if (updated.rowsWritten !== 1) return false;
  transaction.exec(
    `UPDATE repository_locks SET job_delivery_id = NULL, lease_until = ?
     WHERE repository = ? AND run_id = ? AND fencing = ?`,
    input.now + input.leaseMs,
    input.repository,
    input.runId,
    input.fencing,
  );
  return true;
}

export function finishQueueItem(sql: Sql, input: QueueCompletion): boolean {
  return sql.transaction((transaction) => finishInTransaction(transaction, input));
}

export function finishQueueItemWithNotifications(
  sql: Sql,
  input: QueueCompletion,
  notifications: NotificationInput[],
): boolean {
  return sql.transaction((transaction) => {
    if (!finishInTransaction(transaction, input)) return false;
    for (const notification of notifications) {
      transaction.exec(
        `INSERT OR IGNORE INTO notification_outbox
          (notification_id, dedupe_key, repository, pull_request_number, head_sha, tested_base_sha,
           kind, message, status, failure_code, created_at, updated_at, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?, ?)`,
        notification.notificationId,
        notification.dedupeKey,
        notification.repository,
        notification.pullRequestNumber,
        notification.headSha,
        notification.testedBaseSha,
        notification.kind,
        notification.message,
        notification.now,
        notification.now,
        notification.now,
      );
    }
    return true;
  });
}

export function pendingWorkExists(sql: SqlReader, repository: string, now = Date.now()): boolean {
  const queue = sql.exec(
    "SELECT delivery_id FROM review_queue WHERE repository = ? AND state IN ('queued', 'processing') LIMIT 1",
    repository,
  ).toArray();
  return queue.length > 0 || sql.exec(
    "SELECT notification_id FROM notification_outbox WHERE repository = ? AND (status = 'sending' OR (status = 'queued' AND next_attempt_at <= ?)) LIMIT 1",
    repository, now,
  ).toArray().length > 0;
}

export interface NotificationInput {
  notificationId: string;
  dedupeKey: string;
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  testedBaseSha: string | null;
  kind: "needs-attention" | "stale";
  message: string;
  now: number;
}

export function enqueueNotification(sql: Sql, input: NotificationInput): boolean {
  return sql.exec(
    `INSERT OR IGNORE INTO notification_outbox
      (notification_id, dedupe_key, repository, pull_request_number, head_sha, tested_base_sha,
       kind, message, status, failure_code, created_at, updated_at, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?, ?)`,
    input.notificationId,
    input.dedupeKey,
    input.repository,
    input.pullRequestNumber,
    input.headSha,
    input.testedBaseSha,
    input.kind,
    input.message,
    input.now,
    input.now,
    input.now,
  ).rowsWritten > 0;
}

export interface NotificationRow extends SqlRow {
  notification_id: string;
  dedupe_key: string;
  repository: string;
  pull_request_number: number;
  head_sha: string;
  tested_base_sha: string | null;
  kind: "needs-attention" | "stale";
  message: string;
  status: "queued" | "sending" | "sent" | "failed" | "unknown";
  attempts: number;
  next_attempt_at: number;
  failure_code: string | null;
  created_at: number;
  updated_at: number;
}

interface NotificationLockInput {
  repository: string;
  runId: string;
  fencing: number;
  now: number;
}

function ownsNotificationLock(sql: SqlReader, input: NotificationLockInput): boolean {
  return sql.exec(
    `SELECT run_id FROM repository_locks
     WHERE repository = ? AND run_id = ? AND fencing = ? AND lease_until > ? AND job_delivery_id IS NULL`,
    input.repository, input.runId, input.fencing, input.now,
  ).toArray().length === 1;
}

export function markSendingNotificationsUnknown(sql: Sql, input: NotificationLockInput): number {
  return sql.transaction((transaction) => {
    if (!ownsNotificationLock(transaction, input)) return 0;
    return transaction.exec(
      `UPDATE notification_outbox SET status = 'unknown', failure_code = 'telegram_delivery_unknown', updated_at = ?
       WHERE repository = ? AND status = 'sending'`,
      input.now, input.repository,
    ).rowsWritten;
  });
}

export function claimNextNotification(sql: Sql, input: NotificationLockInput): NotificationRow | null {
  return sql.transaction((transaction) => {
    if (!ownsNotificationLock(transaction, input)) return null;
    const row = transaction.exec<NotificationRow>(
      `SELECT * FROM notification_outbox WHERE repository = ? AND status = 'queued' AND next_attempt_at <= ?
       ORDER BY created_at, notification_id LIMIT 1`, input.repository, input.now,
    ).toArray()[0];
    if (row === undefined) return null;
    transaction.exec(
      `UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1, send_run_id = ?, send_fencing = ?, updated_at = ?
       WHERE notification_id = ? AND status = 'queued'`,
      input.runId, input.fencing, input.now, row.notification_id,
    );
    return { ...row, status: "sending", attempts: row.attempts + 1 };
  });
}

export function recordTelegramNotification(sql: Sql, input: NotificationLockInput & {
  notificationId: string;
  outcome: TelegramOutcome;
}): boolean {
  return sql.transaction((transaction) => {
    if (!ownsNotificationLock(transaction, input)) return false;
    const retry = input.outcome.status === "retry";
    const delay = input.outcome.status === "retry" ? input.outcome.retryAfterMs : 0;
    // Never turn an ambiguous delivery into a retry, or shorten Telegram's delay.
    if (retry && (!Number.isSafeInteger(delay) || delay < 1000 || delay > 3600000)) return false;
    return transaction.exec(
      `UPDATE notification_outbox SET status = ?, failure_code = ?, next_attempt_at = ?, updated_at = ?
       WHERE notification_id = ? AND repository = ? AND status = 'sending' AND send_run_id = ? AND send_fencing = ?`,
      retry ? "queued" : input.outcome.status,
      input.outcome.status === "sent" ? null : input.outcome.failureCode,
      input.now + delay, input.now, input.notificationId, input.repository, input.runId, input.fencing,
    ).rowsWritten === 1;
  });
}
