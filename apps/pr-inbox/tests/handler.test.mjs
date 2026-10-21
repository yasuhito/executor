import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  githubWebhook,
  readHookMigrationDiagnostic,
  readRecentReceipts,
  readRegistrationDetail,
  diagnoseRegistrationConfiguration,
} from "../index.ts";

const fixtureSecret = randomBytes(32).toString("base64url");
const fixtureToken = randomBytes(32).toString("hex");
const targetRepository = { id: 123456789, full_name: "example-owner/example-repository" };
const targetUrl = "https://github.com/example-owner/example-repository/pull/42";

async function createContext() {
  const database = new DatabaseSync(":memory:");
  for (const migrationName of [
    "0001_webhook_receipts.sql",
    "0002_dependabot_review_queue.sql",
    "0003_url_only_review_telegram_pending.sql",
    "0004_multi_repository_config.sql",
    "0005_dry_run_mode.sql",
    "0006_guarded_hook_ownership.sql",
  ]) {
    const migration = await readFile(
      new URL(`../migrations/${migrationName}`, import.meta.url),
      "utf8",
    );
    database.exec(migration);
  }
  const workflowStarts = [];

  const sql = {
    exec(statement, ...bindings) {
      const prepared = database.prepare(statement);
      if (prepared.columns().length > 0) {
        const rows = prepared.all(...bindings);
        return {
          rowsRead: rows.length,
          rowsWritten: 0,
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error(`expected one row, found ${rows.length}`);
            return rows[0];
          },
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      }
      const result = prepared.run(...bindings);
      return {
        rowsRead: 0,
        rowsWritten: Number(result.changes),
        toArray: () => [],
        one: () => {
          throw new Error("statement returned no rows");
        },
        [Symbol.iterator]: () => [][Symbol.iterator](),
      };
    },
    transaction(work) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = work(sql);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };

  return {
    database,
    sql,
    context: {
      sql,
      signal: new AbortController().signal,
      workflows: {
        async start(input) {
          workflowStarts.push(input);
          return { id: `workflow-${workflowStarts.length}`, status: "queued" };
        },
      },
    },
    workflowStarts,
  };
}

function makePullRequest(overrides = {}) {
  return {
    action: "opened",
    repository: { ...targetRepository },
    pull_request: {
      number: 42,
      user: { login: "dependabot[bot]", type: "Bot" },
      head: {
        sha: "0123456789abcdef0123456789abcdef01234567",
        repo: { ...targetRepository },
      },
      base: {
        sha: "89abcdef0123456789abcdef0123456789abcdef",
        repo: { ...targetRepository },
      },
    },
    ...overrides,
  };
}

