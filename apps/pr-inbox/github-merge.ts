import { parseReviewIdentity, parseReviewVerdict, sha256Hex, type ReviewIdentity } from "./review-protocol/core.ts";
import { GitHubRateLimitError, readPullRequest, readRequiredCi, type PullRequestObservation } from "./review-protocol/github-read.ts";
import type { MergeOutcome } from "./review-flow.ts";
import { githubReadContext, githubRequest, githubResponseJson, requireGitHubStatus, type GitHubWorkflowContext } from "./github-api.ts";
import { repositoryPath, type RepositoryConfig } from "./repositories.ts";
import { readReviewStatus } from "./review-service.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reviewMatches(
  value: Awaited<ReturnType<typeof readReviewStatus>>,
  input: { reviewId: string; identity: ReviewIdentity; snapshotHash: string; titleHash: string },
): boolean {
  if (value === null || value.status !== "complete" || value.reviewId !== input.reviewId) return false;
  const identity = parseReviewIdentity(value.identity);
  const verdict = value.verdict === undefined ? null : parseReviewVerdict(JSON.stringify(value.verdict));
  return identity !== null &&
    identity.repository === input.identity.repository &&
    identity.pullRequest === input.identity.pullRequest &&
    identity.headSha === input.identity.headSha &&
    identity.testedBaseSha === input.identity.testedBaseSha &&
    value.snapshotHash === input.snapshotHash &&
    value.titleHash === input.titleHash &&
    value.failureCode === undefined &&
    verdict?.decision === "reviewable";
}

function classifyPullRequest(
  pullRequest: PullRequestObservation,
  input: { identity: ReviewIdentity },
): MergeOutcome | null {
  if (pullRequest.repository !== input.identity.repository || pullRequest.headRepository !== input.identity.repository || pullRequest.baseRepository !== input.identity.repository) {
    return { status: "blocked", failureCode: "pull_request_outside_repository" };
  }
  if (pullRequest.headSha !== input.identity.headSha) return { status: "stale", failureCode: "head_changed" };
  if (pullRequest.baseSha !== input.identity.testedBaseSha) return { status: "stale", failureCode: "base_changed" };
  if (pullRequest.state !== "open" || pullRequest.merged !== false) return { status: "blocked", failureCode: "pull_request_not_open" };
  if (pullRequest.draft !== false) return { status: "blocked", failureCode: "pull_request_draft_or_unproven" };
  return null;
}

async function readMergeCandidate(
  context: GitHubWorkflowContext,
  input: { identity: ReviewIdentity; titleHash: string; repository: RepositoryConfig },
): Promise<{ pullRequest: PullRequestObservation } | { outcome: MergeOutcome }> {
  const pullRequest = await readPullRequest(githubReadContext(context, input.repository), input.identity.pullRequest);
  const basic = classifyPullRequest(pullRequest, input);
  if (basic !== null) return { outcome: basic };
  if (await sha256Hex(pullRequest.title) !== input.titleHash) return { outcome: { status: "stale", failureCode: "title_changed" } };
  if (pullRequest.baseRef !== pullRequest.defaultBranch) return { outcome: { status: "blocked", failureCode: "not_default_branch_target" } };
  if (pullRequest.authorLogin !== "dependabot[bot]" || pullRequest.authorType !== "Bot") return { outcome: { status: "blocked", failureCode: "not_dependabot" } };
  if (pullRequest.mergeable === null || pullRequest.mergeableState === "unknown") {
    return { outcome: { status: "retry", retryAfterMs: 30_000 } };
  }
  if (pullRequest.mergeable !== true || pullRequest.mergeableState !== "clean") {
    return { outcome: { status: "blocked", failureCode: "pull_request_not_mergeable" } };
  }
  return { pullRequest };
}

function verifyMergeResponse(value: unknown): { sha: string } | null {
  if (!isRecord(value) || value.merged !== true || typeof value.sha !== "string" || !/^[0-9a-f]{40}$/i.test(value.sha)) return null;
  return { sha: value.sha.toLowerCase() };
}

async function readBackMerge(
  context: GitHubWorkflowContext,
  input: { identity: ReviewIdentity; titleHash: string; repository: RepositoryConfig },
  expectedMergeSha?: string,
): Promise<MergeOutcome> {
  try {
    const pullRequest = await readPullRequest(githubReadContext(context, input.repository), input.identity.pullRequest);
    if (expectedMergeSha !== undefined) {
      if (pullRequest.headSha !== input.identity.headSha) return { status: "stale", failureCode: "head_changed" };
      if (pullRequest.state !== "closed" || pullRequest.merged !== true || pullRequest.mergeCommitSha !== expectedMergeSha) {
        return { status: "blocked", failureCode: "merge_result_unverified" };
      }
      if (await sha256Hex(pullRequest.title) !== input.titleHash) return { status: "stale", failureCode: "title_changed" };
      return { status: "merged" };
    }
    if (
      pullRequest.state === "closed" && pullRequest.merged === true &&
      pullRequest.headSha === input.identity.headSha
    ) {
      if (await sha256Hex(pullRequest.title) !== input.titleHash) return { status: "stale", failureCode: "title_changed" };
      return { status: "blocked", failureCode: "merge_outcome_unverified" };
    }
    const state = classifyPullRequest(pullRequest, input);
    if (state?.status === "stale") return state;
    return { status: "blocked", failureCode: "merge_outcome_unknown" };
  } catch {
    return { status: "blocked", failureCode: "merge_outcome_unknown" };
  }
}

