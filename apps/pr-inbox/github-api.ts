import type { WorkflowStepContext } from "apps";
import type { GitHubReadContext } from "./review-protocol/github-read.ts";
import { apiOrigin, requirements, type GitHubAccount } from "./providers.ts";
import { repositoryPath, type RepositoryConfig } from "./repositories.ts";

export type GitHubWorkflowContext = WorkflowStepContext<typeof requirements>;
export type GitHubMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function tokenFor(account: GitHubAccount): string {
  return account.method === "oauth" ? account.fields.access_token : account.fields.token;
}

export function githubReadContext(
  context: GitHubWorkflowContext,
  repository: RepositoryConfig,
): GitHubReadContext {
  return {
    repository,
    fetch: (input, init) => context.fetch(input, init),
    signal: context.signal,
    headers: { Authorization: `Bearer ${tokenFor(context.user.accounts.github)}` },
  };
}

export async function githubRequest(
  context: GitHubWorkflowContext,
  repository: RepositoryConfig,
  path: string,
  method: GitHubMethod,
  body?: unknown,
): Promise<Response> {
  if (!path.startsWith(`${repositoryPath(repository)}/`)) throw new Error("GitHub request path is outside the configured repository.");
  try {
    const response = await context.fetch(`${apiOrigin}${path}`, {
      method,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]),
      headers: {
        Authorization: `Bearer ${tokenFor(context.user.accounts.github)}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "executor-review-worker",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status >= 300 && response.status < 400) throw new Error("GitHub API redirected the request.");
    return response;
  } catch {
    throw new Error("GitHub API request failed.");
  }
}

export function requireGitHubStatus(response: Response, expected: number | readonly number[]): void {
  const accepted = typeof expected === "number" ? [expected] : expected;
  if (!accepted.includes(response.status)) throw new Error(`GitHub API returned HTTP ${response.status}.`);
}

export async function githubResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("GitHub API returned invalid JSON.");
  }
}