function signedRequest(
  payload,
  { event = "pull_request", delivery = "11111111-2222-4333-8444-555555555555", rawBody } = {},
) {
  const body = rawBody ?? JSON.stringify(payload);
  const signature = createHmac("sha256", fixtureSecret).update(Buffer.from(body)).digest("hex");
  return new Request("https://executor.invalid/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": delivery,
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
}

async function deliver(context, request, config = replacementConfig()) {
  return githubWebhook.handle(context, {
    request,
    config,
    subscriptionId: "subscription-fixture",
    account: { method: "token", fields: { token: fixtureToken } },
    callbackUrl: "https://executor.invalid/webhook",
    state: null,
    secret: fixtureSecret,
  });
}

function receiptRows(sql) {
  return sql
    .exec(
      "SELECT delivery_id, event, action, repository, pull_request_number, head_sha, event_base_sha, pull_request_url, received_at, ping FROM webhook_receipts ORDER BY received_at DESC, delivery_id ASC",
    )
    .toArray();
}

test("stores only metadata from a signed Dependabot pull request", async () => {
  const { context, sql, workflowStarts } = await createContext();
  const response = await deliver(context, signedRequest(makePullRequest()));
  const rows = receiptRows(sql);
  const queue = sql
    .exec(
      "SELECT delivery_id, pull_request_number, event_head_sha, event_base_sha, state FROM review_queue",
    )
    .toArray();

  assert.deepEqual(
    {
      status: response.status,
      rows: rows.map(({ received_at, ...row }) => row),
      queue: queue.map(({ ...row }) => row),
      workflowStarted: workflowStarts.length === 1,
    },
    {
      status: 202,
      rows: [
        {
          delivery_id: "11111111-2222-4333-8444-555555555555",
          event: "pull_request",
          action: "opened",
          repository: "example-owner/example-repository",
          pull_request_number: 42,
          head_sha: "0123456789abcdef0123456789abcdef01234567",
          event_base_sha: "89abcdef0123456789abcdef0123456789abcdef",
          pull_request_url: targetUrl,
          ping: 0,
        },
      ],
      queue: [
        {
          delivery_id: "11111111-2222-4333-8444-555555555555",
          pull_request_number: 42,
          event_head_sha: "0123456789abcdef0123456789abcdef01234567",
          event_base_sha: "89abcdef0123456789abcdef0123456789abcdef",
          state: "queued",
        },
      ],
      workflowStarted: true,
    },
  );
});

test("accepts multiple configured repositories by matching both full name and numeric ID", async () => {
  const { context, sql, workflowStarts } = await createContext();
  const additionalRepository = {
    id: 987654321,
    full_name: "example-owner/another-repository",
  };
  const config = replacementConfig({
    repositories: [
      { fullName: targetRepository.full_name, id: targetRepository.id },
      { fullName: additionalRepository.full_name, id: additionalRepository.id },
    ],
  });
  const pullRequestPayload = makePullRequest({
    repository: additionalRepository,
    pull_request: {
      ...makePullRequest().pull_request,
      head: {
        ...makePullRequest().pull_request.head,
        repo: additionalRepository,
      },
      base: {
        ...makePullRequest().pull_request.base,
        repo: additionalRepository,
      },
    },
  });
  const mismatched = await deliver(
    context,
    signedRequest(
      makePullRequest({
        repository: { ...targetRepository, id: additionalRepository.id },
      }),
      { delivery: "11111111-2222-4333-8444-555555555556" },
    ),
    config,
  );
  const accepted = await deliver(
    context,
    signedRequest(pullRequestPayload, { delivery: "11111111-2222-4333-8444-555555555557" }),
    config,
  );

  assert.deepEqual(
    {
      statuses: [mismatched.status, accepted.status],
      rows: receiptRows(sql).map(({ repository, pull_request_url }) => ({
        repository,
        pull_request_url,
      })),
      workflowRepositories: workflowStarts.map(({ input }) => input.repository),
    },
    {
      statuses: [202, 202],
      rows: [
        {
          repository: additionalRepository.full_name,
          pull_request_url: "https://github.com/example-owner/another-repository/pull/42",
        },
      ],
      workflowRepositories: [additionalRepository.full_name],
    },
  );
});

test("deduplicates concurrent redelivery of the same signed event", async () => {
  const { context, sql, workflowStarts } = await createContext();
  const responses = await Promise.all([
    deliver(context, signedRequest(makePullRequest())),
    deliver(context, signedRequest(makePullRequest())),
  ]);

  assert.deepEqual(
    {
      statuses: responses.map(({ status }) => status),
      count: receiptRows(sql).length,
      queueCount: sql.exec("SELECT delivery_id FROM review_queue").toArray().length,
      workflowKeys: workflowStarts.map(({ key }) => key),
    },
    {
      statuses: [202, 202],
      count: 1,
      queueCount: 1,
      workflowKeys: [
        "hook:11111111-2222-4333-8444-555555555555",
        "hook:11111111-2222-4333-8444-555555555555",
      ],
    },
  );
});

test("deduplicates different deliveries for the same pull-request head and base", async () => {
  const { context, sql } = await createContext();
  const first = await deliver(
    context,
    signedRequest(makePullRequest(), { delivery: "11111111-2222-4333-8444-555555555555" }),
  );
  const second = await deliver(
    context,
    signedRequest(makePullRequest(), { delivery: "22222222-3333-4444-8555-666666666666" }),
  );

  assert.deepEqual(
    [
      first.status,
      second.status,
      receiptRows(sql).length,
      sql.exec("SELECT delivery_id FROM review_queue").toArray().length,
    ],
    [202, 202, 2, 1],
  );
});

test("a new reopened delivery can requeue the same candidate after a terminal result", async () => {
  const { context, sql } = await createContext();
  const firstId = "11111111-2222-4333-8444-555555555555";
  const secondId = "22222222-3333-4444-8555-666666666666";
  const first = await deliver(context, signedRequest(makePullRequest(), { delivery: firstId }));
  sql.exec("UPDATE review_queue SET state = 'complete' WHERE delivery_id = ?", firstId);
  const second = await deliver(
    context,
    signedRequest(makePullRequest({ action: "reopened" }), { delivery: secondId }),
  );
  const queue = sql
    .exec("SELECT delivery_id, state FROM review_queue ORDER BY delivery_id")
    .toArray();

  assert.deepEqual(
    { statuses: [first.status, second.status], queue: queue.map(({ ...row }) => row) },
    {
      statuses: [202, 202],
      queue: [
        { delivery_id: firstId, state: "complete" },
        { delivery_id: secondId, state: "queued" },
      ],
    },
  );
});

test("a reopened delivery during processing queues a serialized follow-up", async () => {
  const { context, sql } = await createContext();
  const firstId = "33333333-4444-4555-8666-777777777777";
  const secondId = "44444444-5555-4666-8777-888888888888";
  const first = await deliver(context, signedRequest(makePullRequest(), { delivery: firstId }));
  sql.exec(
    "UPDATE review_queue SET state = 'processing', run_id = 'run-1', fencing = 1, lease_until = 999999999999 WHERE delivery_id = ?",
    firstId,
  );
  const second = await deliver(
    context,
    signedRequest(makePullRequest({ action: "reopened" }), { delivery: secondId }),
  );
  const queue = sql
    .exec("SELECT delivery_id, state FROM review_queue ORDER BY delivery_id")
    .toArray();

  assert.deepEqual(
    { statuses: [first.status, second.status], queue: queue.map(({ ...row }) => row) },
    {
      statuses: [202, 202],
      queue: [
        { delivery_id: firstId, state: "processing" },
        { delivery_id: secondId, state: "queued" },
      ],
    },
  );
});

test("checks the HMAC against the original request bytes", async () => {
  const { context, sql } = await createContext();
  const rawBody = ` ${JSON.stringify(makePullRequest())}\n`;
  const response = await deliver(context, signedRequest(null, { rawBody }));

  assert.deepEqual(
    { status: response.status, count: receiptRows(sql).length },
    { status: 202, count: 1 },
  );
});

test("stores a minimal signed ping receipt", async () => {
  const { context, sql } = await createContext();
  const response = await deliver(
    context,
    signedRequest(
      {
        repository: { ...targetRepository },
        hook_id: 987,
        hook: { id: 987, type: "Repository" },
        zen: "not retained",
      },
      { event: "ping" },
    ),
  );
  const rows = receiptRows(sql);

  assert.deepEqual(
    {
      status: response.status,
      row: rows.map(({ received_at, ...row }) => row)[0],
      count: rows.length,
    },
    {
      status: 202,
      row: {
        delivery_id: "11111111-2222-4333-8444-555555555555",
        event: "ping",
        action: null,
        repository: "example-owner/example-repository",
        pull_request_number: null,
        head_sha: null,
        event_base_sha: null,
        pull_request_url: null,
        ping: 1,
      },
      count: 1,
    },
  );
});

test("rejects missing and incorrect signatures without writes", async () => {
  const { context, sql } = await createContext();
  const valid = signedRequest(makePullRequest());
  const missing = new Request(valid.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "11111111-2222-4333-8444-555555555555",
      "x-github-event": "pull_request",
    },
    body: JSON.stringify(makePullRequest()),
  });
  const incorrect = new Request(valid.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "11111111-2222-4333-8444-555555555555",
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
    },
    body: JSON.stringify(makePullRequest()),
  });
  const responses = await Promise.all([deliver(context, missing), deliver(context, incorrect)]);

  assert.deepEqual(
    {
      statuses: responses.map(({ status }) => status),
      count: receiptRows(sql).length,
    },
    { statuses: [401, 401], count: 0 },
  );
});

test("ignores unsupported events, actions, authors, and repository identities", async () => {
  const { context, sql } = await createContext();
  const payloads = [
    { event: "issues", payload: { repository: { ...targetRepository } } },
    { event: "ping", payload: makePullRequest() },
    { event: "pull_request", payload: makePullRequest({ action: "closed" }) },
    {
      event: "pull_request",
      payload: makePullRequest({
        pull_request: {
          ...makePullRequest().pull_request,
          user: { login: "octocat", type: "User" },
        },
      }),
    },
    {
      event: "pull_request",
      payload: makePullRequest({
        repository: { id: 1, full_name: "someone/else" },
      }),
    },
    {
      event: "pull_request",
      payload: makePullRequest({
        pull_request: {
          ...makePullRequest().pull_request,
          head: {
            ...makePullRequest().pull_request.head,
            repo: { id: 1, full_name: "someone/else" },
          },
        },
      }),
    },
    {
      event: "pull_request",
      payload: makePullRequest({
        pull_request: {
          ...makePullRequest().pull_request,
          base: {
            sha: "89abcdef0123456789abcdef0123456789abcdef",
            repo: { id: 1, full_name: "someone/else" },
          },
        },
      }),
    },
  ];
  const responses = await Promise.all(
    payloads.map(({ event, payload }, index) =>
      deliver(
        context,
        signedRequest(payload, {
          event,
          delivery: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        }),
      ),
    ),
  );

  assert.deepEqual(
    {
      statuses: responses.map(({ status }) => status),
      count: receiptRows(sql).length,
    },
    { statuses: [202, 202, 202, 202, 202, 202, 202], count: 0 },
  );
});