function requiredCiOutcome(
  ci: Awaited<ReturnType<typeof readRequiredCi>>,
  identity: ReviewIdentity,
): MergeOutcome | null {
  if (ci.kind === "pending") return { status: "retry", retryAfterMs: 60_000 };
  if (ci.kind === "failed") return { status: "blocked", failureCode: "required_ci_failed" };
  if (ci.kind === "unproven") return { status: "blocked", failureCode: "required_ci_unproven" };
  if (ci.testedHeadSha !== identity.headSha || ci.testedBaseSha !== identity.testedBaseSha) {
    return { status: "stale", failureCode: "ci_identity_mismatch" };
  }
  return null;
}

export async function mergeReviewedPullRequest(
  context: GitHubWorkflowContext,
  input: { reviewId: string; identity: ReviewIdentity; snapshotHash: string; titleHash: string; repository: RepositoryConfig; reviewWorkerUrl: string },
): Promise<MergeOutcome> {
  try {
    const initial = await readPullRequest(githubReadContext(context, input.repository), input.identity.pullRequest);
    if (
      initial.state === "closed" && initial.merged === true &&
      initial.headSha === input.identity.headSha
    ) {
      if (await sha256Hex(initial.title) !== input.titleHash) return { status: "stale", failureCode: "title_changed" };
      return { status: "blocked", failureCode: "merge_outcome_unverified" };
    }
    const initialState = classifyPullRequest(initial, input);
    if (initialState?.status === "stale" || initialState?.status === "blocked") return initialState;
    if (await sha256Hex(initial.title) !== input.titleHash) return { status: "stale", failureCode: "title_changed" };

    const review = await readReviewStatus(context, input.reviewWorkerUrl, input.reviewId);
    if (review?.status === "pending" || review?.status === "awaiting_ci" || review?.status === "waiting_for_github") {
      return { status: "retry", retryAfterMs: review.retryAfterMs ?? 60_000 };
    }
    if (!reviewMatches(review, input)) {
      return { status: "blocked", failureCode: review?.failureCode ?? "review_identity_not_current" };
    }
    const candidate = await readMergeCandidate(context, input);
    if ("outcome" in candidate) return candidate.outcome;
    const ci = await readRequiredCi(githubReadContext(context, input.repository), candidate.pullRequest);
    const ciOutcome = requiredCiOutcome(ci, input.identity);
    if (ciOutcome !== null) return ciOutcome;

    const latestReview = await readReviewStatus(context, input.reviewWorkerUrl, input.reviewId);
    if (!reviewMatches(latestReview, input)) return { status: "stale", failureCode: "review_changed_before_merge" };

    const finalCandidate = await readMergeCandidate(context, input);
    if ("outcome" in finalCandidate) return finalCandidate.outcome;
    if (
      finalCandidate.pullRequest.headSha !== candidate.pullRequest.headSha ||
      finalCandidate.pullRequest.baseSha !== candidate.pullRequest.baseSha ||
      finalCandidate.pullRequest.title !== candidate.pullRequest.title
    ) return { status: "stale", failureCode: "pull_request_changed_before_merge" };

    let mergeResponse: Response;
    try {
      mergeResponse = await githubRequest(
        context,
        input.repository,
        `${repositoryPath(input.repository)}/pulls/${input.identity.pullRequest}/merge`,
        "PUT",
        { sha: input.identity.headSha },
      );
    } catch {
      return readBackMerge(context, input);
    }
    if (mergeResponse.status !== 200) {
      const readBack = await readBackMerge(context, input);
      return readBack.status === "merged" || readBack.status === "stale" || readBack.failureCode === "merge_outcome_unverified"
        ? readBack
        : { status: "blocked", failureCode: "merge_rejected" };
    }

    let mergeResult: { sha: string } | null;
    try {
      requireGitHubStatus(mergeResponse, 200);
      mergeResult = verifyMergeResponse(await githubResponseJson(mergeResponse));
    } catch {
      mergeResult = null;
    }
    if (mergeResult === null) return readBackMerge(context, input);
    return readBackMerge(context, input, mergeResult.sha);
  } catch (error) {
    if (error instanceof GitHubRateLimitError) {
      return { status: "retry", retryAfterMs: error.retryAfterMs };
    }
    throw error;
  }
}
