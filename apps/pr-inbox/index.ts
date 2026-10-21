import {
  array,
  boolean,
  defineApp,
  number,
  object,
  query,
  router,
  string,
  userInterval,
  type QueryContext,
  type Sql,
  type SqlReader,
  type Webhook,
} from "apps";
import { apiOrigin, requirements, type GitHubAccount, type HookContext } from "./providers.ts";
import {
  hasValidRepositoryAllowlist,
  pullRequestUrl,
  repositoryFromAllowlist,
  repositoryPath,
  type RepositoryConfig,
} from "./repositories.ts";
import {
  notificationStatusQuery,
  processQueue,
  recentReviewsQuery,
  recoveryMutation,
} from "./processor.ts";

const hookState = object({ hookId: number() });
const repositoryConfigSchema = object({ fullName: string(), id: number() });
const registrationConfigSchema = object({
  repository: string(),
  hookId: number(),
  sourceSubscriptionId: string(),
  sourceAccountId: string(),
  migrationRecordId: string(),
  fromCallbackUrl: string(),
});
const replacementConfig = object({
  repositories: array(repositoryConfigSchema),
  reviewWorkerUrl: string(),
  dryRun: boolean().optional(),
  registration: registrationConfigSchema,
});
const maxBodyBytes = 1024 * 1024;
const maxReceipts = 100;
const defaultReceiptLimit = 20;
const completedLeaseUntil = Number.MAX_SAFE_INTEGER;
const apiTimeoutMs = 15_000;
const registrationLeaseMs = 60_000;
// Cleanup must never DELETE the incident hook; authorized registration updates remain possible.
const preservedHookIds = new Set([700112653]);
const supportedActions = new Set(["opened", "reopened", "synchronize"]);
const deliveryIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const signaturePattern = /^sha256=([0-9a-f]{64})$/i;
const headShaPattern = /^[0-9a-f]{40}$/i;

interface ReceiptRow extends Record<string, string | number | null | ArrayBuffer> {
  delivery_id: string;
  event: "ping" | "pull_request";
  action: string | null;
  repository: string;
  pull_request_number: number | null;
  head_sha: string | null;
  event_base_sha: string | null;
  pull_request_url: string | null;
  received_at: number;
  ping: number;
}

interface ReceiptInput {
  deliveryId: string;
  event: "ping" | "pull_request";
  action: string | null;
  pullRequestNumber: number | null;
  headSha: string | null;
  baseSha: string | null;
  pullRequestUrl: string | null;
  ping: 0 | 1;
}