test("refuses malformed signed JSON without writes", async () => {
  const { context, sql } = await createContext();
  const response = await deliver(context, signedRequest(null, { rawBody: "{not-json" }));

  assert.deepEqual(
    { status: response.status, count: receiptRows(sql).length },
    { status: 400, count: 0 },
  );
});

test("rejects an oversized signed body without writes", async () => {
  const { context, sql } = await createContext();
  const oversized = "x".repeat(1024 * 1024 + 1);
  const response = await deliver(context, signedRequest(null, { rawBody: oversized }));

  assert.deepEqual(
    { status: response.status, count: receiptRows(sql).length },
    { status: 413, count: 0 },
  );
});

test("bounds recent receipt queries to the newest 100 rows", async () => {
  const { sql } = await createContext();
  for (let index = 0; index < 120; index += 1) {
    sql.exec(
      "INSERT INTO webhook_receipts (delivery_id, event, action, repository, pull_request_number, head_sha, pull_request_url, received_at, ping) VALUES (?, 'ping', NULL, 'example-owner/example-repository', NULL, NULL, NULL, ?, 1)",
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      index,
    );
  }
  const rows = readRecentReceipts(sql, 1000);

  assert.deepEqual(
    {
      count: rows.length,
      newest: rows[0].received_at,
      oldest: rows.at(-1).received_at,
    },
    { count: 100, newest: 119, oldest: 20 },
  );
});

const diagnosticReservationId = "migration_test_record";
const diagnosticSubscriptionId = "whk_test-diagnostic-subscription";

function seedMigrationDiagnostic(sql, phase) {
  sql.exec(
    `INSERT INTO github_hook_registrations
      (subscription_id, hook_id, lease_token, lease_until)
     VALUES (?, 424242, ?, 0)`,
    diagnosticReservationId,
    JSON.stringify({
      version: 1,
      phase,
      subscriptionId: diagnosticSubscriptionId,
      originalCallbackHash: "a".repeat(64),
      replacementCallbackHash: "b".repeat(64),
      secretFingerprint: "c".repeat(64),
      token: "diagnostic-test-token",
    }),
  );
}

test("registration diagnostic reports when no reservation was recorded", async () => {
  const { sql } = await createContext();

  assert.deepEqual(readHookMigrationDiagnostic(sql, diagnosticReservationId), {
    reservation: "absent",
    phase: null,
    subscriptionId: null,
    failureClass: "before_reservation",
  });
});

test("registration diagnostic localizes a failure before the GitHub PATCH phase", async () => {
  const { sql } = await createContext();
  seedMigrationDiagnostic(sql, "preflight");

  assert.deepEqual(readHookMigrationDiagnostic(sql, diagnosticReservationId), {
    reservation: "present",
    phase: "preflight",
    subscriptionId: diagnosticSubscriptionId,
    failureClass: "pre_patch",
  });
});

test("registration diagnostic treats a patching reservation as unresolved", async () => {
  const { sql } = await createContext();
  seedMigrationDiagnostic(sql, "patching");

  assert.deepEqual(readHookMigrationDiagnostic(sql, diagnosticReservationId), {
    reservation: "present",
    phase: "patching",
    subscriptionId: diagnosticSubscriptionId,
    failureClass: "patch_outcome_unresolved",
  });
});

test("registration diagnostic reports a completed migration without sensitive fields", async () => {
  const { sql } = await createContext();
  seedMigrationDiagnostic(sql, "complete");

  assert.deepEqual(readHookMigrationDiagnostic(sql, diagnosticReservationId), {
    reservation: "present",
    phase: "complete",
    subscriptionId: diagnosticSubscriptionId,
    failureClass: "recorded_complete",
  });
});

test("registration diagnostic does not expose malformed reservation data", async () => {
  const { sql } = await createContext();
  sql.exec(
    `INSERT INTO github_hook_registrations
      (subscription_id, hook_id, lease_token, lease_until)
     VALUES (?, 424242, ?, 0)`,
    diagnosticReservationId,
    "not-json",
  );

  assert.deepEqual(readHookMigrationDiagnostic(sql, diagnosticReservationId), {
    reservation: "present",
    phase: null,
    subscriptionId: null,
    failureClass: "invalid_reservation",
  });
});

test("registration diagnostic maps unreadable storage to a closed failure class", () => {
  const diagnostic = readHookMigrationDiagnostic(
    {
      exec() {
        throw new Error("private storage failure");
      },
    },
    diagnosticReservationId,
  );

  assert.deepEqual(diagnostic, {
    reservation: "unavailable",
    phase: null,
    subscriptionId: null,
    failureClass: "diagnostic_unavailable",
  });
});

test("registration diagnostic issues only a SELECT for its reserved row", () => {
  const statements = [];
  const diagnostic = readHookMigrationDiagnostic(
    {
      exec(statement, ...bindings) {
        statements.push({ statement, bindings });
        return { toArray: () => [] };
      },
    },
    diagnosticReservationId,
  );

  assert.deepEqual(
    { diagnostic, statements },
    {
      diagnostic: {
        reservation: "absent",
        phase: null,
        subscriptionId: null,
        failureClass: "before_reservation",
      },
      statements: [
        {
          statement: "SELECT lease_token FROM github_hook_registrations WHERE subscription_id = ?",
          bindings: [diagnosticReservationId],
        },
      ],
    },
  );
});

const approvedHookId = 424242;
const approvedSubscriptionId = "whk_test-source-subscription";
const approvedSourceAccountId = "acc_test-source-account";
const approvedOriginalCallbackUrl =
  "https://executor.example.invalid/webhooks/original-subscription";
const replacementCallbackUrl = "https://executor.example.invalid/webhooks/replacement-subscription";
const replacementSubscriptionId = "whk_test-replacement-subscription";
const approvedHookPath = `/repos/example-owner/example-repository/hooks/${approvedHookId}`;
const approvedHookConfigPath = `${approvedHookPath}/config`;
const reviewWorkerUrl = "https://review.example.invalid";

function replacementConfig(overrides = {}) {
  return {
    repositories: [{ fullName: targetRepository.full_name, id: targetRepository.id }],
    reviewWorkerUrl,
    registration: {
      repository: targetRepository.full_name,
      hookId: approvedHookId,
      sourceSubscriptionId: approvedSubscriptionId,
      sourceAccountId: approvedSourceAccountId,
      migrationRecordId: diagnosticReservationId,
      fromCallbackUrl: approvedOriginalCallbackUrl,
    },
    ...overrides,
  };
}

