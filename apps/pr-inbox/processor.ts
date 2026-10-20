import {
  array,
  mutation,
  number,
  object,
  query,
  string,
  workflow,
  type MutationContext,
  type QueryContext,
  type SqlReader,
  type WorkflowContext,
} from "apps";
import { sha256Hex } from "./review-protocol/core.ts";
import { claimNext, claimNextNotification, markSendingNotificationsUnknown, recordTelegramNotification, finishQueueItemWithNotifications, pendingWorkExists, releaseRepositoryLock, renewQueueLease } from "./queue-store.ts";
import type { NotificationInput, QueueCompletion, QueueItem } from "./queue-store.ts";
import { mergeReviewedPullRequest } from "./github-merge.ts";
import { githubReadContext } from "./github-api.ts";
import { readPullRequest } from "./review-protocol/github-read.ts";
import { invalidateReview, readReviewStatus, submitReview } from "./review-service.ts";
import { processDependabotPullRequest, type ProcessingNotice, type ProcessingResult, type ReviewPort } from "./review-flow.ts";
import { requirements } from "./providers.ts";
import type { RepositoryConfig } from "./repositories.ts";
import { sendTelegramNotification } from "./telegram.ts";

const leaseMs = 10 * 60_000;
const maxItemsPerRun = 100;
const maxLockWaits = 240;
const repositoryInput = object({ repository: string() });
const emptyInput = object({});

interface ConfiguredRepository {
  repository: RepositoryConfig;
  reviewWorkerUrl: string;
}

interface ConfiguredRepositoryRow extends Record<string, string | number | null | ArrayBuffer> {
  repository_id: number;
  review_worker_url: string;
}

function resolveConfiguredRepository(sql: SqlReader, fullName: string): ConfiguredRepository | null {
  const rows = sql.exec<ConfiguredRepositoryRow>(
    `SELECT DISTINCT repository_id, review_worker_url
     FROM configured_repositories WHERE full_name = ?`,
    fullName,
  ).toArray();
  if (rows.length !== 1) return null;
  return {
    repository: { fullName, id: rows[0].repository_id },
    reviewWorkerUrl: rows[0].review_worker_url,
  };
}

const repositoryConfigurationQuery = query(
  { input: repositoryInput },
  async (context: QueryContext<typeof requirements>, { repository }) =>
    resolveConfiguredRepository(context.sql, repository),
);
const queueItemInput = object({ repository: string(), runId: string(), leaseMs: number() });
const renewInput = object({ repository: string(), runId: string(), fencing: number(), leaseMs: number() });
const releaseInput = object({ repository: string(), runId: string(), fencing: number() });
const finishInput = object({
  completion: object({
    repository: string(), deliveryId: string(), runId: string(), fencing: number(),
    state: string().optional(), testedBaseSha: string().optional(), snapshotHash: string().optional(),
    reviewDecision: string().optional(), outcomeKind: string(), failureCode: string().optional(), now: number(), leaseMs: number(),
  }),
  notifications: array(object({
    notificationId: string(), dedupeKey: string(), repository: string(), pullRequestNumber: number(),
    headSha: string(), testedBaseSha: string().optional(), kind: string(), message: string(), now: number(),
  })),
});

function boundedLimit(value: number | undefined, fallback: number): number {
  const requested = typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
  return Math.min(100, Math.max(1, requested));
}

const claimQueueMutation = mutation(
  { title: "Dependabot queue claim", input: queueItemInput },
  async (context: MutationContext<typeof requirements>, input) => {
    if (resolveConfiguredRepository(context.sql, input.repository) === null) {
      throw new Error("Unsupported review repository.");
    }
    return claimNext(context.sql, { ...input, now: Date.now() });
  },
);

const renewQueueMutation = mutation(
  { title: "Dependabot queue lease renewal", input: renewInput },
  async (context: MutationContext<typeof requirements>, input) => {
    if (resolveConfiguredRepository(context.sql, input.repository) === null) return null;
    return renewQueueLease(context.sql, { ...input, now: Date.now() });
  },
);

const releaseQueueMutation = mutation(
  { title: "Dependabot queue release", input: releaseInput },
  async (context: MutationContext<typeof requirements>, input) => {
    if (resolveConfiguredRepository(context.sql, input.repository) === null) return false;
    return releaseRepositoryLock(context.sql, { ...input, now: Date.now() });
  },
);