interface HookSummary {
  id: number;
  name: string;
  active: boolean;
  events: string[];
  callbackUrl: string;
  contentType: string;
  insecureSsl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesRepository(value: unknown, repository: RepositoryConfig): boolean {
  return repositoryFromAllowlist(value, [repository]) !== null;
}

function isDependabotBot(value: unknown): boolean {
  return isRecord(value) && value.login === "dependabot[bot]" && value.type === "Bot";
}

function isPingPayload(payload: Record<string, unknown>): boolean {
  return (
    typeof payload.hook_id === "number" &&
    Number.isSafeInteger(payload.hook_id) &&
    payload.hook_id > 0 &&
    isRecord(payload.hook) &&
    typeof payload.hook.id === "number" &&
    Number.isSafeInteger(payload.hook.id) &&
    payload.hook.id === payload.hook_id
  );
}

function response(status: number): Response {
  return new Response(null, { status });
}

async function readBoundedBody(
  request: Request,
): Promise<{ kind: "ok"; bytes: Uint8Array } | { kind: "too-large" } | { kind: "invalid" }> {
  if (request.body === null) return { kind: "ok", bytes: new Uint8Array() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBodyBytes) {
        try {
          await reader.cancel();
        } catch {
          // The body is already being rejected.
        }
        return { kind: "too-large" };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { kind: "invalid" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", bytes };
}

function signatureBytes(signature: string): Uint8Array | null {
  const match = signaturePattern.exec(signature);
  if (match === null) return null;
  const hex = match[1];
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function hasValidSignature(
  secret: string,
  signature: string,
  body: Uint8Array,
): Promise<boolean> {
  const bytes = signatureBytes(signature);
  if (bytes === null || secret.length === 0) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("HMAC", key, arrayBuffer(bytes), arrayBuffer(body));
  } catch {
    return false;
  }
}

function insertReceipt(sql: Sql, repository: string, receipt: ReceiptInput): boolean {
  const receivedAt = Date.now();
  return sql.transaction((transaction) => {
    const inserted =
      transaction.exec(
        `INSERT OR IGNORE INTO webhook_receipts
        (delivery_id, event, action, repository, pull_request_number, head_sha, event_base_sha, pull_request_url, received_at, ping)
       VALUES (?, ?, ?, ?, CAST(? AS INTEGER), ?, ?, ?, CAST(? AS INTEGER), ?)`,
        receipt.deliveryId,
        receipt.event,
        receipt.action,
        repository,
        receipt.pullRequestNumber,
        receipt.headSha,
        receipt.baseSha,
        receipt.pullRequestUrl,
        receivedAt,
        receipt.ping,
      ).rowsWritten > 0;
    if (inserted && receipt.event === "pull_request") {
      transaction.exec(
        `INSERT OR IGNORE INTO review_queue
          (delivery_id, repository, pull_request_number, event_head_sha, event_base_sha, state, received_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
        receipt.deliveryId,
        repository,
        receipt.pullRequestNumber,
        receipt.headSha,
        receipt.baseSha,
        receivedAt,
        receivedAt,
      );
    }
    return inserted;
  });
}

function malformed(): Response {
  return response(400);
}

function ignored(): Response {
  return response(202);
}

function storePing(sql: Sql, repository: string, deliveryId: string): Response {
  insertReceipt(sql, repository, {
    deliveryId,
    event: "ping",
    action: null,
    pullRequestNumber: null,
    headSha: null,
    baseSha: null,
    pullRequestUrl: null,
    ping: 1,
  });
  return ignored();
}

async function storePullRequest(
  sql: Sql,
  repository: RepositoryConfig,
  deliveryId: string,
  action: string,
  pullRequest: Record<string, unknown>,
  startProcessing: (repository: string, deliveryId: string) => Promise<unknown>,
): Promise<Response> {
  const number = pullRequest.number;
  const user = pullRequest.user;
  const head = pullRequest.head;
  const base = pullRequest.base;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !isRecord(user) ||
    typeof user.login !== "string" ||
    typeof user.type !== "string" ||
    !isRecord(head) ||
    !isRecord(base) ||
    typeof head.sha !== "string" ||
    !headShaPattern.test(head.sha) ||
    typeof base.sha !== "string" ||
    !headShaPattern.test(base.sha) ||
    !isRecord(head.repo) ||
    !isRecord(base.repo)
  ) {
    return malformed();
  }
  if (
    !isDependabotBot(user) ||
    !matchesRepository(head.repo, repository) ||
    !matchesRepository(base.repo, repository)
  )
    return ignored();

  insertReceipt(sql, repository.fullName, {
    deliveryId,
    event: "pull_request",
    action,
    pullRequestNumber: number,
    headSha: head.sha.toLowerCase(),
    baseSha: base.sha.toLowerCase(),
    pullRequestUrl: pullRequestUrl(repository, number),
    ping: 0,
  });
  try {
    await startProcessing(repository.fullName, deliveryId);
  } catch {
    return response(503);
  }
  return ignored();
}

async function handleIncoming(
  sql: Sql,
  request: Request,
  secret: string,
  config: ReplacementConfig,
  startProcessing: (repository: string, deliveryId: string) => Promise<unknown>,
): Promise<Response> {
  if (request.method !== "POST") return response(405);
  const signature = request.headers.get("x-hub-signature-256");
  if (signature === null || signatureBytes(signature) === null) return response(401);

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return malformed();
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength)) return malformed();
    if (declaredLength > maxBodyBytes) return response(413);
  }

  const body = await readBoundedBody(request);
  if (body.kind === "too-large") return response(413);
  if (body.kind === "invalid") return malformed();
  if (!(await hasValidSignature(secret, signature, body.bytes))) return response(401);

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes));
  } catch {
    return malformed();
  }
  if (!isRecord(payload)) return malformed();

  const event = request.headers.get("x-github-event");
  if (event === null) return malformed();
  if (event !== "ping" && event !== "pull_request") return ignored();

  const deliveryHeader = request.headers.get("x-github-delivery");
  if (deliveryHeader === null || !deliveryIdPattern.test(deliveryHeader)) return malformed();
  const deliveryId = deliveryHeader.toLowerCase();

  const repository = repositoryFromAllowlist(payload.repository, config.repositories);
  if (repository === null) return ignored();
  if (event === "ping") {
    return isPingPayload(payload) ? storePing(sql, repository.fullName, deliveryId) : ignored();
  }

  if (typeof payload.action !== "string") return malformed();
  if (!supportedActions.has(payload.action)) return ignored();
  if (!isRecord(payload.pull_request)) return malformed();
  return storePullRequest(
    sql,
    repository,
    deliveryId,
    payload.action,
    payload.pull_request,
    startProcessing,
  );
}

interface RegistrationConfig {
  repository: string;
  hookId: number;
  sourceSubscriptionId: string;
  sourceAccountId: string;
  migrationRecordId: string;
  fromCallbackUrl: string;
}

interface ReplacementConfig {
  repositories: readonly RepositoryConfig[];
  reviewWorkerUrl: string;
  dryRun?: boolean;
  registration: RegistrationConfig;
}

interface HookMigrationRow extends Record<string, string | number | null | ArrayBuffer> {
  hook_id: number | null;
  lease_token: string | null;
  lease_until: number | null;
}

interface HookMigrationDiagnosticRow extends Record<string, string | number | null | ArrayBuffer> {
  lease_token: string | null;
}

interface HookMigrationState {
  version: 1;
  phase: "preflight" | "patching" | "complete";
  subscriptionId: string;
  originalCallbackHash: string;
  replacementCallbackHash: string;
  secretFingerprint: string;
  token: string;
}

interface HookMigrationIdentity {
  subscriptionId: string;
  originalCallbackHash: string;
  replacementCallbackHash: string;
  secretFingerprint: string;
}

function safeSubscriptionId(subscriptionId: string): boolean {
  if (subscriptionId.length === 0 || subscriptionId.length > 128) return false;
  for (let index = 0; index < subscriptionId.length; index += 1) {
    const code = subscriptionId.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function canonicalCallbackUrl(callbackUrl: string): boolean {
  try {
    const url = new URL(callbackUrl);
    const segments = url.pathname.split("/").slice(1);
    return (
      callbackUrl.length <= 2048 &&
      url.href === callbackUrl &&
      url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      segments.length > 0 &&
      segments.every((segment) => segment.length > 0 && !/%2f|%5c/i.test(segment))
    );
  } catch {
    return false;
  }
}

function canonicalWorkerOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value.length <= 2048 &&
      url.origin === value &&
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function approvedReplacementInput(
  account: GitHubAccount,
  config: ReplacementConfig,
  subscriptionId: string,
  callbackUrl: string,
  secret: string,
): boolean {
  const registration = config.registration;
  const registeredRepository = config.repositories.find(
    ({ fullName }) => fullName === registration.repository,
  );
  return (
    hasValidRepositoryAllowlist(config.repositories) &&
    registeredRepository !== undefined &&
    safeSubscriptionId(subscriptionId) &&
    safeSubscriptionId(registration.sourceSubscriptionId) &&
    subscriptionId !== registration.sourceSubscriptionId &&
    account.id === registration.sourceAccountId &&
    Number.isSafeInteger(registration.hookId) &&
    registration.hookId > 0 &&
    registration.migrationRecordId.length > 0 &&
    registration.migrationRecordId.length <= 128 &&
    canonicalWorkerOrigin(config.reviewWorkerUrl) &&
    canonicalCallbackUrl(registration.fromCallbackUrl) &&
    canonicalCallbackUrl(callbackUrl) &&
    new URL(registration.fromCallbackUrl).origin === new URL(callbackUrl).origin &&
    registration.fromCallbackUrl !== callbackUrl &&
    secret.length > 0
  );
}

/** Persist only a one-way binding for retry identity, never callback or secret values. */
async function sha256Fingerprint(domain: "callback" | "secret", value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`executor-hook-migration-v1:${domain}\0${value}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeMigrationState(value: string | null): HookMigrationState | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      (parsed.phase !== "preflight" &&
        parsed.phase !== "patching" &&
        parsed.phase !== "complete") ||
      typeof parsed.subscriptionId !== "string" ||
      typeof parsed.originalCallbackHash !== "string" ||
      typeof parsed.replacementCallbackHash !== "string" ||
      typeof parsed.secretFingerprint !== "string" ||
      typeof parsed.token !== "string"
    ) {
      return null;
    }
    return parsed as unknown as HookMigrationState;
  } catch {
    return null;
  }
}

type HookMigrationFailureClass =
  | "before_reservation"
  | "pre_patch"
  | "patch_outcome_unresolved"
  | "recorded_complete"
  | "invalid_reservation"
  | "diagnostic_unavailable";

interface HookMigrationDiagnostic {
  reservation: "absent" | "present" | "unavailable";
  phase: HookMigrationState["phase"] | null;
  subscriptionId: string | null;
  failureClass: HookMigrationFailureClass;
}

function matchesMigrationIdentity(
  state: HookMigrationState,
  identity: HookMigrationIdentity,
): boolean {
  return (
    state.subscriptionId === identity.subscriptionId &&
    state.originalCallbackHash === identity.originalCallbackHash &&
    state.replacementCallbackHash === identity.replacementCallbackHash &&
    state.secretFingerprint === identity.secretFingerprint
  );
}

function encodedMigrationState(state: HookMigrationState): string {
  return JSON.stringify(state);
}

export function readHookMigrationDiagnostic(
  sql: SqlReader,
  recordId: string,
): HookMigrationDiagnostic {
  try {
    const row = sql
      .exec<HookMigrationDiagnosticRow>(
        "SELECT lease_token FROM github_hook_registrations WHERE subscription_id = ?",
        recordId,
      )
      .toArray()[0];
    if (row === undefined) {
      // An absent reservation cannot distinguish rejected input from an unrecorded SQL claim.
      return {
        reservation: "absent",
        phase: null,
        subscriptionId: null,
        failureClass: "before_reservation",
      };
    }

    const state =
      typeof row.lease_token === "string" ? decodeMigrationState(row.lease_token) : null;
    if (state === null || !safeSubscriptionId(state.subscriptionId)) {
      return {
        reservation: "present",
        phase: null,
        subscriptionId: null,
        failureClass: "invalid_reservation",
      };
    }

    const failureClass: HookMigrationFailureClass =
      state.phase === "preflight"
        ? "pre_patch"
        : state.phase === "patching"
          ? "patch_outcome_unresolved"
          : "recorded_complete";
    return {
      reservation: "present",
      phase: state.phase,
      subscriptionId: state.subscriptionId,
      failureClass,
    };
  } catch {
    return {
      reservation: "unavailable",
      phase: null,
      subscriptionId: null,
      failureClass: "diagnostic_unavailable",
    };
  }
}

function claimHookMigration(
  sql: Sql,
  identity: HookMigrationIdentity,
  recordId: string,
  hookId: number,
):
  | { kind: "acquired"; state: HookMigrationState }
  | { kind: "complete"; state: HookMigrationState }
  | { kind: "blocked" } {
  const now = Date.now();
  const state: HookMigrationState = {
    version: 1,
    phase: "preflight",
    ...identity,
    token: crypto.randomUUID(),
  };
  const encoded = encodedMigrationState(state);

  return sql.transaction((transaction) => {
    const rows = transaction
      .exec<HookMigrationRow>(
        `SELECT hook_id, lease_token, lease_until
         FROM github_hook_registrations WHERE subscription_id = ?`,
        recordId,
      )
      .toArray();
    if (rows.length === 0) {
      const inserted = transaction.exec(
        `INSERT INTO github_hook_registrations
          (subscription_id, hook_id, lease_token, lease_until)
         VALUES (?, CAST(? AS INTEGER), ?, CAST(? AS INTEGER))`,
        recordId,
        hookId,
        encoded,
        now + registrationLeaseMs,
      ).rowsWritten;
      return inserted === 1 ? { kind: "acquired", state } : { kind: "blocked" };
    }

    const row = rows[0];
    const current = decodeMigrationState(row.lease_token);
    if (
      row.hook_id !== hookId ||
      row.lease_until === null ||
      current === null ||
      !matchesMigrationIdentity(current, identity)
    ) {
      return { kind: "blocked" };
    }
    if (current.phase === "complete") return { kind: "complete", state: current };
    if (current.phase === "patching" || row.lease_until > now) {
      return { kind: "blocked" };
    }

    const updated = transaction.exec(
      `UPDATE github_hook_registrations
       SET lease_token = ?, lease_until = CAST(? AS INTEGER)
       WHERE subscription_id = ? AND lease_token = ?
         AND lease_until <= CAST(? AS INTEGER)`,
      encoded,
      now + registrationLeaseMs,
      recordId,
      row.lease_token,
      now,
    ).rowsWritten;
    return updated === 1 ? { kind: "acquired", state } : { kind: "blocked" };
  });
}

function startHookMigrationMutation(
  sql: Sql,
  state: HookMigrationState,
  recordId: string,
): HookMigrationState | null {
  const patching = { ...state, phase: "patching" as const };
  return sql.exec(
    `UPDATE github_hook_registrations
     SET lease_token = ?, lease_until = CAST(? AS INTEGER)
     WHERE subscription_id = ? AND lease_token = ?`,
    encodedMigrationState(patching),
    completedLeaseUntil,
    recordId,
    encodedMigrationState(state),
  ).rowsWritten === 1
    ? patching
    : null;
}

function completeHookMigration(sql: Sql, state: HookMigrationState, recordId: string): boolean {
  const complete = { ...state, phase: "complete" as const };
  return (
    sql.exec(
      `UPDATE github_hook_registrations
       SET lease_token = ?, lease_until = CAST(? AS INTEGER)
       WHERE subscription_id = ? AND lease_token = ?`,
      encodedMigrationState(complete),
      completedLeaseUntil,
      recordId,
      encodedMigrationState(state),
    ).rowsWritten === 1
  );
}

function releaseHookMigrationPreflight(
  sql: Sql,
  state: HookMigrationState,
  recordId: string,
): void {
  sql.exec(
    `UPDATE github_hook_registrations SET lease_until = 0
     WHERE subscription_id = ? AND lease_token = ?`,
    recordId,
    encodedMigrationState(state),
  );
}

function apiSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(apiTimeoutMs)]);
}

async function githubRequest(
  context: HookContext,
  account: GitHubAccount,
  path: string,
  method: "GET" | "PATCH" | "POST" | "DELETE",
  signal: AbortSignal,
  body?: unknown,
): Promise<Response> {
  const token = account.method === "oauth" ? account.fields.access_token : account.fields.token;
  try {
    return await context.fetch(`${apiOrigin}${path}`, {
      method,
      redirect: "manual",
      cache: "no-store",
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "executor-pr-inbox",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("GitHub API request failed.");
  }
}

function requireStatus(response: Response, expected: number | readonly number[]): void {
  if (response.status >= 300 && response.status < 400)
    throw new Error("GitHub API redirected the request.");
  const accepted = typeof expected === "number" ? [expected] : expected;
  if (!accepted.includes(response.status))
    throw new Error(`GitHub API returned HTTP ${response.status}.`);
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("GitHub API returned invalid JSON.");
  }
}

function parseHook(value: unknown): HookSummary {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    typeof value.name !== "string" ||
    typeof value.active !== "boolean" ||
    !Array.isArray(value.events) ||
    !value.events.every((event) => typeof event === "string") ||
    !isRecord(value.config) ||
    typeof value.config.url !== "string" ||
    typeof value.config.content_type !== "string" ||
    (typeof value.config.insecure_ssl !== "string" && typeof value.config.insecure_ssl !== "number")
  ) {
    throw new Error("GitHub API returned an invalid webhook record.");
  }
  return {
    id: value.id,
    name: value.name,
    active: value.active,
    events: value.events,
    callbackUrl: value.config.url,
    contentType: value.config.content_type,
    insecureSsl: String(value.config.insecure_ssl),
  };
}

function isConfiguredHook(hook: HookSummary, callbackUrl: string): boolean {
  return (
    hook.name === "web" &&
    hook.active &&
    hook.events.length === 1 &&
    hook.events[0] === "pull_request" &&
    hook.callbackUrl === callbackUrl &&
    hook.contentType === "json" &&
    hook.insecureSsl === "0"
  );
}

async function verifySavedHook(
  response: Response,
  expectedId: number,
  callbackUrl: string,
): Promise<number> {
  const hook = parseHook(await responseJson(response));
  if (hook.id !== expectedId || !isConfiguredHook(hook, callbackUrl)) {
    throw new Error("GitHub did not save the expected webhook configuration.");
  }
  return hook.id;
}

/** A 404 triggers a fresh exhaustive list; it is not sufficient by itself to create a hook. */
async function readApprovedHook(
  context: HookContext,
  account: GitHubAccount,
  repository: string,
  hookId: number,
  callbackUrl: string,
  signal: AbortSignal,
): Promise<number | null> {
  const response = await githubRequest(
    context,
    account,
    `${repositoryPath({ fullName: repository })}/hooks/${hookId}`,
    "GET",
    signal,
  );
  if (response.status === 404) return null;
  requireStatus(response, 200);
  return verifySavedHook(response, hookId, callbackUrl);
}

function saveConfiguredRepositories(
  sql: Sql,
  subscriptionId: string,
  config: ReplacementConfig,
): void {
  sql.transaction((transaction) => {
    transaction.exec(
      "DELETE FROM configured_repositories WHERE subscription_id IN (?, ?)",
      subscriptionId,
      config.registration.sourceSubscriptionId,
    );
    for (const repository of config.repositories) {
      transaction.exec(
        `INSERT INTO configured_repositories
          (subscription_id, full_name, repository_id, review_worker_url, dry_run)
         VALUES (?, ?, CAST(? AS INTEGER), ?, ?)`,
        subscriptionId,
        repository.fullName,
        repository.id,
        config.reviewWorkerUrl,
        config.dryRun === false ? 0 : 1,
      );
    }
  });
}

/** Preflight only: no API calls, writes, hashes, URLs, or input values in the result. */
export function diagnoseRegistrationConfiguration(value: unknown): {
  code: string;
  field: string | null;
} {
  if (!isRecord(value)) return { code: "invalid_configuration", field: "config" };
  if (
    !Array.isArray(value.repositories) ||
    !hasValidRepositoryAllowlist(value.repositories as RepositoryConfig[])
  )
    return { code: "invalid_configuration", field: "repositories" };
  if (typeof value.reviewWorkerUrl !== "string" || !canonicalWorkerOrigin(value.reviewWorkerUrl))
    return { code: "invalid_configuration", field: "reviewWorkerUrl" };
  if (value.dryRun !== undefined && typeof value.dryRun !== "boolean")
    return { code: "invalid_configuration", field: "dryRun" };
  if (!isRecord(value.registration))
    return { code: "invalid_configuration", field: "registration" };
  const r = value.registration;
  for (const field of [
    "repository",
    "sourceSubscriptionId",
    "sourceAccountId",
    "migrationRecordId",
    "fromCallbackUrl",
  ] as const) {
    if (
      typeof r[field] !== "string" ||
      (!safeSubscriptionId(r[field]) && field !== "fromCallbackUrl")
    )
      return { code: "invalid_configuration", field: `registration.${field}` };
  }
  if (typeof r.hookId !== "number" || !Number.isSafeInteger(r.hookId) || r.hookId < 1)
    return { code: "invalid_configuration", field: "registration.hookId" };
  if (!canonicalCallbackUrl(r.fromCallbackUrl as string))
    return { code: "invalid_configuration", field: "registration.fromCallbackUrl" };
  if (!(value.repositories as RepositoryConfig[]).some((repo) => repo.fullName === r.repository))
    return { code: "invalid_configuration", field: "registration.repository" };
  return { code: "configuration_valid", field: null };
}

type RegistrationDetailCode =
  | "invalid_input"
  | "identity_hash_failed"
  | "claim_failed"
  | "registration_blocked"
  | "preflight_failed"
  | "mutation_unresolved"
  | "complete";
type RegistrationDetailField = "input" | "identity" | "storage" | "hook";
const detailCodes = new Set<string>([
  "invalid_input",
  "identity_hash_failed",
  "claim_failed",
  "registration_blocked",
  "preflight_failed",
  "mutation_unresolved",
  "complete",
]);
const detailFields = new Set(["input", "identity", "storage", "hook"]);

function recordDetail(
  sql: Sql,
  recordId: string,
  code: RegistrationDetailCode,
  field: RegistrationDetailField,
): void {
  try {
    sql.exec(
      `INSERT INTO github_hook_details (record_id, code, field) VALUES (?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET code = excluded.code, field = excluded.field`,
      recordId,
      code,
      field,
    );
  } catch {
    // Storage failure must not cause raw input or provider errors to escape.
  }
}

export function readRegistrationDetail(
  sql: SqlReader,
  recordId: string,
): { code: string; field: string | null } {
  try {
    const row = sql
      .exec("SELECT code, field FROM github_hook_details WHERE record_id = ?", recordId)
      .toArray()[0];
    if (row === undefined) return { code: "not_recorded", field: null };
    if (
      typeof row.code !== "string" ||
      !detailCodes.has(row.code) ||
      typeof row.field !== "string" ||
      !detailFields.has(row.field)
    ) {
      return { code: "diagnostic_unavailable", field: null };
    }
    return { code: row.code, field: row.field };
  } catch {
    return { code: "diagnostic_unavailable", field: null };
  }
}

function hookResource(repositoryId: number): string {
  // Numeric identity avoids casing aliases and serializes across linked accounts.
  return `github-repository:${repositoryId}`;
}

function lockHook(sql: Sql, resource: string, token: string): boolean {
  return (
    sql.exec(
      "INSERT OR IGNORE INTO github_hook_locks (resource, token) VALUES (?, ?)",
      resource,
      token,
    ).rowsWritten === 1
  );
}

function unlockHook(sql: Sql, resource: string, token: string): void {
  sql.exec("DELETE FROM github_hook_locks WHERE resource = ? AND token = ?", resource, token);
}

function saveOwner(
  sql: Sql,
  resource: string,
  hookId: number,
  identity: HookMigrationIdentity,
  created: boolean,
): void {
  sql.exec(
    `INSERT INTO github_hook_owners
    (resource, hook_id, subscription_id, callback_hash, secret_fingerprint, created_here)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource, subscription_id) DO NOTHING`,
    resource,
    hookId,
    identity.subscriptionId,
    identity.replacementCallbackHash,
    identity.secretFingerprint,
    created ? 1 : 0,
  );
}

function replaceRecreatedOwner(
  sql: Sql,
  resource: string,
  previousHookId: number | null,
  hookId: number,
  identity: HookMigrationIdentity,
): boolean {
  return sql.transaction((transaction) => {
    if (previousHookId === null) {
      return (
        transaction.exec(
          `INSERT INTO github_hook_owners
            (resource, hook_id, subscription_id, callback_hash, secret_fingerprint, created_here)
           VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT(resource, subscription_id) DO NOTHING`,
          resource,
          hookId,
          identity.subscriptionId,
          identity.replacementCallbackHash,
          identity.secretFingerprint,
        ).rowsWritten === 1
      );
    }
    return (
      transaction.exec(
        `UPDATE github_hook_owners
         SET hook_id = ?, created_here = 1
         WHERE resource = ? AND subscription_id = ? AND hook_id = ?
           AND callback_hash = ? AND secret_fingerprint = ? AND released = 0`,
        hookId,
        resource,
        identity.subscriptionId,
        previousHookId,
        identity.replacementCallbackHash,
        identity.secretFingerprint,
      ).rowsWritten === 1
    );
  });
}

/** Fully paginate; never infer absence from a truncated listing. */
async function discoverHooks(
  context: HookContext,
  account: GitHubAccount,
  repository: string,
  signal: AbortSignal,
): Promise<HookSummary[]> {
  const hooks: HookSummary[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await githubRequest(
      context,
      account,
      `${repositoryPath({ fullName: repository })}/hooks?per_page=100&page=${page}`,
      "GET",
      signal,
    );
    requireStatus(result, 200);
    const values = await responseJson(result);
    if (!Array.isArray(values)) throw new Error("invalid_hook_list");
    hooks.push(...values.map(parseHook));
    if (values.length < 100) return hooks;
  }
  throw new Error("incomplete_hook_list");
}

const githubWebhook = {
  account: { user: "github" },
  config: replacementConfig,
  state: hookState,
  async register(context, { account, callbackUrl, config, secret, subscriptionId }) {
    const registration = config?.registration;
    if (!registration || typeof registration.migrationRecordId !== "string") {
      throw new Error("invalid_configuration:registration");
    }
    let approved = false;
    try {
      approved = approvedReplacementInput(account, config, subscriptionId, callbackUrl, secret);
    } catch {
      /* sanitized below */
    }
    const repository = config.repositories.find(
      ({ fullName }) => fullName === registration.repository,
    );
    if (!approved || !repository) {
      recordDetail(context.sql, registration.migrationRecordId, "invalid_input", "input");
      throw new Error("Executor supplied invalid webhook replacement details.");
    }

    let identity: HookMigrationIdentity;
    try {
      identity = {
        subscriptionId,
        originalCallbackHash: await sha256Fingerprint(
          "callback",
          JSON.stringify([
            registration.fromCallbackUrl,
            account.id,
            registration.repository,
            repository.id,
          ]),
        ),
        replacementCallbackHash: await sha256Fingerprint("callback", callbackUrl),
        secretFingerprint: await sha256Fingerprint("secret", secret),
      };
    } catch {
      recordDetail(context.sql, registration.migrationRecordId, "identity_hash_failed", "identity");
      throw new Error("identity_hash_failed:identity");
    }
    const resource = hookResource(repository.id);
    const lockToken = crypto.randomUUID();
    let claim:
      | { kind: "acquired"; state: HookMigrationState }
      | { kind: "complete"; state: HookMigrationState }
      | { kind: "blocked" };
    try {
      claim = claimHookMigration(
        context.sql,
        identity,
        registration.migrationRecordId,
        registration.hookId,
      );
    } catch {
      recordDetail(context.sql, registration.migrationRecordId, "claim_failed", "storage");
      throw new Error("GitHub webhook replacement failed; stop for operator recovery.");
    }
    if (claim.kind === "blocked") {
      recordDetail(context.sql, registration.migrationRecordId, "registration_blocked", "storage");
      throw new Error("The approved webhook replacement is already claimed or unresolved.");
    }

    const signal = apiSignal(context.signal);
    if (claim.kind === "complete") {
      let locked = false;
      let mutationStarted = false;
      try {
        locked = lockHook(context.sql, resource, lockToken);
        if (!locked) throw new Error("hook_busy");
        const repo = repository;
        const repoResponse = await githubRequest(
          context,
          account,
          repositoryPath(repo),
          "GET",
          signal,
        );
        requireStatus(repoResponse, 200);
        const repoValue = await responseJson(repoResponse);
        if (
          !isRecord(repoValue) ||
          repoValue.id !== repo.id ||
          repoValue.full_name !== repo.fullName
        )
          throw new Error("repository_mismatch");

        let hooks = await discoverHooks(context, account, registration.repository, signal);
        let matches = hooks.filter(
          (hook) =>
            hook.callbackUrl === callbackUrl || hook.callbackUrl === registration.fromCallbackUrl,
        );
        const owner = context.sql
          .exec(
            `SELECT hook_id, callback_hash, secret_fingerprint, released
             FROM github_hook_owners WHERE resource = ? AND subscription_id = ?`,
            resource,
            subscriptionId,
          )
          .toArray()[0];
        if (
          matches.length > 1 ||
          owner?.released === 1 ||
          (owner !== undefined &&
            (owner.callback_hash !== identity.replacementCallbackHash ||
              owner.secret_fingerprint !== identity.secretFingerprint ||
              !Number.isSafeInteger(Number(owner.hook_id)) ||
              Number(owner.hook_id) < 1))
        ) {
          throw new Error("registration_owner_mismatch");
        }
        if (matches.length === 1) {
          if (
            matches[0].callbackUrl !== callbackUrl ||
            (owner !== undefined && Number(owner.hook_id) !== matches[0].id)
          ) {
            throw new Error("ambiguous_hook");
          }
          const existingHookId = await readApprovedHook(
            context,
            account,
            registration.repository,
            matches[0].id,
            callbackUrl,
            signal,
          );
          if (existingHookId !== null) {
            if (owner === undefined)
              saveOwner(context.sql, resource, existingHookId, identity, false);
            saveConfiguredRepositories(context.sql, subscriptionId, config);
            recordDetail(context.sql, registration.migrationRecordId, "complete", "hook");
            unlockHook(context.sql, resource, lockToken);
            return { hookId: existingHookId };
          }
          hooks = await discoverHooks(context, account, registration.repository, signal);
          matches = hooks.filter(
            (hook) =>
              hook.callbackUrl === callbackUrl || hook.callbackUrl === registration.fromCallbackUrl,
          );
          if (matches.length !== 0) throw new Error("hook_reappeared_during_recovery");
        }

        const previousHookId = owner === undefined ? null : Number(owner.hook_id);
        const recordedHookIds = new Set([
          registration.hookId,
          ...(previousHookId === null ? [] : [previousHookId]),
        ]);
        if (hooks.some((hook) => recordedHookIds.has(hook.id)))
          throw new Error("recorded_hook_mismatch");
        const otherOwner = context.sql
          .exec(
            `SELECT subscription_id FROM github_hook_owners
             WHERE resource = ? AND released = 0 AND subscription_id <> ?
               AND (hook_id = ? OR hook_id = ?)`,
            resource,
            subscriptionId,
            registration.hookId,
            previousHookId ?? registration.hookId,
          )
          .toArray()[0];
        if (otherOwner !== undefined) throw new Error("hook_has_other_owner");

        const patching = startHookMigrationMutation(
          context.sql,
          claim.state,
          registration.migrationRecordId,
        );
        if (patching === null) throw new Error("The approved webhook replacement lease was lost.");
        mutationStarted = true;
        const created = await githubRequest(
          context,
          account,
          `${repositoryPath(repo)}/hooks`,
          "POST",
          signal,
          {
            name: "web",
            active: true,
            events: ["pull_request"],
            config: { url: callbackUrl, secret, content_type: "json", insecure_ssl: "0" },
          },
        );
        requireStatus(created, 201);
        const saved = parseHook(await responseJson(created));
        if (!isConfiguredHook(saved, callbackUrl)) throw new Error("creation_unresolved");
        const savedResponse = await githubRequest(
          context,
          account,
          `${repositoryPath(repo)}/hooks/${saved.id}`,
          "GET",
          signal,
        );
        requireStatus(savedResponse, 200);
        const hookId = await verifySavedHook(savedResponse, saved.id, callbackUrl);
        if (!replaceRecreatedOwner(context.sql, resource, previousHookId, hookId, identity))
          throw new Error("The replacement hook owner could not be recorded.");
        if (!completeHookMigration(context.sql, patching, registration.migrationRecordId))
          throw new Error("The approved webhook replacement could not be recorded.");
        saveConfiguredRepositories(context.sql, subscriptionId, config);
        recordDetail(context.sql, registration.migrationRecordId, "complete", "hook");
        unlockHook(context.sql, resource, lockToken);
        return { hookId };
      } catch {
        recordDetail(
          context.sql,
          registration.migrationRecordId,
          mutationStarted ? "mutation_unresolved" : "preflight_failed",
          "hook",
        );
        if (!mutationStarted && locked) {
          try {
            unlockHook(context.sql, resource, lockToken);
          } catch {
            // Preserve the sanitized registration error if storage is unavailable.
          }
        }
        throw new Error("The approved webhook replacement is already claimed or unresolved.");
      }
    }

    let state = claim.state;
    let mutationStarted = false;
    let path = `${repositoryPath({ fullName: registration.repository })}/hooks/${registration.hookId}`;
    let locked = false;
    try {
      locked = lockHook(context.sql, resource, lockToken);
      if (!locked) throw new Error("hook_busy");
      const repo = repository;
      const repoResponse = await githubRequest(
        context,
        account,
        repositoryPath(repo),
        "GET",
        signal,
      );
      requireStatus(repoResponse, 200);
      const repoValue = await responseJson(repoResponse);
      if (!isRecord(repoValue) || repoValue.id !== repo.id || repoValue.full_name !== repo.fullName)
        throw new Error("repository_mismatch");
      const hooks = await discoverHooks(context, account, registration.repository, signal);
      const matches = hooks.filter(
        (hook) =>
          hook.callbackUrl === callbackUrl || hook.callbackUrl === registration.fromCallbackUrl,
      );
      if (matches.length > 1 || (matches.length === 1 && matches[0].id !== registration.hookId))
        throw new Error("ambiguous_hook");
      const creating = matches.length === 0;
      // An existing approved ID with a different URL is a mismatch, not permission to create.
      if (creating && hooks.some((hook) => hook.id === registration.hookId))
        throw new Error("hook_mismatch");
      // Never rotate a shared hook to a different callback/secret.
      const owners = context.sql
        .exec(
          "SELECT subscription_id, callback_hash, secret_fingerprint, created_here FROM github_hook_owners WHERE resource = ? AND hook_id = ? AND released = 0",
          resource,
          registration.hookId,
        )
        .toArray();
      if (
        owners.some(
          (owner) =>
            owner.subscription_id !== subscriptionId &&
            (owner.callback_hash !== identity.replacementCallbackHash ||
              owner.secret_fingerprint !== identity.secretFingerprint),
        )
      )
        throw new Error("shared_hook_mismatch");
      let existing: HookSummary | null = null;
      if (!creating) {
        const existingResponse = await githubRequest(context, account, path, "GET", signal);
        requireStatus(existingResponse, 200);
        existing = parseHook(await responseJson(existingResponse));
        if (
          existing.id !== registration.hookId ||
          existing.callbackUrl !== matches[0].callbackUrl ||
          (!isConfiguredHook(existing, registration.fromCallbackUrl) &&
            !isConfiguredHook(existing, callbackUrl))
        ) {
          throw new Error("The approved GitHub webhook identity or settings differ.");
        }
      }
      const patching = startHookMigrationMutation(
        context.sql,
        state,
        registration.migrationRecordId,
      );
      if (patching === null) {
        throw new Error("The approved webhook replacement lease was lost.");
      }
      state = patching;
      mutationStarted = true;

      let expectedId = registration.hookId;
      if (creating) {
        const created = await githubRequest(
          context,
          account,
          `${repositoryPath(repo)}/hooks`,
          "POST",
          signal,
          {
            name: "web",
            active: true,
            events: ["pull_request"],
            config: { url: callbackUrl, secret, content_type: "json", insecure_ssl: "0" },
          },
        );
        requireStatus(created, 201);
        const saved = parseHook(await responseJson(created));
        if (!isConfiguredHook(saved, callbackUrl)) throw new Error("creation_unresolved");
        expectedId = saved.id;
        path = `${repositoryPath(repo)}/hooks/${expectedId}`;
      } else {
        const update = await githubRequest(context, account, `${path}/config`, "PATCH", signal, {
          url: callbackUrl,
          secret,
        });
        requireStatus(update, 200);
      }
      const savedResponse = await githubRequest(context, account, path, "GET", signal);
      requireStatus(savedResponse, 200);
      const hookId = await verifySavedHook(savedResponse, expectedId, callbackUrl);
      saveOwner(
        context.sql,
        resource,
        hookId,
        identity,
        creating || owners.some((owner) => owner.created_here === 1),
      );
      if (!completeHookMigration(context.sql, state, registration.migrationRecordId)) {
        throw new Error("The approved webhook replacement could not be recorded.");
      }
      saveConfiguredRepositories(context.sql, subscriptionId, config);
      recordDetail(context.sql, registration.migrationRecordId, "complete", "hook");
      unlockHook(context.sql, resource, lockToken);
      return { hookId };
    } catch {
      recordDetail(
        context.sql,
        registration.migrationRecordId,
        mutationStarted ? "mutation_unresolved" : "preflight_failed",
        "hook",
      );
      if (!mutationStarted) {
        try {
          releaseHookMigrationPreflight(context.sql, state, registration.migrationRecordId);
        } catch {
          // A failed SQL release must not replace the sanitized registration error.
        } finally {
          if (locked) {
            try {
              unlockHook(context.sql, resource, lockToken);
            } catch {
              // Preserve the sanitized registration error if storage cannot release the lock.
            }
          }
        }
      }
      throw new Error("GitHub webhook replacement failed; stop for operator recovery.");
    }
  },
  async handle(context, { request, secret, config }) {
    return handleIncoming(context.sql, request, secret, config, (repository, deliveryId) =>
      context.workflows.start({
        workflow: "processQueue",
        input: { repository },
        key: `hook:${deliveryId}`,
      }),
    );
  },
  async unregister(context, { account, config, subscriptionId, state }) {
    // Unknown/legacy ownership is never proof of an orphan. Adopted hooks are preserved forever.
    if (!config?.registration || !state) throw new Error("cleanup_ownership_unknown");
    const repository = config.repositories.find(
      ({ fullName }) => fullName === config.registration.repository,
    );
    if (!repository) throw new Error("cleanup_ownership_unknown");
    const resource = hookResource(repository.id);
    const token = crypto.randomUUID();
    let locked: boolean;
    try {
      locked = lockHook(context.sql, resource, token);
    } catch {
      throw new Error("cleanup_unresolved");
    }
    if (!locked) throw new Error("cleanup_blocked");
    let deleting = false;
    try {
      const rows = context.sql
        .exec(
          "SELECT subscription_id, hook_id, created_here, released FROM github_hook_owners WHERE resource = ? AND hook_id = ?",
          resource,
          state.hookId,
        )
        .toArray();
      const owner = rows.find((row) => row.subscription_id === subscriptionId);
      if (!owner) throw new Error("cleanup_ownership_unknown");
      if (owner.released === 1) {
        unlockHook(context.sql, resource, token);
        return;
      }
      if (
        owner.created_here === 1 &&
        rows.filter((row) => row.released === 0).length === 1 &&
        !preservedHookIds.has(state.hookId)
      ) {
        // Only hooks created by this implementation can ever be deleted.
        deleting = true;
        const result = await githubRequest(
          context,
          account,
          `${repositoryPath({ fullName: config.registration.repository })}/hooks/${state.hookId}`,
          "DELETE",
          apiSignal(context.signal),
        );
        requireStatus(result, [204, 404]);
        deleting = false;
      }
      context.sql.exec(
        "UPDATE github_hook_owners SET released = 1 WHERE resource = ? AND subscription_id = ?",
        resource,
        subscriptionId,
      );
      context.sql.exec(
        "DELETE FROM configured_repositories WHERE subscription_id = ?",
        subscriptionId,
      );
      unlockHook(context.sql, resource, token);
    } catch {
      if (!deleting) {
        try {
          unlockHook(context.sql, resource, token);
        } catch {
          // Preserve the sanitized cleanup error if storage is unavailable.
        }
      }
      throw new Error("cleanup_unresolved");
    }
  },
} satisfies Webhook<HookContext, typeof replacementConfig, typeof hookState>;

export { githubWebhook };

export function readRecentReceipts(sql: SqlReader, requestedLimit?: number): ReceiptRow[] {
  const limit =
    typeof requestedLimit === "number" && Number.isSafeInteger(requestedLimit)
      ? Math.min(maxReceipts, Math.max(1, requestedLimit))
      : defaultReceiptLimit;
  return sql
    .exec<ReceiptRow>(
      `SELECT delivery_id, event, action, repository, pull_request_number, head_sha, event_base_sha, pull_request_url, received_at, ping
       FROM webhook_receipts
       ORDER BY received_at DESC, delivery_id ASC
       LIMIT CAST(? AS INTEGER)`,
      limit,
    )
    .toArray();
}

const recentReceipts = query(
  {
    title: "GitHub webhook の受信記録",
    description: "署名済み ping と Dependabot のプルリクエスト通知を最近の順に読みます。",
    input: object({ limit: number().optional() }),
  },
  async (context: QueryContext<typeof requirements>, { limit }) =>
    readRecentReceipts(context.sql, limit),
);

const replacementRegistrationDiagnostic = query(
  {
    title: "置き換え登録の安全な診断",
    description:
      "指定した予約 ID の有無、処理段階、購読 ID と固定分類だけを読みます。コールバック URL、ハッシュ、認証情報は返しません。",
    input: object({ recordId: string() }),
  },
  async (context: QueryContext<typeof requirements>, { recordId }) =>
    readHookMigrationDiagnostic(context.sql, recordId),
);

export default defineApp(requirements, {
  tools: router({
    recentReceipts,
    recentReviews: recentReviewsQuery,
    notificationStatus: notificationStatusQuery,
    recoverQueue: recoveryMutation,
    replacementRegistrationDiagnostic,
    registrationConfigurationDiagnostic: query(
      {
        description:
          "Validate a proposed config JSON without writes or provider calls. Returns fixed codes and field names only. Do not include credentials.",
        input: object({ configJson: string() }),
      },
      async (_context: QueryContext<typeof requirements>, { configJson }) => {
        try {
          return diagnoseRegistrationConfiguration(JSON.parse(configJson));
        } catch {
          return { code: "invalid_configuration", field: "config" };
        }
      },
    ),
    registrationDetail: query(
      {
        description:
          "Read fixed registration error codes and field names only; missing detail does not imply success.",
        input: object({ recordId: string() }),
      },
      async (context: QueryContext<typeof requirements>, { recordId }) =>
        readRegistrationDetail(context.sql, recordId),
    ),
  }),
  webhooks: { github: githubWebhook },
  workflows: { processQueue },
  schedules: { recoverQueue: userInterval({ minutes: 1 }, recoveryMutation, {}) },
});