function withRegistration(overrides = {}) {
  const config = replacementConfig();
  return {
    ...config,
    registration: { ...config.registration, ...overrides },
  };
}

function configuredHook(overrides = {}) {
  return {
    id: approvedHookId,
    name: "web",
    active: true,
    events: ["pull_request"],
    ...overrides,
    config: {
      url: approvedOriginalCallbackUrl,
      content_type: "json",
      insecure_ssl: "0",
      ...overrides.config,
    },
  };
}

function visibleHook(hook) {
  return {
    id: hook.id,
    name: hook.name,
    active: hook.active,
    events: hook.events,
    config: {
      url: hook.config.url,
      content_type: hook.config.content_type,
      insecure_ssl: String(hook.config.insecure_ssl),
    },
  };
}

async function registrationFixture({
  initialHook = configuredHook(),
  preflightStatus = 200,
  patchStatus = 200,
  patchThrows = false,
  holdPreflight = false,
  postPatchTransform = (hook) => hook,
} = {}) {
  const { sql } = await createContext();
  const calls = [];
  let currentHook = structuredClone(initialHook);
  let currentPreflightStatus = preflightStatus;
  let getCount = 0;
  let markPreflightStarted;
  let releasePreflight;
  const preflightStarted = new Promise((resolve) => {
    markPreflightStarted = resolve;
  });
  const preflightGate = new Promise((resolve) => {
    releasePreflight = resolve;
  });
  const context = {
    sql,
    signal: new AbortController().signal,
    async fetch(input, init = {}) {
      const url = new URL(input);
      const method = init.method ?? "GET";
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      if (url.pathname === "/repos/example-owner/example-repository" && method === "GET")
        return Response.json({ id: targetRepository.id, full_name: targetRepository.full_name });
      if (url.pathname === "/repos/example-owner/example-repository/hooks" && method === "GET")
        return Response.json([currentHook]);
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === approvedHookPath && method === "GET") {
        getCount += 1;
        if (getCount === 1 && holdPreflight) {
          markPreflightStarted();
          await preflightGate;
        }
        if (currentHook.config.url === replacementCallbackUrl)
          return Response.json(postPatchTransform(structuredClone(currentHook)));
        if (currentPreflightStatus !== 200)
          return Response.json({ message: "Not Found" }, { status: currentPreflightStatus });
        return Response.json(currentHook);
      }
      if (url.pathname === approvedHookConfigPath && method === "PATCH") {
        const visibleConfig = Object.fromEntries(
          Object.entries(body).filter(([key]) => key !== "secret"),
        );
        currentHook = {
          ...currentHook,
          config: { ...currentHook.config, ...visibleConfig },
        };
        if (patchThrows) throw new Error("injected lost response");
        return Response.json({ accepted: true }, { status: patchStatus });
      }
      throw new Error(`unexpected fake GitHub request: ${method} ${url.pathname}`);
    },
  };
  return {
    context,
    calls,
    currentHook: () => structuredClone(currentHook),
    preflightStarted,
    releasePreflight,
    setPreflightStatus(status) {
      currentPreflightStatus = status;
    },
  };
}

function registrationInput(overrides = {}) {
  return {
    config: replacementConfig(),
    subscriptionId: replacementSubscriptionId,
    account: {
      id: approvedSourceAccountId,
      method: "token",
      fields: { token: fixtureToken },
    },
    callbackUrl: replacementCallbackUrl,
    secret: fixtureSecret,
    ...overrides,
  };
}

async function registrationOutcome(context, input) {
  try {
    return { result: await githubWebhook.register(context, input) };
  } catch (error) {
    return { error: error.message };
  }
}

test("replacement registration patches the approved hook and replaces the source repository configuration", async () => {
  const fixture = await registrationFixture();
  fixture.context.sql.exec(
    `INSERT INTO configured_repositories
      (subscription_id, full_name, repository_id, review_worker_url)
     VALUES (?, ?, ?, ?)`,
    approvedSubscriptionId,
    targetRepository.full_name,
    targetRepository.id,
    "https://old-review.example.invalid",
  );
  const outcome = await registrationOutcome(fixture.context, registrationInput());

  assert.deepEqual(
    {
      result: outcome.result,
      requests: fixture.calls.map(({ method, path, body }) => ({
        method,
        path,
        body:
          body === undefined
            ? null
            : {
                keys: Object.keys(body).sort(),
                url: body.url,
                hostSecretTransported: body.secret === fixtureSecret,
              },
      })),
      hook: visibleHook(fixture.currentHook()),
      configuredRepositories: fixture.context.sql
        .exec(
          "SELECT subscription_id, full_name, repository_id, review_worker_url, dry_run FROM configured_repositories",
        )
        .toArray()
        .map(({ ...row }) => row),
      resultLeaksSecret: JSON.stringify(outcome).includes(fixtureSecret),
    },
    {
      result: { hookId: approvedHookId },
      requests: [
        { method: "GET", path: approvedHookPath, body: null },
        {
          method: "PATCH",
          path: approvedHookConfigPath,
          body: {
            keys: ["secret", "url"],
            url: replacementCallbackUrl,
            hostSecretTransported: true,
          },
        },
        { method: "GET", path: approvedHookPath, body: null },
      ],
      hook: {
        id: approvedHookId,
        name: "web",
        active: true,
        events: ["pull_request"],
        config: {
          url: replacementCallbackUrl,
          content_type: "json",
          insecure_ssl: "0",
        },
      },
      configuredRepositories: [
        {
          subscription_id: replacementSubscriptionId,
          full_name: targetRepository.full_name,
          repository_id: targetRepository.id,
          review_worker_url: reviewWorkerUrl,
          dry_run: 1,
        },
      ],
      resultLeaksSecret: false,
    },
  );
});

test("the same replacement registration retries without repeating the GitHub patch", async () => {
  const fixture = await registrationFixture();
  const input = registrationInput();
  const first = await registrationOutcome(fixture.context, input);
  const second = await registrationOutcome(fixture.context, input);

  assert.deepEqual(
    {
      outcomes: [first, second],
      requests: fixture.calls.map(({ method, path }) => ({ method, path })),
      patchCount: fixture.calls.filter(({ method }) => method === "PATCH").length,
      resultLeaksSecret: JSON.stringify([first, second]).includes(fixtureSecret),
    },
    {
      outcomes: [{ result: { hookId: approvedHookId } }, { result: { hookId: approvedHookId } }],
      requests: [
        { method: "GET", path: approvedHookPath },
        { method: "PATCH", path: approvedHookConfigPath },
        { method: "GET", path: approvedHookPath },
        { method: "GET", path: approvedHookPath },
      ],
      patchCount: 1,
      resultLeaksSecret: false,
    },
  );
});

