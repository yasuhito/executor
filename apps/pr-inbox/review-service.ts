import type { WorkflowStepContext } from "apps";
import { parseReviewIdentity, parseReviewVerdict } from "./review-protocol/core.ts";
import { parsePullRequestUrl } from "./review-protocol/github-read.ts";
import { signRequest } from "./review-protocol/auth.ts";
import type { requirements } from "./providers.ts";
import type { ReviewServiceResult } from "./review-flow.ts";

export type ReviewServiceContext = WorkflowStepContext<typeof requirements>;
const requestTimeoutMs = 30_000;
const operationIdPattern = /^[0-9a-f]{64}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const shaPattern = /^[0-9a-f]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCandidate(value: unknown): ReviewServiceResult["candidate"] | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.headSha !== "string" || !shaPattern.test(value.headSha) || typeof value.baseSha !== "string" || !shaPattern.test(value.baseSha)) return null;
  return { headSha: value.headSha.toLowerCase(), baseSha: value.baseSha.toLowerCase() };
}

function parseServiceResult(value: unknown): ReviewServiceResult | null {
  if (!isRecord(value) || typeof value.reviewId !== "string" || !digestPattern.test(value.reviewId)) return null;
  const statuses: ReviewServiceResult["status"][] = ["awaiting_ci", "waiting_for_github", "pending", "complete", "stale", "identity_conflict"];
  if (typeof value.status !== "string" || !statuses.includes(value.status as ReviewServiceResult["status"])) return null;
  const candidate = parseCandidate(value.candidate);
  if (candidate === null) return null;
  const parsedIdentity = value.identity === undefined ? undefined : parseReviewIdentity(value.identity);
  if (value.identity !== undefined && parsedIdentity === null) return null;
  const identity = parsedIdentity ?? undefined;
  if (value.snapshotHash !== undefined && (typeof value.snapshotHash !== "string" || !digestPattern.test(value.snapshotHash))) return null;
  if (value.titleHash !== undefined && (typeof value.titleHash !== "string" || !digestPattern.test(value.titleHash))) return null;
  if (value.retryAfterMs !== undefined && (typeof value.retryAfterMs !== "number" || !Number.isSafeInteger(value.retryAfterMs) || value.retryAfterMs < 0 || value.retryAfterMs > 15 * 60_000)) return null;
  if (value.failureCode !== undefined && (typeof value.failureCode !== "string" || value.failureCode.length === 0 || value.failureCode.length > 80)) return null;
  if (value.status === "complete") {
    if (value.verdict !== undefined) {
      const verdict = parseReviewVerdict(JSON.stringify(value.verdict));
      if (verdict === null || identity === undefined || value.snapshotHash === undefined || value.titleHash === undefined) return null;
      return {
        status: "complete",
        reviewId: value.reviewId,
        identity,
        snapshotHash: value.snapshotHash,
        titleHash: value.titleHash,
        verdict,
      };
    }
    if (typeof value.failureCode !== "string" || value.failureCode.length === 0) return null;
    return {
      status: "complete",
      reviewId: value.reviewId,
      ...(candidate === undefined ? {} : { candidate }),
      ...(identity === undefined ? {} : { identity }),
      ...(typeof value.snapshotHash === "string" ? { snapshotHash: value.snapshotHash } : {}),
      ...(typeof value.titleHash === "string" ? { titleHash: value.titleHash } : {}),
      failureCode: value.failureCode,
    };
  }
  if (value.status === "pending" && (identity === undefined || value.snapshotHash === undefined || value.titleHash === undefined)) return null;
  return {
    status: value.status as ReviewServiceResult["status"],
    reviewId: value.reviewId,
    ...(candidate === undefined ? {} : { candidate }),
    ...(identity === undefined ? {} : { identity }),
    ...(typeof value.snapshotHash === "string" ? { snapshotHash: value.snapshotHash } : {}),
    ...(typeof value.titleHash === "string" ? { titleHash: value.titleHash } : {}),
    ...(typeof value.failureCode === "string" ? { failureCode: value.failureCode } : {}),
    ...(typeof value.retryAfterMs === "number" ? { retryAfterMs: value.retryAfterMs } : {}),
  };
}

async function sendSigned(
  context: ReviewServiceContext,
  workerUrl: string,
  path: "/v1/review" | "/v1/status" | "/v1/invalidate",
  value: unknown,
): Promise<ReviewServiceResult | null> {
  const body = JSON.stringify(value);
  const bytes = new TextEncoder().encode(body);
  const signature = await signRequest(context.app.accounts.reviewService.fields.hmacSecret, "POST", path, bytes);
  let response: Response;
  try {
    const origin = new URL(workerUrl);
    if (origin.protocol !== "https:" || origin.origin !== workerUrl) {
      throw new Error("Invalid review service URL.");
    }
    response = await context.fetch(`${workerUrl}${path}`, {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(requestTimeoutMs)]),
      headers: {
        "content-type": "application/json",
        "x-executor-timestamp": signature.timestamp,
        "x-executor-nonce": signature.nonce,
        "x-executor-signature": signature.signature,
      },
      body,
    });
  } catch {
    throw new Error("Review service request failed.");
  }
  if (response.status === 404) return null;
  if (![200, 202, 409, 503].includes(response.status)) throw new Error(`Review service returned HTTP ${response.status}.`);
  let responseValue: unknown;
  try {
    responseValue = await response.json();
  } catch {
    throw new Error("Review service returned invalid JSON.");
  }
  if (response.status === 409 && isRecord(responseValue) && responseValue.status === "replayed_request") {
    throw new Error("Review service rejected a replayed request nonce.");
  }
  const parsed = parseServiceResult(responseValue);
  if (response.status === 503 && parsed?.status !== "waiting_for_github") throw new Error("Review service is unavailable.");
  return parsed;
}

export async function submitReview(
  context: ReviewServiceContext,
  workerUrl: string,
  pullRequestUrl: string,
  operationId: string,
  repository: string,
): Promise<ReviewServiceResult | null> {
  const parsedUrl = parsePullRequestUrl(pullRequestUrl);
  if (
    parsedUrl === null ||
    parsedUrl.repository !== repository ||
    !operationIdPattern.test(operationId)
  ) {
    throw new Error("Invalid URL-only review request.");
  }
  return sendSigned(context, workerUrl, "/v1/review", { pullRequestUrl, operationId });
}

export async function readReviewStatus(context: ReviewServiceContext, workerUrl: string, reviewId: string): Promise<ReviewServiceResult | null> {
  if (!digestPattern.test(reviewId)) throw new Error("Invalid review operation identity.");
  return sendSigned(context, workerUrl, "/v1/status", { reviewId });
}

export async function invalidateReview(context: ReviewServiceContext, workerUrl: string, reviewId: string, leaseExpiresAt: number): Promise<void> {
  const result = await sendSigned(context, workerUrl, "/v1/invalidate", { reviewId, leaseExpiresAt });
  if (result === null || result.reviewId !== reviewId || result.status !== "stale") {
    throw new Error("Review service did not confirm invalidation.");
  }
}
