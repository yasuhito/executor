import {
  parseReviewIdentity,
  parseReviewVerdict,
  sha256Hex,
  type ReviewIdentity,
  type ReviewVerdict,
} from "./review-protocol/core.ts";
import type { PullRequestObservation } from "./review-protocol/github-read.ts";

export type NotificationKind = "merged" | "needs-attention" | "stale";

export interface ReviewCandidate {
  headSha: string;
  baseSha: string;
}

export interface ReviewServiceResult {
  status:
    | "awaiting_ci"
    | "waiting_for_github"
    | "pending"
    | "complete"
    | "stale"
    | "identity_conflict";
  reviewId: string;
  candidate?: ReviewCandidate;
  identity?: ReviewIdentity;
  snapshotHash?: string;
  titleHash?: string;
  verdict?: ReviewVerdict;
  failureCode?: string;
  retryAfterMs?: number;
}

export interface MergeOutcome {
  status: "merged" | "retry" | "blocked" | "stale";
  failureCode?: string;
  retryAfterMs?: number;
}

export interface ReviewPort {
  readPullRequest(pullRequest: number): Promise<PullRequestObservation>;
  submitReview(pullRequestUrl: string, operationId: string): Promise<ReviewServiceResult | null>;
  readReview(reviewId: string): Promise<ReviewServiceResult | null>;
  invalidate(reviewId: string): Promise<void>;
  mergeVerified(input: {
    reviewId: string;
    identity: ReviewIdentity;
    snapshotHash: string;
    titleHash: string;
  }): Promise<MergeOutcome>;
  renewLease(): Promise<boolean>;
  sleep(name: string, duration: string): Promise<void>;
}

export interface ProcessingNotice {
  kind: NotificationKind;
  identity: ReviewIdentity | null;
  snapshotHash: string | null;
  detail: string;
  verdict?: ReviewVerdict;
}

export interface ProcessingResult {
  state: "complete" | "needs-attention" | "stale";
  kind: NotificationKind;
  identity: ReviewIdentity | null;
  snapshotHash: string | null;
  decision: "reviewable" | "needs-attention" | null;
  failureCode: string | null;
  detail: string;
  verdict?: ReviewVerdict;
  notices: ProcessingNotice[];
}

const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const maxReviewPolls = 240;
const maxMergeWaits = 120;
const reviewUrl = (repository: string, pullRequest: number) =>
  `https://github.com/${repository}/pull/${pullRequest}`;

type PullRequestCheck =
  | { kind: "valid" }
  | { kind: "stale"; failureCode: "head_changed" | "base_changed"; detail: string }
  | { kind: "unproven"; detail: string };

function validatePullRequest(
  pullRequest: PullRequestObservation,
  expectedHeadSha: string,
  expectedBaseSha: string,
  repository: string,
): PullRequestCheck {
  if (
    pullRequest.repository !== repository ||
    pullRequest.headRepository !== repository ||
    pullRequest.baseRepository !== repository
  )
    return {
      kind: "unproven",
      detail: "The pull request is not confined to the target repository.",
    };
  if (
    pullRequest.state !== "open" ||
    pullRequest.authorLogin !== "dependabot[bot]" ||
    pullRequest.authorType !== "Bot"
  ) {
    return { kind: "unproven", detail: "The pull request is not an open Dependabot request." };
  }
  if (pullRequest.baseRef !== pullRequest.defaultBranch)
    return {
      kind: "unproven",
      detail: "The pull request does not target the repository default branch.",
    };
  if (!shaPattern.test(pullRequest.headSha) || !shaPattern.test(pullRequest.baseSha)) {
    return {
      kind: "unproven",
      detail: "The pull request lacks valid head or base commit identities.",
    };
  }
  if (pullRequest.headSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
    return {
      kind: "stale",
      failureCode: "head_changed",
      detail: "The pull request head changed after its webhook event.",
    };
  }
  if (pullRequest.baseSha.toLowerCase() !== expectedBaseSha.toLowerCase()) {
    return {
      kind: "stale",
      failureCode: "base_changed",
      detail: "The pull request base changed after its webhook event.",
    };
  }
  return { kind: "valid" };
}

function validCandidate(value: unknown): ReviewCandidate | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.headSha !== "string" ||
    !shaPattern.test(candidate.headSha) ||
    typeof candidate.baseSha !== "string" ||
    !shaPattern.test(candidate.baseSha)
  )
    return undefined;
  return { headSha: candidate.headSha.toLowerCase(), baseSha: candidate.baseSha.toLowerCase() };
}