test("a changed secret cannot reuse a completed registration ID", async () => {
  const fixture = await registrationFixture();
  const first = await registrationOutcome(fixture.context, registrationInput());
  const second = await registrationOutcome(
    fixture.context,
    registrationInput({ secret: "different-fixture-secret" }),
  );
  const marker = fixture.context.sql
    .exec(
      "SELECT lease_token FROM github_hook_registrations WHERE subscription_id = ?",
      diagnosticReservationId,
    )
    .one().lease_token;

  assert.deepEqual(
    {
      first,
      second,
      requests: fixture.calls.map(({ method }) => method),
      markerLeaksSecret: marker.includes(fixtureSecret),
      resultsLeakSecret: JSON.stringify([first, second]).includes(fixtureSecret),
    },
    {
      first: { result: { hookId: approvedHookId } },
      second: { error: "The approved webhook replacement is already claimed or unresolved." },
      requests: ["GET", "PATCH", "GET"],
      markerLeaksSecret: false,
      resultsLeakSecret: false,
    },
  );
});

test("long secrets are not fingerprinted as their effective HMAC key", async () => {
  const secret = "fixture-secret-".repeat(8);
  const fixture = await registrationFixture();
  const outcome = await registrationOutcome(fixture.context, registrationInput({ secret }));
  const marker = JSON.parse(
    fixture.context.sql
      .exec(
        "SELECT lease_token FROM github_hook_registrations WHERE subscription_id = ?",
        diagnosticReservationId,
      )
      .one().lease_token,
  );
  const rawDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const rawFingerprint = Array.from(new Uint8Array(rawDigest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  assert.deepEqual(
    {
      result: outcome.result,
      fingerprintEqualsEffectiveHmacKey: marker.secretFingerprint === rawFingerprint,
    },
    {
      result: { hookId: approvedHookId },
      fingerprintEqualsEffectiveHmacKey: false,
    },
  );
});

test("concurrent attempts for one replacement serialize to one GitHub PATCH", async () => {
  const fixture = await registrationFixture({ holdPreflight: true });
  const firstPending = registrationOutcome(fixture.context, registrationInput());
  await fixture.preflightStarted;
  const second = await registrationOutcome(fixture.context, registrationInput());
  fixture.releasePreflight();
  const first = await firstPending;

  assert.deepEqual(
    {
      first,
      second,
      requests: fixture.calls.map(({ method, path }) => ({ method, path })),
      patchCount: fixture.calls.filter(({ method }) => method === "PATCH").length,
    },
    {
      first: { result: { hookId: approvedHookId } },
      second: { error: "The approved webhook replacement is already claimed or unresolved." },
      requests: [
        { method: "GET", path: approvedHookPath },
        { method: "PATCH", path: approvedHookConfigPath },
        { method: "GET", path: approvedHookPath },
      ],
      patchCount: 1,
    },
  );
});

test("the original subscription cannot register through the replacement source", async () => {
  const fixture = await registrationFixture();
  const outcome = await registrationOutcome(
    fixture.context,
    registrationInput({ subscriptionId: approvedSubscriptionId }),
  );

  assert.deepEqual(
    { outcome, calls: fixture.calls.length },
    {
      outcome: { error: "Executor supplied invalid webhook replacement details." },
      calls: 0,
    },
  );
});

test("a different subscription cannot take over after the replacement is complete", async () => {
  const fixture = await registrationFixture();
  const first = await registrationOutcome(fixture.context, registrationInput());
  const second = await registrationOutcome(
    fixture.context,
    registrationInput({ subscriptionId: "whk_test-other-subscription" }),
  );

  assert.deepEqual(
    {
      first,
      second,
      requests: fixture.calls.map(({ method, path }) => ({ method, path })),
    },
    {
      first: { result: { hookId: approvedHookId } },
      second: { error: "The approved webhook replacement is already claimed or unresolved." },
      requests: [
        { method: "GET", path: approvedHookPath },
        { method: "PATCH", path: approvedHookConfigPath },
        { method: "GET", path: approvedHookPath },
      ],
    },
  );
});

test("missing hook stops before any GitHub mutation", async () => {
  const fixture = await registrationFixture({ preflightStatus: 404 });
  const outcome = await registrationOutcome(fixture.context, registrationInput());

  assert.deepEqual(
    {
      outcome,
      methods: fixture.calls.map(({ method }) => method),
      resultLeaksSecret: JSON.stringify(outcome).includes(fixtureSecret),
    },
    {
      outcome: { error: "GitHub webhook replacement failed; stop for operator recovery." },
      methods: ["GET"],
      resultLeaksSecret: false,
    },
  );
});

test("the same registration can retry after a preflight failure", async () => {
  const fixture = await registrationFixture({ preflightStatus: 404 });
  const input = registrationInput();
  const first = await registrationOutcome(fixture.context, input);
  fixture.setPreflightStatus(200);
  const second = await registrationOutcome(fixture.context, input);

  assert.deepEqual(
    {
      outcomes: [first, second],
      requests: fixture.calls.map(({ method }) => method),
      patchCount: fixture.calls.filter(({ method }) => method === "PATCH").length,
    },
    {
      outcomes: [
        { error: "GitHub webhook replacement failed; stop for operator recovery." },
        { result: { hookId: approvedHookId } },
      ],
      requests: ["GET", "GET", "PATCH", "GET"],
      patchCount: 1,
    },
  );
});

test("a different registration stays blocked after preflight failure", async () => {
  const fixture = await registrationFixture({ preflightStatus: 404 });
  const first = await registrationOutcome(fixture.context, registrationInput());
  const second = await registrationOutcome(
    fixture.context,
    registrationInput({ subscriptionId: "whk_test-other-subscription" }),
  );

  assert.deepEqual(
    {
      first,
      second,
      methods: fixture.calls.map(({ method }) => method),
    },
    {
      first: { error: "GitHub webhook replacement failed; stop for operator recovery." },
      second: { error: "The approved webhook replacement is already claimed or unresolved." },
      methods: ["GET"],
    },
  );
});

const mismatchedHooks = [
  ["returned hook ID", configuredHook({ id: approvedHookId + 1 })],
  ["name", configuredHook({ name: "other" })],
  ["active state", configuredHook({ active: false })],
  ["event list", configuredHook({ events: ["pull_request", "push"] })],
  [
    "original callback",
    configuredHook({ config: { url: "https://executor.example.invalid/webhooks/other" } }),
  ],
  ["content type", configuredHook({ config: { content_type: "form" } })],
  ["TLS setting", configuredHook({ config: { insecure_ssl: "1" } })],
  ["missing TLS setting", configuredHook({ config: { insecure_ssl: undefined } })],
];
for (const [setting, hook] of mismatchedHooks) {
  test(`replacement stops on a mismatched ${setting} before mutation`, async () => {
    const fixture = await registrationFixture({ initialHook: hook });
    const outcome = await registrationOutcome(fixture.context, registrationInput());

    assert.deepEqual(
      {
        outcome,
        methods: fixture.calls.map(({ method }) => method),
      },
      {
        outcome: { error: "GitHub webhook replacement failed; stop for operator recovery." },
        // Identity/list validation can now refuse before the exact-hook GET.
        methods: ["returned hook ID", "original callback", "missing TLS setting"].includes(setting)
          ? []
          : ["GET"],
      },
    );
  });
}

const invalidRegistrationInputs = [
  ["empty source subscription", { config: withRegistration({ sourceSubscriptionId: "" }) }],
  ["empty migration record ID", { config: withRegistration({ migrationRecordId: "" }) }],
  [
    "registration repository outside the allowlist",
    { config: withRegistration({ repository: "example-owner/another-repository" }) },
  ],
  ["empty repository allowlist", { config: replacementConfig({ repositories: [] }) }],
  [
    "duplicate repository allowlist entry",
    {
      config: replacementConfig({
        repositories: [targetRepository, targetRepository].map(({ id, full_name }) => ({
          id,
          fullName: full_name,
        })),
      }),
    },
  ],
  [
    "non-HTTPS review worker URL",
    { config: replacementConfig({ reviewWorkerUrl: "http://review.example.invalid" }) },
  ],
  [
    "review worker URL with a path",
    { config: replacementConfig({ reviewWorkerUrl: "https://review.example.invalid/path" }) },
  ],
  [
    "wrong GitHub account",
    { account: { id: "acc_wrong", method: "token", fields: { token: fixtureToken } } },
  ],
  ["noncanonical callback origin", { callbackUrl: "https://other.example/webhooks/replacement" }],
  ["callback with query", { callbackUrl: `${replacementCallbackUrl}?token=unsafe` }],
  [
    "callback with user info",
    { callbackUrl: "https://user@executor.example.invalid/webhooks/replacement" },
  ],
  ["callback equal to original", { callbackUrl: approvedOriginalCallbackUrl }],
];
for (const [setting, override] of invalidRegistrationInputs) {
  test(`replacement rejects ${setting} without contacting GitHub`, async () => {
    const fixture = await registrationFixture();
    const outcome = await registrationOutcome(fixture.context, registrationInput(override));

    assert.deepEqual(
      { outcome, requests: fixture.calls.length },
      {
        outcome: { error: "Executor supplied invalid webhook replacement details." },
        requests: 0,
      },
    );
  });
}

test("ambiguous PATCH failure never triggers an automatic replay", async () => {
  const fixture = await registrationFixture({ patchStatus: 422 });
  const input = registrationInput();
  const first = await registrationOutcome(fixture.context, input);
  const second = await registrationOutcome(fixture.context, input);

  assert.deepEqual(
    {
      outcomes: [first, second],
      requests: fixture.calls.map(({ method }) => method),
      patchCount: fixture.calls.filter(({ method }) => method === "PATCH").length,
      resultsLeakSecret: JSON.stringify([first, second]).includes(fixtureSecret),
    },
    {
      outcomes: [
        { error: "GitHub webhook replacement failed; stop for operator recovery." },
        { error: "The approved webhook replacement is already claimed or unresolved." },
      ],
      requests: ["GET", "PATCH"],
      patchCount: 1,
      resultsLeakSecret: false,
    },
  );
});

test("a lost PATCH response leaves the registration unresolved without exposing the secret", async () => {
  const fixture = await registrationFixture({ patchThrows: true });
  const input = registrationInput();
  const first = await registrationOutcome(fixture.context, input);
  const second = await registrationOutcome(fixture.context, input);

  assert.deepEqual(
    {
      outcomes: [first, second],
      requests: fixture.calls.map(({ method }) => method),
      patchCount: fixture.calls.filter(({ method }) => method === "PATCH").length,
      resultsLeakSecret: JSON.stringify([first, second]).includes(fixtureSecret),
    },
    {
      outcomes: [
        { error: "GitHub webhook replacement failed; stop for operator recovery." },
        { error: "The approved webhook replacement is already claimed or unresolved." },
      ],
      requests: ["GET", "PATCH"],
      patchCount: 1,
      resultsLeakSecret: false,
    },
  );
});

test("an unverifiable post-PATCH readback blocks retries without another mutation", async () => {
  const fixture = await registrationFixture({
    postPatchTransform: (hook) => ({ ...hook, active: false }),
  });
  const input = registrationInput();
  const first = await registrationOutcome(fixture.context, input);
  const second = await registrationOutcome(fixture.context, input);

  assert.deepEqual(
    {
      outcomes: [first, second],
      requests: fixture.calls.map(({ method }) => method),
      patchCount: fixture.calls.filter(({ method }) => method === "PATCH").length,
    },
    {
      outcomes: [
        { error: "GitHub webhook replacement failed; stop for operator recovery." },
        { error: "The approved webhook replacement is already claimed or unresolved." },
      ],
      requests: ["GET", "PATCH", "GET"],
      patchCount: 1,
    },
  );
});

test("registration preserves GitHub's numeric secure TLS setting without sending it", async () => {
  const fixture = await registrationFixture({
    initialHook: configuredHook({ config: { insecure_ssl: 0 } }),
  });
  await registrationOutcome(fixture.context, registrationInput());
  const patch = fixture.calls.find(({ method }) => method === "PATCH");

  assert.deepEqual(
    {
      patchKeys: Object.keys(patch.body).sort(),
      savedTlsSetting: String(fixture.currentHook().config.insecure_ssl),
      savedEvents: fixture.currentHook().events,
    },
    {
      patchKeys: ["secret", "url"],
      savedTlsSetting: "0",
      savedEvents: ["pull_request"],
    },
  );
});

test("unregister refuses unknown ownership without contacting GitHub", async () => {
  const fixture = await registrationFixture();
  let message;
  try {
    await githubWebhook.unregister(fixture.context, {
      ...registrationInput(),
      state: { hookId: approvedHookId },
    });
  } catch (error) {
    message = error.message;
  }

  assert.deepEqual(
    { message, calls: fixture.calls },
    {
      message: "cleanup_unresolved",
      calls: [],
    },
  );
});

async function selfHealingFixture({
  hooks = [configuredHook()],
  repoId = targetRepository.id,
  repoFullName = targetRepository.full_name,
  loseCreateResponse = false,
  duplicateReadback = false,
} = {}) {
  const { context } = await createContext();
  const calls = [];
  const records = structuredClone(hooks);
  let currentRepoFullName = repoFullName;
  context.fetch = async (input, init) => {
    const url = new URL(input);
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    const base = "/repos/example-owner/example-repository";
    const pathname = url.pathname.toLowerCase();
    if (pathname === base) return Response.json({ id: repoId, full_name: currentRepoFullName });
    if (method === "GET" && pathname === `${base}/hooks`) return Response.json(records);
    if (method === "POST" && pathname === `${base}/hooks`) {
      const hook = { ...body, id: approvedHookId + 10 };
      records.push(hook);
      if (loseCreateResponse) throw new Error(`private ${fixtureSecret} ${replacementCallbackUrl}`);
      return Response.json(hook, { status: 201 });
    }
    const id = Number(
      url.pathname
        .split("/")
        .filter(Boolean)
        .at(method === "PATCH" ? -2 : -1),
    );
    const hook = records.find((record) => record.id === id);
    if (!hook) return new Response(null, { status: 404 });
    if (method === "GET")
      return Response.json(
        duplicateReadback && hook.config.url === replacementCallbackUrl
          ? { ...hook, id: id + 1 }
          : hook,
      );
    if (method === "PATCH") {
      assert.deepEqual(Object.keys(body).sort(), ["secret", "url"]);
      hook.config.url = body.url;
      return Response.json({});
    }
    if (method === "DELETE") {
      records.splice(records.indexOf(hook), 1);
      return new Response(null, { status: 204 });
    }
    throw new Error("unexpected mock request");
  };
  return {
    context,
    calls,
    records,
    setRepoFullName(fullName) {
      currentRepoFullName = fullName;
    },
  };
}

test("exact repository and target hook adoption uses GET/PATCH and never POST/DELETE", async () => {
  const fixture = await selfHealingFixture({
    hooks: [configuredHook({ config: { url: replacementCallbackUrl } })],
  });
  assert.deepEqual(await githubWebhook.register(fixture.context, registrationInput()), {
    hookId: approvedHookId,
  });
  assert.deepEqual(
    fixture.calls.map(({ method }) => method),
    ["GET", "GET", "GET", "PATCH", "GET"],
  );
  assert.equal(fixture.calls[2].path, approvedHookPath);
  assert.deepEqual(readRegistrationDetail(fixture.context.sql, diagnosticReservationId), {
    code: "complete",
    field: "hook",
  });
});

test("absent target creates exactly once; retry reads the saved new ID without POST", async () => {
  const fixture = await selfHealingFixture({ hooks: [] });
  const first = await githubWebhook.register(fixture.context, registrationInput());
  const second = await githubWebhook.register(fixture.context, registrationInput());
  assert.deepEqual(first, { hookId: approvedHookId + 10 });
  assert.deepEqual(second, first);
  assert.equal(fixture.calls.filter(({ method }) => method === "POST").length, 1);
  assert.equal(
    fixture.calls.filter(({ method }) => method === "PATCH" || method === "DELETE").length,
    0,
  );
});

test("completed retry restores missing ownership only as an adopted hook", async () => {
  const fixture = await selfHealingFixture({ hooks: [] });
  const state = await githubWebhook.register(fixture.context, registrationInput());
  fixture.context.sql.exec(
    "DELETE FROM github_hook_owners WHERE resource = ? AND subscription_id = ?",
    `github-repository:${targetRepository.id}`,
    replacementSubscriptionId,
  );

  assert.deepEqual(await githubWebhook.register(fixture.context, registrationInput()), state);
  const owner = fixture.context.sql
    .exec(
      "SELECT hook_id, created_here FROM github_hook_owners WHERE resource = ? AND subscription_id = ?",
      `github-repository:${targetRepository.id}`,
      replacementSubscriptionId,
    )
    .toArray()[0];
  assert.equal(owner.hook_id, state.hookId);
  assert.equal(owner.created_here, 0);
  await githubWebhook.unregister(fixture.context, { ...registrationInput(), state });
  assert.equal(
    fixture.calls.some(({ method }) => method === "DELETE"),
    false,
  );
});

test("preflight release SQL failure does not strand the hook lock or leak the error", async () => {
  const fixture = await selfHealingFixture({ repoId: targetRepository.id + 1 });
  const originalExec = fixture.context.sql.exec;
  fixture.context.sql.exec = function (statement, ...parameters) {
    if (statement.includes("SET lease_until = 0")) throw new Error(fixtureSecret);
    return originalExec.call(this, statement, ...parameters);
  };

  const outcome = await registrationOutcome(fixture.context, registrationInput());
  fixture.context.sql.exec = originalExec;
  assert.equal(outcome.error, "GitHub webhook replacement failed; stop for operator recovery.");
  assert.equal(
    fixture.context.sql.exec("SELECT count(*) AS count FROM github_hook_locks").toArray()[0].count,
    0,
  );
  assert.equal(JSON.stringify(outcome).includes(fixtureSecret), false);
});

for (const [name, options] of [
  ["duplicate targets", { hooks: [configuredHook(), configuredHook({ id: approvedHookId + 1 })] }],
  ["wrong target ID", { hooks: [configuredHook({ id: approvedHookId + 1 })] }],
  [
    "approved ID at wrong URL",
    { hooks: [configuredHook({ config: { url: "https://other.invalid/hook" } })] },
  ],
  ["wrong repository ID", { repoId: targetRepository.id + 1 }],
]) {
  test(`self healing refuses ${name} without POST/PATCH/DELETE`, async () => {
    const fixture = await selfHealingFixture(options);
    const outcome = await registrationOutcome(fixture.context, registrationInput());
    assert.ok(outcome.error);
    assert.ok(fixture.calls.every(({ method }) => method === "GET"));
    assert.deepEqual(readRegistrationDetail(fixture.context.sql, diagnosticReservationId), {
      code: "preflight_failed",
      field: "hook",
    });
  });
}

test("ambiguous creation and readback stop retries and leak no private data", async () => {
  for (const options of [{ hooks: [], loseCreateResponse: true }, { duplicateReadback: true }]) {
    const fixture = await selfHealingFixture(options);
    const outcomes = [
      await registrationOutcome(fixture.context, registrationInput()),
      await registrationOutcome(fixture.context, registrationInput()),
    ];
    assert.ok(outcomes.every((outcome) => outcome.error));
    assert.equal(
      fixture.calls.filter(({ method }) => method === "POST" || method === "PATCH").length,
      1,
    );
    const diagnostic = readRegistrationDetail(fixture.context.sql, diagnosticReservationId);
    const printed = JSON.stringify([outcomes, diagnostic]);
    for (const privateValue of [
      fixtureSecret,
      fixtureToken,
      replacementCallbackUrl,
      approvedOriginalCallbackUrl,
    ])
      assert.equal(printed.includes(privateValue), false);
    assert.equal(
      fixture.calls.some(({ method }) => method === "DELETE"),
      false,
    );
  }
});

test("adopted hooks are preserved even with a sole known owner", async () => {
  const fixture = await selfHealingFixture();
  const state = await githubWebhook.register(fixture.context, registrationInput());
  await githubWebhook.unregister(fixture.context, { ...registrationInput(), state });
  assert.equal(
    fixture.calls.some(({ method }) => method === "DELETE"),
    false,
  );
});

test("shared created hook skips deletion until its last proven owner unregisters", async () => {
  const fixture = await selfHealingFixture({ hooks: [] });
  const state = await githubWebhook.register(fixture.context, registrationInput());
  // A second same-target registration uses a distinct durable migration record.
  const other = registrationInput({
    subscriptionId: "whk_test-shared-owner",
    config: withRegistration({ hookId: state.hookId, migrationRecordId: "shared-record" }),
  });
  assert.deepEqual(await githubWebhook.register(fixture.context, other), state);
  await githubWebhook.unregister(fixture.context, { ...registrationInput(), state });
  assert.equal(
    fixture.calls.some(({ method }) => method === "DELETE"),
    false,
  );
  await githubWebhook.unregister(fixture.context, { ...other, state });
  assert.equal(fixture.calls.filter(({ method }) => method === "DELETE").length, 1);
});

test("shared owner references use repository ID across case aliases", async () => {
  const fixture = await selfHealingFixture({ hooks: [] });
  const firstState = await githubWebhook.register(fixture.context, registrationInput());
  const alias = "Example-Owner/Example-Repository";
  fixture.setRepoFullName(alias);
  const baseConfig = replacementConfig();
  const secondConfig = replacementConfig({
    repositories: [{ fullName: alias, id: targetRepository.id }],
    registration: {
      ...baseConfig.registration,
      repository: alias,
      hookId: firstState.hookId,
      migrationRecordId: "case-alias-record",
    },
  });
  const secondInput = registrationInput({
    subscriptionId: "whk_test-case-alias",
    config: secondConfig,
  });
  const secondState = await githubWebhook.register(fixture.context, secondInput);

  await githubWebhook.unregister(fixture.context, {
    ...registrationInput(),
    state: firstState,
  });
  assert.equal(
    fixture.calls.some(({ method }) => method === "DELETE"),
    false,
  );
  await githubWebhook.unregister(fixture.context, { ...secondInput, state: secondState });
  assert.equal(fixture.calls.filter(({ method }) => method === "DELETE").length, 1);
});

test("another account cannot race an unresolved hook mutation or delete its reference", async () => {
  const fixture = await selfHealingFixture({ duplicateReadback: true });
  await registrationOutcome(fixture.context, registrationInput());
  const other = registrationInput({
    subscriptionId: "whk_test-other",
    account: { ...registrationInput().account, id: "another-account" },
    config: withRegistration({
      sourceAccountId: "another-account",
      migrationRecordId: "other-record",
    }),
  });
  assert.ok((await registrationOutcome(fixture.context, other)).error);
  await assert.rejects(
    githubWebhook.unregister(fixture.context, {
      ...registrationInput(),
      state: { hookId: approvedHookId },
    }),
    /cleanup_blocked/,
  );
  assert.equal(fixture.calls.filter(({ method }) => method === "PATCH").length, 1);
  assert.equal(
    fixture.calls.some(({ method }) => method === "DELETE"),
    false,
  );
});

test("configuration preflight distinguishes flat migration config and nested fields without values", () => {
  assert.deepEqual(diagnoseRegistrationConfiguration(replacementConfig()), {
    code: "configuration_valid",
    field: null,
  });
  assert.deepEqual(
    diagnoseRegistrationConfiguration({
      ...replacementConfig(),
      registration: undefined,
      ...replacementConfig().registration,
    }),
    { code: "invalid_configuration", field: "registration" },
  );
  assert.deepEqual(
    diagnoseRegistrationConfiguration(withRegistration({ fromCallbackUrl: fixtureSecret })),
    { code: "invalid_configuration", field: "registration.fromCallbackUrl" },
  );
  assert.deepEqual(diagnoseRegistrationConfiguration(withRegistration({ hookId: 0 })), {
    code: "invalid_configuration",
    field: "registration.hookId",
  });
});

test("invalid input, hashing and SQL claim errors have distinct sanitized detail", async () => {
  const fixture = await selfHealingFixture();
  await registrationOutcome(fixture.context, registrationInput({ secret: "" }));
  assert.deepEqual(readRegistrationDetail(fixture.context.sql, diagnosticReservationId), {
    code: "invalid_input",
    field: "input",
  });
  const originalDigest = crypto.subtle.digest;
  crypto.subtle.digest = async () => {
    throw new Error(fixtureSecret);
  };
  try {
    await registrationOutcome(fixture.context, registrationInput());
    assert.deepEqual(readRegistrationDetail(fixture.context.sql, diagnosticReservationId), {
      code: "identity_hash_failed",
      field: "identity",
    });
  } finally {
    crypto.subtle.digest = originalDigest;
  }
  const originalTransaction = fixture.context.sql.transaction;
  fixture.context.sql.transaction = () => {
    throw new Error(fixtureSecret);
  };
  await registrationOutcome(fixture.context, registrationInput());
  fixture.context.sql.transaction = originalTransaction;
  assert.deepEqual(readRegistrationDetail(fixture.context.sql, diagnosticReservationId), {
    code: "claim_failed",
    field: "storage",
  });
  assert.equal(fixture.calls.length, 0);
});

test("orphan cleanup is retry-idempotent and a retired registration cannot revive it", async () => {
  const fixture = await selfHealingFixture({ hooks: [] });
  const state = await githubWebhook.register(fixture.context, registrationInput());
  await githubWebhook.unregister(fixture.context, { ...registrationInput(), state });
  await githubWebhook.unregister(fixture.context, { ...registrationInput(), state });
  assert.equal(fixture.calls.filter(({ method }) => method === "DELETE").length, 1);
  assert.ok((await registrationOutcome(fixture.context, registrationInput())).error);
});

test("permanently preserved incident hook is never deleted even with creation provenance", async () => {
  const fixture = await selfHealingFixture();
  fixture.context.sql.exec(
    `INSERT INTO github_hook_owners
    (resource, hook_id, subscription_id, callback_hash, secret_fingerprint, created_here)
    VALUES (?, ?, ?, '', '', 1)`,
    `github-repository:${targetRepository.id}`,
    700112653,
    replacementSubscriptionId,
  );
  await githubWebhook.unregister(fixture.context, {
    ...registrationInput(),
    state: { hookId: 700112653 },
  });
  assert.equal(fixture.calls.length, 0);
});

test("registration details are read-only and refuse unrecognized stored values", () => {
  let calls = 0;
  const result = readRegistrationDetail(
    {
      exec(statement) {
        calls += 1;
        assert.equal(statement, "SELECT code, field FROM github_hook_details WHERE record_id = ?");
        return { toArray: () => [{ code: fixtureSecret, field: replacementCallbackUrl }] };
      },
    },
    "record",
  );
  assert.deepEqual(result, { code: "diagnostic_unavailable", field: null });
  assert.equal(calls, 1);
});