const finishQueueMutation = mutation(
  { title: "Dependabot queue completion", input: finishInput },
  async (context: MutationContext<typeof requirements>, input) => {
    const state = input.completion.state;
    if (state !== "complete" && state !== "needs-attention" && state !== "stale") throw new Error("Invalid queue result state.");
    if (resolveConfiguredRepository(context.sql, input.completion.repository) === null) {
      throw new Error("Unsupported review repository.");
    }
    const completion: QueueCompletion = {
      ...input.completion,
      state,
      testedBaseSha: input.completion.testedBaseSha ?? null,
      snapshotHash: input.completion.snapshotHash ?? null,
      reviewDecision: input.completion.reviewDecision === "reviewable" || input.completion.reviewDecision === "needs-attention" ? input.completion.reviewDecision : null,
      failureCode: input.completion.failureCode ?? null,
    };
    const notifications: NotificationInput[] = input.notifications.map((notification) => {
      if (notification.kind !== "needs-attention" && notification.kind !== "stale") {
        throw new Error("Only actionable outcomes may enter the Telegram notification outbox.");
      }
      if (notification.repository !== input.completion.repository) {
        throw new Error("Notification repository does not match its queue item.");
      }
      return {
        ...notification,
        kind: notification.kind,
        testedBaseSha: notification.testedBaseSha ?? null,
      };
    });
    return finishQueueItemWithNotifications(context.sql, completion, notifications);
  },
);

// The claim and external send share one non-retrying workflow operation. If the
// operation is interrupted, its persisted sending row is recovered as unknown.
const dispatchNotificationMutation = mutation(
  { title: "Dispatch Telegram alert", input: releaseInput },
  async (context: MutationContext<typeof requirements>, input) => {
    if (resolveConfiguredRepository(context.sql, input.repository) === null) {
      return { dispatched: false };
    }
    const owner = { ...input, now: Date.now() } as const;
    const renewed = context.sql.exec(
      `UPDATE repository_locks SET lease_until = ?
       WHERE repository = ? AND run_id = ? AND fencing = ? AND lease_until > ? AND job_delivery_id IS NULL`,
      owner.now + leaseMs, owner.repository, owner.runId, owner.fencing, owner.now,
    ).rowsWritten;
    if (renewed !== 1) return { dispatched: false };
    markSendingNotificationsUnknown(context.sql, owner);
    const notification = claimNextNotification(context.sql, owner);
    if (notification === null) return { dispatched: false };
    const outcome = await sendTelegramNotification(context, notification.message);
    recordTelegramNotification(context.sql, {
      ...owner, notificationId: notification.notification_id, outcome, now: Date.now(),
    });
    return { dispatched: true };
  },
);

async function dispatchNotifications(
  context: WorkflowContext<typeof requirements>,
  repository: string,
  fencing: number,
  prefix: string,
): Promise<void> {
  for (let attempt = 0; attempt < maxItemsPerRun; attempt += 1) {
    const result = await context.step.runMutation(
      `dispatch-${prefix}-${attempt}`, dispatchNotificationMutation,
      { repository, runId: context.runId, fencing },
      { retries: { limit: 0, delay: 0 }, timeout: "30 seconds" },
    );
    if (!result.dispatched) return;
  }
}

interface RecoveryRepositoryRow extends Record<string, string | number | null | ArrayBuffer> {
  full_name: string;
  repository_id: number;
  review_worker_url: string;
}

