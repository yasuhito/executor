import {
  proveRequiredCi,
  type CheckRunEvidence,
  type CommitEvidence,
  type WorkflowRunEvidence,
} from "./ci-proof.ts";
import {
  parseReviewSnapshot,
  type ContextFile,
  type ReviewFile,
  type ReviewSnapshot,
} from "./core.ts";

export const apiOrigin = "https://api.github.com";

export interface RepositoryConfig {
  fullName: string;
  id: number;
}

function repositoryPath(repository: RepositoryConfig): string {
  return `/repos/${repository.fullName}`;
}
const apiTimeoutMs = 30_000;
const maxApiPages = 3;
const maxCiMergeCandidates = 10;
const maxInstructions = 30;
const maxContextBytes = 80 * 1024;

export interface PullRequestObservation {
  repository: string;
  pullRequest: number;
  state: string;
  authorLogin: string;
  authorType: string;
  headRepository: string;
  baseRepository: string;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  defaultBranch: string;
  title: string;
  draft: boolean | null;
  merged: boolean | null;
  mergeable: boolean | null;
  mergeableState: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface GitHubReadContext {
  repository: RepositoryConfig;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  signal: AbortSignal;
  headers?: HeadersInit;
}

export class GitHubRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super("GitHub public read rate limit reached.");
    this.name = "GitHubRateLimitError";
    this.retryAfterMs = Math.max(1_000, Math.min(15 * 60_000, retryAfterMs));
  }
}

export interface CanonicalPullRequestUrl {
  url: string;
  repository: string;
  pullRequestNumber: number;
}

export function parsePullRequestUrl(value: unknown): CanonicalPullRequestUrl | null {
  if (typeof value !== "string") return null;
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(value);
  if (match === null) return null;
  const pullRequestNumber = Number(match[2]);
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) return null;
  return { url: value, repository: match[1], pullRequestNumber };
}

function signalWithTimeout(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(apiTimeoutMs)]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function retryAfterMs(response: Response): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1_000;
  const reset = response.headers.get("x-ratelimit-reset");
  if (reset !== null && /^\d+$/.test(reset)) return Number(reset) * 1_000 - Date.now();
  return 60_000;
}

export async function githubResponse(context: GitHubReadContext, path: string): Promise<Response> {
  const repositoryBase = repositoryPath(context.repository);
  if (!path.startsWith(`${repositoryBase}/`) && path !== repositoryBase) {
    throw new Error("GitHub read path is outside the configured repository.");
  }
  let response: Response;
  try {
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "executor-review-worker",
    });
    for (const [name, value] of new Headers(context.headers)) headers.set(name, value);
    response = await context.fetch(`${apiOrigin}${path}`, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: signalWithTimeout(context.signal),
      headers,
    });
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    throw new Error("GitHub read request failed.");
  }
  if (response.status >= 300 && response.status < 400)
    throw new Error("GitHub read redirected the request.");
  if (
    response.status === 429 ||
    (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")
  ) {
    throw new GitHubRateLimitError(retryAfterMs(response));
  }
  return response;
}

export async function githubJson(context: GitHubReadContext, path: string): Promise<unknown> {
  const response = await githubResponse(context, path);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GitHub read returned HTTP ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("GitHub read returned invalid JSON.");
  }
}