function validateServiceResult(
  value: ReviewServiceResult | null,
  expectedReviewId: string,
  pullRequestNumber: number,
  repository: string,
): ReviewServiceResult | null {
  if (value === null || typeof value !== "object" || value.reviewId !== expectedReviewId)
    return null;
  if (
    !digestPattern.test(value.reviewId) ||
    ![
      "awaiting_ci",
      "waiting_for_github",
      "pending",
      "complete",
      "stale",
      "identity_conflict",
    ].includes(value.status)
  )
    return null;
  const candidate = value.candidate === undefined ? undefined : validCandidate(value.candidate);
  if (value.candidate !== undefined && candidate === undefined) return null;
  const parsedIdentity =
    value.identity === undefined ? undefined : parseReviewIdentity(value.identity);
  if (value.identity !== undefined && parsedIdentity === null) return null;
  const identity = parsedIdentity ?? undefined;
  if (
    identity !== undefined &&
    (identity.pullRequest !== pullRequestNumber || identity.repository !== repository)
  )
    return null;
  if (
    value.snapshotHash !== undefined &&
    (typeof value.snapshotHash !== "string" || !digestPattern.test(value.snapshotHash))
  )
    return null;
  if (
    value.titleHash !== undefined &&
    (typeof value.titleHash !== "string" || !digestPattern.test(value.titleHash))
  )
    return null;
  if (
    value.retryAfterMs !== undefined &&
    (typeof value.retryAfterMs !== "number" ||
      !Number.isSafeInteger(value.retryAfterMs) ||
      value.retryAfterMs < 0 ||
      value.retryAfterMs > 15 * 60_000)
  )
    return null;
  if (
    value.failureCode !== undefined &&
    (typeof value.failureCode !== "string" ||
      value.failureCode.length === 0 ||
      value.failureCode.length > 80)
  )
    return null;
  if (value.status === "complete") {
    if (value.verdict !== undefined) {
      const verdict = parseReviewVerdict(JSON.stringify(value.verdict));
      if (
        verdict === null ||
        identity === undefined ||
        value.snapshotHash === undefined ||
        value.titleHash === undefined
      )
        return null;
      return { ...value, candidate, identity, verdict };
    }
    if (value.failureCode === undefined) return null;
  }
  if (
    value.status === "pending" &&
    (identity === undefined || value.snapshotHash === undefined || value.titleHash === undefined)
  )
    return null;
  return {
    ...value,
    ...(candidate === undefined ? {} : { candidate }),
    ...(identity === undefined ? {} : { identity }),
  };
}

function outcome(
  state: ProcessingResult["state"],
  kind: NotificationKind,
  identity: ReviewIdentity | null,
  snapshotHash: string | null,
  decision: ProcessingResult["decision"],
  failureCode: string | null,
  detail: string,
  verdict?: ReviewVerdict,
): ProcessingResult {
  const notice: ProcessingNotice = {
    kind,
    identity,
    snapshotHash,
    detail,
    ...(verdict === undefined ? {} : { verdict }),
  };
  return {
    state,
    kind,
    identity,
    snapshotHash,
    decision,
    failureCode,
    detail,
    ...(verdict === undefined ? {} : { verdict }),
    notices: [notice],
  };
}

function resultFromReviewFailure(
  identity: ReviewIdentity | null,
  snapshotHash: string | null,
  failureCode: string,
  detail: string,
): ProcessingResult {
  return outcome(
    "needs-attention",
    "needs-attention",
    identity,
    snapshotHash,
    "needs-attention",
    failureCode,
    detail,
  );
}

function pollDuration(response: ReviewServiceResult): string {
  if (response.status === "pending") return "15 seconds";
  const milliseconds = Math.max(15_000, Math.min(15 * 60_000, response.retryAfterMs ?? 60_000));
  return `${Math.ceil(milliseconds / 1_000)} seconds`;
}

async function checkLiveCandidate(
  port: ReviewPort,
  pullRequestNumber: number,
  expectedHeadSha: string,
  expectedBaseSha: string,
  repository: string,
  response: ReviewServiceResult,
): Promise<
  { kind: "same" } | { kind: "head_changed" } | { kind: "base_changed" } | { kind: "invalid" }
> {
  const current = await port.readPullRequest(pullRequestNumber);
  const validation = validatePullRequest(current, expectedHeadSha, expectedBaseSha, repository);
  if (validation.kind === "stale") return { kind: validation.failureCode };
  if (validation.kind === "unproven") return { kind: "invalid" };
  const candidate =
    response.candidate ??
    (response.identity === undefined
      ? undefined
      : {
          headSha: response.identity.headSha,
          baseSha: response.identity.testedBaseSha,
        });
  if (candidate === undefined) return { kind: "same" };
  if (candidate.headSha !== current.headSha.toLowerCase()) return { kind: "head_changed" };
  if (candidate.baseSha !== current.baseSha.toLowerCase()) return { kind: "base_changed" };
  if (response.titleHash !== undefined && (await sha256Hex(current.title)) !== response.titleHash)
    return { kind: "invalid" };
  return { kind: "same" };
}