const recoverQueueMutation = mutation(
  { title: "Recover Dependabot review work", input: emptyInput },
  async (context: MutationContext<typeof requirements>) => {
    const now = Date.now();
    const rows = context.sql.exec<RecoveryRepositoryRow>(
      "SELECT full_name, repository_id, review_worker_url FROM configured_repositories ORDER BY full_name",
    ).toArray();
    const configurations = new Map<string, Map<string, ConfiguredRepository>>();
    for (const row of rows) {
      const value = {
        repository: { fullName: row.full_name, id: row.repository_id },
        reviewWorkerUrl: row.review_worker_url,
      };
      const key = JSON.stringify([value.repository.id, value.reviewWorkerUrl]);
      const choices = configurations.get(row.full_name) ?? new Map<string, ConfiguredRepository>();
      choices.set(key, value);
      configurations.set(row.full_name, choices);
    }

    const runIds: string[] = [];
    for (const [repository, choices] of configurations) {
      if (choices.size !== 1 || !pendingWorkExists(context.sql, repository, now)) continue;
      const lock = context.sql.exec<{ lease_until: number }>(
        "SELECT lease_until FROM repository_locks WHERE repository = ?",
        repository,
      ).toArray()[0];
      if (lock !== undefined && lock.lease_until > now) continue;
      const run = await context.workflows.start({
        workflow: "processQueue",
        input: { repository },
        key: `recovery:${repository}:${Math.floor(now / 60_000)}`,
      });
      runIds.push(run.id);
    }
    return {
      started: runIds.length > 0,
      ...(runIds.length === 1 ? { runId: runIds[0] } : { runIds }),
    };
  },
);

const processQueueWorkflow = workflow(
  {
    input: repositoryInput,
    output: object({ processed: number() }),
    description: "Serialize Dependabot pull-request reviews, guarded merges, and Telegram notification records.",
  },
  async (context: WorkflowContext<typeof requirements>, input) => {
    const configuration = await context.step.runQuery(
      "resolve-repository-configuration",
      repositoryConfigurationQuery,
      { repository: input.repository },
    );
    if (configuration === null) throw new Error("Unsupported review repository.");
    const { repository, reviewWorkerUrl } = configuration;
    let processed = 0;
    let lockWaits = 0;
    let claimAttempts = 0;
    let lastFencing: number | null = null;
    while (processed < maxItemsPerRun) {
      const index = processed;
      const claim = await context.step.runMutation(
        `claim-${claimAttempts++}`,
        claimQueueMutation,
        { repository: repository.fullName, runId: context.runId, leaseMs },
      );
      if (claim.kind === "busy") {
        if (lockWaits >= maxLockWaits) return { processed };
        await context.step.sleep(`repository-lock-wait-${lockWaits}`, "30 seconds");
        lockWaits += 1;
        continue;
      }
      if (claim.kind === "idle") {
        await dispatchNotifications(context, repository.fullName, claim.fencing, `idle-${index}`);
        await context.step.runMutation(`release-idle-${index}`, releaseQueueMutation, {
          repository: repository.fullName,
          runId: context.runId,
          fencing: claim.fencing,
        });
        return { processed };
      }
      lockWaits = 0;
      lastFencing = claim.fencing;
      await processClaimedItem(
        context,
        claim.item,
        claim.fencing,
        index,
        repository,
        reviewWorkerUrl,
      );
      processed += 1;
    }
    if (lastFencing !== null) {
      await context.step.runMutation("release-run-limit", releaseQueueMutation, {
        repository: repository.fullName,
        runId: context.runId,
        fencing: lastFencing,
      });
    }
    return { processed };
  },
);

