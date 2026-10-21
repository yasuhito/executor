export const requiredChecks = ["web", "tui", "qiskit-backend"] as const;
const shaPattern = /^[0-9a-f]{40}$/i;

export interface WorkflowRunEvidence {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  checkSuiteId: number | null;
  createdAt: string;
  pullRequests: Array<{ number: number }>;
}

export interface CommitEvidence {
  sha: string;
  parents: string[];
}

export interface CheckRunEvidence {
  id: number;
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  checkSuiteId: number | null;
  appSlug: string | null;
}

export interface CiTargetEvidence {
  testedBaseSha: string;
  testedHeadSha: string;
  mergeSha: string;
  runId: number;
}

export type CiProof =
  | { kind: "pending"; evidence?: CiTargetEvidence }
  | { kind: "failed"; reason: string; evidence: CiTargetEvidence }
  | { kind: "unproven"; reason: string; evidence?: CiTargetEvidence }
  | ({ kind: "passed" } & CiTargetEvidence);

function hasTargetParents(commit: CommitEvidence, headSha: string, baseSha: string): boolean {
  return (
    shaPattern.test(commit.sha) &&
    commit.parents.length === 2 &&
    commit.parents.every((parent) => shaPattern.test(parent)) &&
    new Set(commit.parents.map((parent) => parent.toLowerCase())).size === 2 &&
    commit.parents.some((parent) => parent.toLowerCase() === headSha.toLowerCase()) &&
    commit.parents.some((parent) => parent.toLowerCase() === baseSha.toLowerCase()) &&
    commit.sha.toLowerCase() !== headSha.toLowerCase()
  );
}

function latestFirst(left: WorkflowRunEvidence, right: WorkflowRunEvidence): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime)
    return rightTime - leftTime;
  return right.id - left.id;
}

export function proveRequiredCi(input: {
  pullRequestNumber: number;
  headSha: string;
  baseSha: string;
  runs: WorkflowRunEvidence[];
  commits: CommitEvidence[];
  checkRuns: CheckRunEvidence[];
}): CiProof {
  const runs = input.runs
    .filter(
      (run) =>
        run.event === "pull_request" &&
        run.pullRequests.some(({ number }) => number === input.pullRequestNumber),
    )
    .sort(latestFirst);
  if (runs.length === 0) return { kind: "pending" };

  const commits = new Map(input.commits.map((commit) => [commit.sha.toLowerCase(), commit]));
  const matching = runs.filter((run) => {
    const commit = commits.get(run.headSha.toLowerCase());
    return commit !== undefined && hasTargetParents(commit, input.headSha, input.baseSha);
  });
  if (matching.length === 0) {
    return runs.some((run) => run.status !== "completed")
      ? { kind: "pending" }
      : {
          kind: "unproven",
          reason: "No pull_request workflow run proves the tested head/base merge commit.",
        };
  }

  const run = matching[0];
  const evidence: CiTargetEvidence = {
    testedBaseSha: input.baseSha.toLowerCase(),
    testedHeadSha: input.headSha.toLowerCase(),
    mergeSha: run.headSha.toLowerCase(),
    runId: run.id,
  };
  if (run.status !== "completed") return { kind: "pending", evidence };
  if (run.conclusion !== "success")
    return {
      kind: "failed",
      reason: "The newest workflow run for this tested merge commit did not succeed.",
      evidence,
    };
  if (run.checkSuiteId === null)
    return { kind: "unproven", reason: "The workflow run has no check-suite identity.", evidence };

  const checks = input.checkRuns.filter(
    (check) =>
      check.checkSuiteId === run.checkSuiteId &&
      check.headSha.toLowerCase() === run.headSha.toLowerCase() &&
      check.appSlug === "github-actions",
  );
  for (const name of requiredChecks) {
    const matches = checks
      .filter((check) => check.name === name)
      .sort((left, right) => right.id - left.id);
    if (matches.length === 0)
      return {
        kind: "unproven",
        reason: `Required check ${name} is absent from the tested check suite.`,
        evidence,
      };
    const latest = matches[0];
    if (latest.status !== "completed") return { kind: "pending", evidence };
    if (latest.conclusion !== "success")
      return { kind: "failed", reason: `Required check ${name} did not succeed.`, evidence };
  }

  return { kind: "passed", ...evidence };
}