export async function readPullRequest(
  context: GitHubReadContext,
  pullRequestNumber: number,
): Promise<PullRequestObservation> {
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1)
    throw new Error("Invalid pull request number.");
  const repositoryBase = repositoryPath(context.repository);
  const [rawPullRequest, rawRepository] = await Promise.all([
    githubJson(context, `${repositoryBase}/pulls/${pullRequestNumber}`),
    githubJson(context, repositoryBase),
  ]);
  if (!isRecord(rawPullRequest) || !isRecord(rawRepository))
    throw new Error("GitHub returned an invalid pull request.");
  const user = rawPullRequest.user;
  const head = rawPullRequest.head;
  const base = rawPullRequest.base;
  if (
    !isRecord(user) ||
    !isRecord(head) ||
    !isRecord(base) ||
    !isRecord(head.repo) ||
    !isRecord(base.repo) ||
    typeof head.repo.id !== "number" ||
    head.repo.id !== context.repository.id ||
    typeof base.repo.id !== "number" ||
    base.repo.id !== context.repository.id ||
    rawRepository.id !== context.repository.id ||
    rawRepository.full_name !== context.repository.fullName ||
    typeof rawPullRequest.state !== "string" ||
    typeof rawPullRequest.title !== "string" ||
    typeof head.ref !== "string" ||
    typeof base.ref !== "string" ||
    typeof head.repo.full_name !== "string" ||
    typeof base.repo.full_name !== "string" ||
    !validSha(head.sha) ||
    !validSha(base.sha) ||
    typeof user.login !== "string" ||
    typeof user.type !== "string" ||
    typeof rawRepository.default_branch !== "string" ||
    typeof rawPullRequest.number !== "number" ||
    rawPullRequest.number !== pullRequestNumber
  )
    throw new Error("GitHub returned incomplete pull request identity evidence.");
  return {
    repository: context.repository.fullName,
    pullRequest: pullRequestNumber,
    state: rawPullRequest.state,
    authorLogin: user.login,
    authorType: user.type,
    headRepository: head.repo.full_name,
    baseRepository: base.repo.full_name,
    headSha: head.sha.toLowerCase(),
    baseSha: base.sha.toLowerCase(),
    headRef: head.ref,
    baseRef: base.ref,
    defaultBranch: rawRepository.default_branch,
    title: rawPullRequest.title,
    draft: typeof rawPullRequest.draft === "boolean" ? rawPullRequest.draft : null,
    merged: typeof rawPullRequest.merged === "boolean" ? rawPullRequest.merged : null,
    mergeable: typeof rawPullRequest.mergeable === "boolean" ? rawPullRequest.mergeable : null,
    mergeableState:
      typeof rawPullRequest.mergeable_state === "string" ? rawPullRequest.mergeable_state : null,
    mergedAt: typeof rawPullRequest.merged_at === "string" ? rawPullRequest.merged_at : null,
    mergeCommitSha: validSha(rawPullRequest.merge_commit_sha)
      ? rawPullRequest.merge_commit_sha.toLowerCase()
      : null,
  };
}

export async function readCommit(
  context: GitHubReadContext,
  sha: string,
): Promise<CommitEvidence | null> {
  if (!validSha(sha)) return null;
  const value = await githubJson(
    context,
    `${repositoryPath(context.repository)}/commits/${sha.toLowerCase()}`,
  );
  return parseCommit(value);
}

function parseWorkflowRun(value: unknown): WorkflowRunEvidence | null {
  if (!isRecord(value) || !Array.isArray(value.pull_requests)) return null;
  if (
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    typeof value.event !== "string" ||
    typeof value.status !== "string" ||
    !(value.conclusion === null || typeof value.conclusion === "string") ||
    !validSha(value.head_sha) ||
    !(value.check_suite_id === null || typeof value.check_suite_id === "number") ||
    typeof value.created_at !== "string"
  )
    return null;
  const pullRequests: Array<{ number: number }> = [];
  for (const item of value.pull_requests) {
    if (!isRecord(item) || typeof item.number !== "number" || !Number.isSafeInteger(item.number))
      return null;
    pullRequests.push({ number: item.number });
  }
  return {
    id: value.id,
    event: value.event,
    status: value.status,
    conclusion: value.conclusion,
    headSha: value.head_sha.toLowerCase(),
    checkSuiteId: value.check_suite_id,
    createdAt: value.created_at,
    pullRequests,
  };
}

function parseCommit(value: unknown): CommitEvidence | null {
  if (!isRecord(value) || !validSha(value.sha) || !Array.isArray(value.parents)) return null;
  const parents: string[] = [];
  for (const parent of value.parents) {
    if (!isRecord(parent) || !validSha(parent.sha)) return null;
    parents.push(parent.sha.toLowerCase());
  }
  return { sha: value.sha.toLowerCase(), parents };
}

function parseCheckRun(value: unknown): CheckRunEvidence | null {
  if (!isRecord(value) || !isRecord(value.check_suite)) return null;
  const app = value.app;
  if (
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    typeof value.name !== "string" ||
    !validSha(value.head_sha) ||
    typeof value.status !== "string" ||
    !(value.conclusion === null || typeof value.conclusion === "string") ||
    typeof value.check_suite.id !== "number" ||
    !(app === null || (isRecord(app) && (app.slug === null || typeof app.slug === "string")))
  )
    return null;
  return {
    id: value.id,
    name: value.name,
    headSha: value.head_sha.toLowerCase(),
    status: value.status,
    conclusion: value.conclusion,
    checkSuiteId: value.check_suite.id,
    appSlug: isRecord(app) && typeof app.slug === "string" ? app.slug : null,
  };
}