export function createLeasedReviewPort(
  context: WorkflowContext<typeof requirements>,
  item: QueueItem,
  fencing: number,
  repository: RepositoryConfig,
  reviewWorkerUrl: string,
): ReviewPort {
  let githubStep = 0;
  let reviewStep = 0;
  let mergeStep = 0;
  let leaseStep = 0;
  const nextName = (kind: string, counter: number): string => `${item.delivery_id}-${kind}-${counter}`;
  const refreshLease = async (): Promise<number> => {
    const leaseExpiresAt = await context.step.runMutation(
      nextName("lease-renew", leaseStep++),
      renewQueueMutation,
      { repository: repository.fullName, runId: context.runId, fencing, leaseMs },
    );
    if (leaseExpiresAt === null) throw new Error("The repository processing lease was lost.");
    return leaseExpiresAt;
  };
  const withLease = async <Output>(operation: () => Promise<Output>): Promise<Output> => {
    await refreshLease();
    const output = await operation();
    await refreshLease();
    return output;
  };
  return {
    readPullRequest: (pullRequest) => withLease(() => context.step.do(
      nextName("pull-request", githubStep++),
      { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "45 seconds" },
      (stepContext) => readPullRequest(githubReadContext(stepContext, repository), pullRequest),
    )),
    submitReview: (pullRequestUrl, operationId) => withLease(() => context.step.do(
      nextName("review-submit", reviewStep++),
      { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "45 seconds" },
      (stepContext) => submitReview(stepContext, reviewWorkerUrl, pullRequestUrl, operationId, repository.fullName),
    )),
    readReview: (reviewId) => withLease(() => context.step.do(
      nextName("review-status", reviewStep++),
      { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "45 seconds" },
      (stepContext) => readReviewStatus(stepContext, reviewWorkerUrl, reviewId),
    )),
    invalidate: async (reviewId) => {
      const leaseExpiresAt = await refreshLease();
      await context.step.do(
        nextName("review-invalidate", reviewStep++),
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "45 seconds" },
        (stepContext) => invalidateReview(stepContext, reviewWorkerUrl, reviewId, leaseExpiresAt),
      );
      await refreshLease();
    },
    mergeVerified: (input) => withLease(() => context.step.do(
      nextName("guarded-merge", mergeStep++),
      { retries: { limit: 0, delay: 0 }, timeout: "120 seconds" },
      (stepContext) => mergeReviewedPullRequest(stepContext, { ...input, repository, reviewWorkerUrl }),
    )),
    renewLease: async () => (await context.step.runMutation(
      nextName("lease-renew", leaseStep++),
      renewQueueMutation,
      { repository: repository.fullName, runId: context.runId, fencing, leaseMs },
    )) !== null,
    sleep: (name, duration) => context.step.sleep(`${item.delivery_id}-${name}`, duration),
  };
}

async function processClaimedItem(
  context: WorkflowContext<typeof requirements>,
  item: QueueItem,
  fencing: number,
  index: number,
  repository: RepositoryConfig,
  reviewWorkerUrl: string,
): Promise<void> {
  if (item.repository !== repository.fullName) {
    throw new Error("Claimed review item belongs to a different repository.");
  }
  const port = createLeasedReviewPort(context, item, fencing, repository, reviewWorkerUrl);
  const result = await processDependabotPullRequest(repository.fullName, item.pull_request_number, item.event_head_sha, item.event_base_sha, item.delivery_id, port);
  const notifications = await notificationsForResult(item, result);
  const complete = await context.step.runMutation(
    `finish-${item.delivery_id}-${index}`,
    finishQueueMutation,
    {
      completion: {
        repository: item.repository,
        deliveryId: item.delivery_id,
        runId: context.runId,
        fencing,
        state: result.state,
        ...(result.identity === null ? {} : { testedBaseSha: result.identity.testedBaseSha }),
        ...(result.snapshotHash === null ? {} : { snapshotHash: result.snapshotHash }),
        ...(result.decision === null ? {} : { reviewDecision: result.decision }),
        outcomeKind: result.kind,
        ...(result.failureCode === null ? {} : { failureCode: result.failureCode }),
        now: Date.now(),
        leaseMs,
      },
      notifications: notifications.map(({ testedBaseSha, ...notification }) => ({
        ...notification,
        ...(testedBaseSha === null ? {} : { testedBaseSha }),
      })),
    },
  );
  if (!complete) throw new Error("The review queue lease was lost before completion.");
  await dispatchNotifications(context, item.repository, fencing, `finished-${index}`);
}

export async function notificationsForResult(item: QueueItem, result: ProcessingResult): Promise<NotificationInput[]> {
  const notices: NotificationInput[] = [];
  for (const notice of result.notices) {
    if (notice.kind === "merged") continue;
    const identity = notice.identity ?? {
      repository: item.repository,
      pullRequest: item.pull_request_number,
      headSha: item.event_head_sha,
      testedBaseSha: null,
    };
    const dedupeKey = JSON.stringify({
      identity,
      webhookBaseSha: notice.identity === null ? item.event_base_sha : null,
      snapshotHash: notice.snapshotHash,
      kind: notice.kind,
    });
    const notificationId = await sha256Hex(dedupeKey);
    notices.push({
      notificationId,
      dedupeKey,
      repository: item.repository,
      pullRequestNumber: item.pull_request_number,
      headSha: identity.headSha,
      testedBaseSha: identity.testedBaseSha,
      kind: notice.kind,
      message: notificationMessage(item, notice, identity, result.failureCode),
      now: Date.now(),
    });
  }
  return notices;
}

