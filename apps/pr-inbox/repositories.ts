export interface RepositoryConfig {
  fullName: string;
  id: number;
}

const fullNamePattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isRepositoryConfig(value: unknown): value is RepositoryConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const repository = value as Record<string, unknown>;
  return (
    typeof repository.fullName === "string" &&
    fullNamePattern.test(repository.fullName) &&
    typeof repository.id === "number" &&
    Number.isSafeInteger(repository.id) &&
    repository.id > 0
  );
}

export function repositoryPath(repository: Pick<RepositoryConfig, "fullName">): string {
  return `/repos/${repository.fullName}`;
}

export function pullRequestUrl(
  repository: Pick<RepositoryConfig, "fullName">,
  number: number,
): string {
  return `https://github.com/${repository.fullName}/pull/${number}`;
}

export function repositoryFromAllowlist(
  value: unknown,
  repositories: readonly RepositoryConfig[],
): RepositoryConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "number" ||
    !Number.isSafeInteger(candidate.id) ||
    typeof candidate.full_name !== "string"
  )
    return null;
  return (
    repositories.find(
      ({ id, fullName }) => id === candidate.id && fullName === candidate.full_name,
    ) ?? null
  );
}

export function hasValidRepositoryAllowlist(repositories: readonly RepositoryConfig[]): boolean {
  return (
    repositories.length > 0 &&
    repositories.every(isRepositoryConfig) &&
    new Set(repositories.map(({ fullName }) => fullName)).size === repositories.length &&
    new Set(repositories.map(({ id }) => id)).size === repositories.length
  );
}