export async function readRequiredCi(
  context: GitHubReadContext,
  pullRequest: PullRequestObservation,
) {
  const query = new URLSearchParams({
    branch: pullRequest.headRef,
    event: "pull_request",
    per_page: "100",
  });
  const allRuns: WorkflowRunEvidence[] = [];
  let totalCount = 0;
  for (let page = 1; page <= maxApiPages; page += 1) {
    query.set("page", String(page));
    const value = await githubJson(
      context,
      `${repositoryPath(context.repository)}/actions/runs?${query.toString()}`,
    );
    if (
      !isRecord(value) ||
      !Array.isArray(value.workflow_runs) ||
      typeof value.total_count !== "number"
    ) {
      throw new Error("GitHub returned an invalid workflow-run list.");
    }
    totalCount = value.total_count;
    const pageRuns = value.workflow_runs.map(parseWorkflowRun);
    if (pageRuns.some((run) => run === null))
      throw new Error("GitHub returned an invalid workflow run.");
    allRuns.push(...pageRuns.filter((run): run is WorkflowRunEvidence => run !== null));
    if (value.workflow_runs.length < 100) break;
  }

  const linkedRuns = allRuns
    .filter(
      (run) =>
        run.event === "pull_request" &&
        run.pullRequests.some(({ number }) => number === pullRequest.pullRequest),
    )
    .sort((left, right) => {
      const timeOrder = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return Number.isFinite(timeOrder) && timeOrder !== 0 ? timeOrder : right.id - left.id;
    });
  if (linkedRuns.length === 0) {
    return totalCount > maxApiPages * 100
      ? ({
          kind: "unproven",
          reason: "The pull request workflow run is outside the bounded GitHub API search window.",
        } as const)
      : ({ kind: "pending" } as const);
  }

  let matchingRun: WorkflowRunEvidence | undefined;
  let matchingCommit: CommitEvidence | undefined;
  let activeRunSeen = false;
  for (const run of linkedRuns.slice(0, maxCiMergeCandidates)) {
    if (run.status !== "completed") activeRunSeen = true;
    try {
      const commit = await readCommit(context, run.headSha);
      if (commit === null) throw new Error("GitHub returned an invalid merge commit.");
      if (
        commit.parents.length === 2 &&
        commit.parents.some((parent) => parent === pullRequest.headSha.toLowerCase()) &&
        commit.parents.some((parent) => parent === pullRequest.baseSha.toLowerCase())
      ) {
        matchingRun = run;
        matchingCommit = commit;
        break;
      }
    } catch (error) {
      if (error instanceof GitHubRateLimitError) throw error;
      if (run.status !== "completed") return { kind: "pending" } as const;
      return {
        kind: "unproven",
        reason: "A completed workflow run's merge commit could not be verified.",
      } as const;
    }
  }
  if (matchingRun === undefined || matchingCommit === undefined) {
    return activeRunSeen
      ? ({ kind: "pending" } as const)
      : ({
          kind: "unproven",
          reason: "No workflow merge commit proves the current pull request head and base.",
        } as const);
  }
  if (matchingRun.checkSuiteId === null) {
    return {
      kind: "unproven",
      reason: "The candidate workflow run has no check-suite identity.",
    } as const;
  }

  const rawChecks = await githubJson(
    context,
    `${repositoryPath(context.repository)}/commits/${matchingRun.headSha}/check-runs?per_page=100`,
  );
  if (
    !isRecord(rawChecks) ||
    !Array.isArray(rawChecks.check_runs) ||
    typeof rawChecks.total_count !== "number"
  ) {
    throw new Error("GitHub returned an invalid check-run list.");
  }
  if (rawChecks.total_count > rawChecks.check_runs.length) {
    return {
      kind: "unproven",
      reason: "The tested check suite exceeds the bounded evidence page.",
    } as const;
  }
  const checks = rawChecks.check_runs.map(parseCheckRun);
  if (checks.some((check) => check === null))
    throw new Error("GitHub returned an invalid check run.");
  const validChecks = checks.filter((check): check is CheckRunEvidence => check !== null);
  return proveRequiredCi({
    pullRequestNumber: pullRequest.pullRequest,
    headSha: pullRequest.headSha,
    baseSha: pullRequest.baseSha,
    runs: [matchingRun],
    commits: [matchingCommit],
    checkRuns: validChecks,
  });
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function readContent(
  context: GitHubReadContext,
  path: string,
  ref: string,
): Promise<string | null> {
  const response = await githubResponse(
    context,
    `${repositoryPath(context.repository)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
  );
  if (response.status === 404) return null;
  if (response.status !== 200)
    throw new Error(`GitHub content read returned HTTP ${response.status}.`);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("GitHub content read returned invalid JSON.");
  }
  if (
    !isRecord(value) ||
    value.type !== "file" ||
    value.encoding !== "base64" ||
    typeof value.content !== "string"
  ) {
    throw new Error("GitHub returned an unreadable baseline instruction file.");
  }
  try {
    const bytes = Uint8Array.from(atob(value.content.replace(/\s/g, "")), (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("GitHub returned invalid baseline instruction content.");
  }
}

async function readReviewFiles(
  context: GitHubReadContext,
  pullRequest: PullRequestObservation,
): Promise<ReviewFile[] | null> {
  const files: ReviewFile[] = [];
  for (let page = 1; page <= 2; page += 1) {
    const value = await githubJson(
      context,
      `${repositoryPath(context.repository)}/pulls/${pullRequest.pullRequest}/files?per_page=100&page=${page}`,
    );
    if (!Array.isArray(value))
      throw new Error("GitHub returned an invalid pull request file list.");
    if (files.length + value.length > 100) return null;
    for (const item of value) {
      if (
        !isRecord(item) ||
        typeof item.filename !== "string" ||
        typeof item.status !== "string" ||
        typeof item.patch !== "string"
      )
        return null;
      if (!["added", "modified", "removed", "renamed", "copied"].includes(item.status)) return null;
      if (item.patch.length === 0) return null;
      if (item.previous_filename !== undefined && typeof item.previous_filename !== "string")
        return null;
      files.push({
        path: item.filename,
        status: item.status as ReviewFile["status"],
        patch: item.patch,
        ...(item.previous_filename === undefined ? {} : { previousPath: item.previous_filename }),
      });
    }
    if (value.length < 100) break;
    if (page === 2) return null;
  }
  return files.length === 0 ? null : files;
}

async function readCommitMessages(
  context: GitHubReadContext,
  pullRequest: PullRequestObservation,
): Promise<string[] | null> {
  const value = await githubJson(
    context,
    `${repositoryPath(context.repository)}/pulls/${pullRequest.pullRequest}/commits?per_page=100&page=1`,
  );
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return null;
  const messages: string[] = [];
  for (const commit of value) {
    if (
      !isRecord(commit) ||
      !isRecord(commit.commit) ||
      typeof commit.commit.message !== "string" ||
      commit.commit.message.length > 2048
    )
      return null;
    messages.push(commit.commit.message);
  }
  return messages;
}

async function readInstructions(
  context: GitHubReadContext,
  pullRequest: PullRequestObservation,
  files: ReviewFile[],
): Promise<ContextFile[] | null> {
  const paths = new Set(["AGENTS.md", "CONTRIBUTING.md"]);
  for (const file of files) {
    const segments = file.path.split("/");
    if (
      file.path.startsWith("/") ||
      segments.some((segment) => segment === ".." || segment === ".")
    )
      return null;
    for (let depth = 1; depth < segments.length; depth += 1) {
      paths.add(`${segments.slice(0, depth).join("/")}/AGENTS.md`);
    }
    if (paths.size > maxInstructions) return null;
  }
  const candidates = [...paths];
  const results: ContextFile[] = [];
  for (let offset = 0; offset < candidates.length; offset += 6) {
    const batch = candidates.slice(offset, offset + 6);
    const contents = await Promise.all(
      batch.map(async (path) => ({
        path,
        content: await readContent(context, path, pullRequest.baseSha),
      })),
    );
    for (const { path, content } of contents) {
      if (content !== null) results.push({ path, content });
    }
  }
  if (!results.some((file) => file.path === "AGENTS.md")) return null;
  const size = new TextEncoder().encode(JSON.stringify(results)).byteLength;
  if (size > maxContextBytes) return null;
  return results;
}

export async function createReviewSnapshot(
  context: GitHubReadContext,
  pullRequest: PullRequestObservation,
  proof: Extract<ReturnType<typeof proveRequiredCi>, { kind: "passed" }>,
): Promise<ReviewSnapshot | null> {
  if (
    proof.testedHeadSha.toLowerCase() !== pullRequest.headSha.toLowerCase() ||
    proof.testedBaseSha.toLowerCase() !== pullRequest.baseSha.toLowerCase()
  )
    return null;
  const [files, commitMessages] = await Promise.all([
    readReviewFiles(context, pullRequest),
    readCommitMessages(context, pullRequest),
  ]);
  if (files === null || commitMessages === null) return null;
  const contextFiles = await readInstructions(context, pullRequest, files);
  if (contextFiles === null) return null;
  return parseReviewSnapshot({
    identity: {
      repository: context.repository.fullName,
      pullRequest: pullRequest.pullRequest,
      headSha: pullRequest.headSha,
      testedBaseSha: proof.testedBaseSha,
    },
    title: pullRequest.title,
    commitMessages,
    files,
    contextFiles,
  });
}