// Failure codes are local constants, never arbitrary service/model strings.
const notificationFailureCodes = new Set([
  "head_changed", "base_changed", "identity_conflict", "invalid_pull_request",
  "invalid_reviewer_response", "lease_lost", "merge_blocked", "processing_failure",
  "pull_request_changed", "pull_request_changed_before_review", "pull_request_no_longer_reviewable",
  "pull_request_changed_before_merge", "pull_request_draft_or_unproven", "pull_request_not_mergeable",
  "pull_request_not_open", "pull_request_outside_repository", "review_identity_conflict",
  "review_identity_not_current", "review_result_missing", "review_stale", "review_timeout",
  "review_changed_before_merge", "webhook_identity_unproven", "ci_failed", "ci_unproven",
  "ci_identity_mismatch", "required_ci_failed", "required_ci_unproven", "title_changed",
  "not_default_branch_target", "not_dependabot", "snapshot_unavailable", "stored_result_unreadable",
  "invalidated_by_executor", "merge_outcome_unknown", "merge_outcome_unverified", "merge_rejected",
  "merge_result_unverified", "reauth_required", "model_unavailable", "invalid_model_output",
  "operation_identity_mismatch",
]);

function notificationMessage(
  item: QueueItem,
  notice: ProcessingNotice,
  identity: { repository: string; pullRequest: number; headSha: string; testedBaseSha: string | null },
  failureCode: string | null,
): string {
  const code = failureCode && notificationFailureCodes.has(failureCode) ? failureCode : "review_attention";
  const lines = [
    `Dependabot review: ${notice.kind}`,
    `Pull request: https://github.com/${item.repository}/pull/${item.pull_request_number}`,
    `Head: ${identity.headSha}`,
    `Tested base: ${identity.testedBaseSha ?? "not established"}`,
    `Failure code: ${code}`,
  ];
  if (notice.verdict !== undefined) {
    lines.push(`Standards: ${notice.verdict.standards.status} (${notice.verdict.standards.findings.length})`);
    lines.push(`Change intent: ${notice.verdict.changeIntent.status} (${notice.verdict.changeIntent.findings.length})`);
  }
  return lines.join("\n");
}

export const processQueue = processQueueWorkflow;
export const recoveryMutation = recoverQueueMutation;
export const recentReviewsQuery = query(
  { title: "Dependabot review results", input: object({ repository: string(), limit: number().optional() }) },
  async (context: QueryContext<typeof requirements>, { repository, limit }) => {
    if (resolveConfiguredRepository(context.sql, repository) === null) return [];
    return context.sql.exec(
      `SELECT q.delivery_id, q.repository, q.pull_request_number, r.pull_request_url, q.event_head_sha, q.event_base_sha,
         q.state, q.tested_base_sha, q.snapshot_hash, q.review_decision, q.outcome_kind, q.failure_code,
         q.attempts, q.received_at, q.updated_at
       FROM review_queue q JOIN webhook_receipts r ON r.delivery_id = q.delivery_id
       WHERE q.repository = ? ORDER BY q.received_at DESC, q.delivery_id ASC LIMIT ?`,
      repository,
      boundedLimit(limit, 20),
    ).toArray();
  },
);

export const notificationStatusQuery = query(
  { title: "Telegram notification status", input: object({ repository: string(), limit: number().optional() }) },
  async (context: QueryContext<typeof requirements>, { repository, limit }) => {
    if (resolveConfiguredRepository(context.sql, repository) === null) return [];
    return context.sql.exec(
      `SELECT n.notification_id, n.repository, n.pull_request_number,
         'https://github.com/' || n.repository || '/pull/' || n.pull_request_number AS pull_request_url,
         n.head_sha, n.tested_base_sha, n.kind, n.status, n.failure_code, n.attempts, n.next_attempt_at, n.created_at, n.updated_at
       FROM notification_outbox n WHERE n.repository = ?
       ORDER BY n.created_at DESC, n.notification_id ASC LIMIT ?`,
      repository,
      boundedLimit(limit, 20),
    ).toArray();
  },
);