export async function processDependabotPullRequest(
  repository: string,
  pullRequestNumber: number,
  expectedHeadSha: string,
  expectedBaseSha: string | null,
  deliveryId: string,
  port: ReviewPort,
): Promise<ProcessingResult> {
  let activeIdentity: ReviewIdentity | null = null;
  let activeSnapshotHash: string | null = null;
  try {
    if (
      !shaPattern.test(expectedHeadSha) ||
      expectedBaseSha === null ||
      !shaPattern.test(expectedBaseSha)
    ) {
      return resultFromReviewFailure(
        null,
        null,
        "webhook_identity_unproven",
        "The webhook did not provide valid head and base commit identities.",
      );
    }
    const initial = await port.readPullRequest(pullRequestNumber);
    const initialValidation = validatePullRequest(
      initial,
      expectedHeadSha,
      expectedBaseSha,
      repository,
    );
    if (initialValidation.kind === "stale") {
      return outcome(
        "stale",
        "stale",
        null,
        null,
        null,
        initialValidation.failureCode,
        initialValidation.detail,
      );
    }
    if (initialValidation.kind === "unproven")
      return resultFromReviewFailure(null, null, "invalid_pull_request", initialValidation.detail);

    const operationId = await sha256Hex(`executor-dependabot-review-v1:${deliveryId}:base:0`);
    const expectedReviewId = await sha256Hex(`executor-review-operation-v1:${operationId}`);
    let response = validateServiceResult(
      await port.submitReview(reviewUrl(repository, pullRequestNumber), operationId),
      expectedReviewId,
      pullRequestNumber,
      repository,
    );
    if (response === null)
      return resultFromReviewFailure(
        null,
        null,
        "invalid_reviewer_response",
        "The review service returned a missing or mismatched operation result.",
      );
    if (response.status === "identity_conflict")
      return resultFromReviewFailure(
        response.identity ?? null,
        response.snapshotHash ?? null,
        "review_identity_conflict",
        "The review service rejected an operation ID already bound to different input.",
      );

    for (let poll = 0; poll < maxReviewPolls; poll += 1) {
      if (response.candidate !== undefined) {
        if (response.candidate.headSha !== expectedHeadSha.toLowerCase()) {
          await port.invalidate(response.reviewId);
          return outcome(
            "stale",
            "stale",
            response.identity ?? null,
            response.snapshotHash ?? null,
            null,
            "head_changed",
            "The resolved pull-request head differs from the webhook event.",
          );
        }
        if (response.candidate.baseSha !== expectedBaseSha.toLowerCase()) {
          await port.invalidate(response.reviewId);
          return outcome(
            "stale",
            "stale",
            response.identity ?? null,
            response.snapshotHash ?? null,
            null,
            "base_changed",
            "The resolved pull-request base differs from the webhook event.",
          );
        }
      }
      if (response.identity !== undefined) {
        if (response.identity.headSha !== expectedHeadSha.toLowerCase()) {
          await port.invalidate(response.reviewId);
          return outcome(
            "stale",
            "stale",
            response.identity,
            response.snapshotHash ?? null,
            null,
            "head_changed",
            "The reviewed head differs from the webhook event.",
          );
        }
        if (response.identity.testedBaseSha !== expectedBaseSha.toLowerCase()) {
          await port.invalidate(response.reviewId);
          return outcome(
            "stale",
            "stale",
            response.identity,
            response.snapshotHash ?? null,
            null,
            "base_changed",
            "The tested base differs from the webhook event.",
          );
        }
        activeIdentity = response.identity;
      }
      if (response.snapshotHash !== undefined) activeSnapshotHash = response.snapshotHash;

      if (response.status === "stale") {
        const live = await checkLiveCandidate(
          port,
          pullRequestNumber,
          expectedHeadSha,
          expectedBaseSha,
          repository,
          response,
        );
        if (live.kind === "head_changed")
          return outcome(
            "stale",
            "stale",
            response.identity ?? null,
            response.snapshotHash ?? null,
            null,
            "head_changed",
            "The pull-request head changed while the review was running.",
          );
        if (live.kind === "base_changed")
          return outcome(
            "stale",
            "stale",
            response.identity ?? null,
            response.snapshotHash ?? null,
            null,
            "base_changed",
            "The pull-request base changed while the review was running.",
          );
        return outcome(
          "stale",
          "stale",
          response.identity ?? null,
          response.snapshotHash ?? null,
          null,
          response.failureCode ?? "review_stale",
          "The review operation became stale and cannot be reused.",
        );
      }
      if (response.status === "complete") {
        if (
          response.failureCode !== undefined ||
          response.verdict === undefined ||
          response.identity === undefined ||
          response.snapshotHash === undefined ||
          response.titleHash === undefined
        ) {
          return resultFromReviewFailure(
            response.identity ?? null,
            response.snapshotHash ?? null,
            response.failureCode ?? "review_result_missing",
            "The review service could not produce a complete, identity-bound two-axis result.",
          );
        }
        if (response.verdict.decision !== "reviewable") {
          return outcome(
            "needs-attention",
            "needs-attention",
            response.identity,
            response.snapshotHash,
            "needs-attention",
            null,
            "At least one review axis found a concern or lacked sufficient evidence.",
            response.verdict,
          );
        }
        let mergeOutcome: MergeOutcome = { status: "retry", retryAfterMs: 0 };
        for (let mergeWait = 0; mergeWait < maxMergeWaits; mergeWait += 1) {
          if (!(await port.renewLease()))
            return resultFromReviewFailure(
              response.identity,
              response.snapshotHash,
              "lease_lost",
              "The repository processing lease was lost before final merge checks.",
            );
          mergeOutcome = await port.mergeVerified({
            reviewId: response.reviewId,
            identity: response.identity,
            snapshotHash: response.snapshotHash,
            titleHash: response.titleHash,
          });
          if (mergeOutcome.status !== "retry") break;
          await port.sleep(
            `merge-wait-${mergeWait}`,
            `${Math.max(15, Math.min(900, Math.ceil((mergeOutcome.retryAfterMs ?? 60_000) / 1_000)))} seconds`,
          );
        }
        if (mergeOutcome.status === "merged") {
          return outcome(
            "complete",
            "merged",
            response.identity,
            response.snapshotHash,
            "reviewable",
            null,
            "Both review axes passed and the exact reviewed pull request was merged.",
            response.verdict,
          );
        }
        if (mergeOutcome.status === "stale") {
          await port.invalidate(response.reviewId);
          return outcome(
            "stale",
            "stale",
            response.identity,
            response.snapshotHash,
            null,
            mergeOutcome.failureCode ?? "pull_request_changed",
            "The pull request changed before the guarded merge could complete.",
            response.verdict,
          );
        }
        return resultFromReviewFailure(
          response.identity,
          response.snapshotHash,
          mergeOutcome.failureCode ?? "merge_blocked",
          "The guarded merge checks did not all pass; no merge was recorded.",
        );
      }

      const live = await checkLiveCandidate(
        port,
        pullRequestNumber,
        expectedHeadSha,
        expectedBaseSha,
        repository,
        response,
      );
      if (live.kind === "head_changed") {
        await port.invalidate(response.reviewId);
        return outcome(
          "stale",
          "stale",
          response.identity ?? null,
          response.snapshotHash ?? null,
          null,
          "head_changed",
          "The pull-request head changed while waiting for review.",
        );
      }
      if (live.kind === "base_changed") {
        await port.invalidate(response.reviewId);
        return outcome(
          "stale",
          "stale",
          response.identity ?? null,
          response.snapshotHash ?? null,
          null,
          "base_changed",
          "The pull-request base changed while waiting for review.",
        );
      }
      if (live.kind === "invalid")
        return resultFromReviewFailure(
          response.identity ?? null,
          response.snapshotHash ?? null,
          "pull_request_changed",
          "The current pull request is no longer the exact candidate being reviewed.",
        );
      if (!(await port.renewLease()))
        return resultFromReviewFailure(
          response.identity ?? null,
          response.snapshotHash ?? null,
          "lease_lost",
          "The repository processing lease was lost during review.",
        );
      await port.sleep(`review-wait-${poll}`, pollDuration(response));
      response = validateServiceResult(
        await port.readReview(expectedReviewId),
        expectedReviewId,
        pullRequestNumber,
        repository,
      );
      if (response === null)
        return resultFromReviewFailure(
          activeIdentity,
          activeSnapshotHash,
          "invalid_reviewer_response",
          "The review service returned a missing or identity-mismatched status.",
        );
      if (response.status === "identity_conflict")
        return resultFromReviewFailure(
          response.identity ?? activeIdentity,
          response.snapshotHash ?? activeSnapshotHash,
          "review_identity_conflict",
          "The review service rejected an operation ID already bound to different input.",
        );
    }
    return resultFromReviewFailure(
      activeIdentity,
      activeSnapshotHash,
      "review_timeout",
      "The durable review did not reach a final result before the wait limit.",
    );
  } catch {
    return resultFromReviewFailure(
      activeIdentity,
      activeSnapshotHash,
      "processing_failure",
      "A required read-only check or guarded merge operation failed; no unverified result was accepted.",
    );
  }
}
