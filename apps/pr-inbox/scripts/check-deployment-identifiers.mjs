import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "tests",
  "examples",
  "dist",
  "coverage",
]);
// Hash-pinned applied migrations retain the original repository path; exempt only that rule.
const immutableAppliedMigrationFiles = new Set([
  join("apps", "pr-inbox", "migrations", "0001_webhook_receipts.sql"),
  join("apps", "pr-inbox", "migrations", "0002_dependabot_review_queue.sql"),
  join("apps", "pr-inbox", "migrations", "0003_url_only_review_telegram_pending.sql"),
]);
const ignoredLocalConfig = (name) =>
  /\.local\.(?:json|toml)$/i.test(name) ||
  name === ".dev.vars" ||
  name.startsWith(".dev.vars.") ||
  name === ".env" ||
  name.startsWith(".env.");
const rules = [
  [
    "prefixed deployment identifier",
    /(?:^|[^A-Za-z0-9])(?:app|whk|dpl|acc)_[A-Za-z0-9-]{6,}(?=$|[^A-Za-z0-9])/i,
  ],
  ["UUID-shaped deployment identifier", /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i],
  ["32-character hexadecimal account identifier", /\b[0-9a-f]{32}\b/i],
  [
    "numeric repository or hook identifier",
    /[A-Za-z0-9_]*(?:repository|hook)[A-Za-z0-9_]*id\s*[:=]\s*["']?\d{5,}\b/i,
  ],
  ["numeric ID field", /(?:^|[{,\s])["']?id["']?\s*[:=]\s*["']?\d{5,}\b/i],
  ["Worker deployment hostname", /\b(?:[a-z0-9-]+\.)+[a-z0-9-]+\.workers\.dev\b/i],
  ["repository-specific qni path", /\bqni[a-z0-9-]*\/[a-z0-9_.-]+\b/i],
  [
    "concrete GitHub pull-request or issue URL",
    /https?:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/(?:pull|issues?)\/[0-9]+\b/i,
  ],
];

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    if (entry.isFile() && ignoredLocalConfig(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const violations = [];
for (const path of await collectFiles(root)) {
  const relativePath = relative(root, path);
  const isImmutableAppliedMigration = immutableAppliedMigrationFiles.has(relativePath);

  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
  } catch (error) {
    if (error instanceof TypeError) continue;
    throw error;
  }
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const [label, pattern] of rules) {
      if (isImmutableAppliedMigration && label === "repository-specific qni path") continue;
      if (pattern.test(line)) violations.push(`${relativePath}:${index + 1}: ${label}`);
    }
  }
}

if (violations.length > 0) {
  console.error(`Deployment identifiers found outside tests/examples:\n${violations.join("\n")}`);
  process.exitCode = 1;
}
