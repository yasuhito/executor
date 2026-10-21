import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { processQueue } from "../processor.ts";
import { enqueueNotification } from "../queue-store.ts";

function run(operation, context, input) {
  const declaration = Object.getOwnPropertySymbols(operation)
    .map((key) => operation[key])
    .find((value) => typeof value?.run === "function");
  return Effect.runPromise(declaration.run(context, input));
}

async function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const name of [
    "0001_webhook_receipts.sql",
    "0002_dependabot_review_queue.sql",
    "0003_url_only_review_telegram_pending.sql",
    "0004_multi_repository_config.sql",
  ]) {
    db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const sql = {
    exec(statement, ...bindings) {
      const prepared = db.prepare(statement);
      if (prepared.columns().length) {
        const rows = prepared.all(...bindings);
        return { rowsWritten: 0, toArray: () => rows };
      }
      return { rowsWritten: Number(prepared.run(...bindings).changes), toArray: () => [] };
    },
    transaction(work) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = work(sql);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  sql.exec(
    `INSERT INTO configured_repositories
      (subscription_id, full_name, repository_id, review_worker_url)
     VALUES (?, ?, ?, ?)`,
    "test-subscription",
    "example-owner/example-repository",
    123456789,
    "https://review.example.invalid",
  );
  enqueueNotification(sql, {
    notificationId: "a".repeat(64),
    dedupeKey: "fixture",
    repository: "example-owner/example-repository",
    pullRequestNumber: 42,
    headSha: "a".repeat(40),
    testedBaseSha: null,
    kind: "needs-attention",
    message: "safe fixture",
    now: 1,
  });
  return sql;
}

test("idle workflow dispatches durable outbox under lock without exposing message in checkpoints", async () => {
  const sql = await fixture();
  let calls = 0;
  const sends = [];
  const checkpoints = [];
  const retryLimits = [];
  const context = {
    sql,
    signal: new AbortController().signal,
    app: {
      accounts: {
        telegram: { fields: { token: "fake-token-handle" } },
        telegramDestination: { fields: { chatId: "fake-chat-handle" } },
      },
    },
    fetch: async () => {
      calls++;
      sends.push({
        outboxStatus: sql.exec("SELECT status FROM notification_outbox").toArray()[0].status,
        leaseActive:
          sql.exec("SELECT lease_until FROM repository_locks").toArray()[0].lease_until >
          Date.now(),
      });
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
  };
  const workflow = {
    runId: "mock-run",
    step: {
      async runQuery(_name, operation, input) {
        return run(operation, context, input);
      },
      async runMutation(name, operation, input, options) {
        if (name.startsWith("dispatch-")) retryLimits.push(options.retries.limit);
        const result = await run(operation, context, input);
        checkpoints.push(result);
        return result;
      },
      async sleep() {
        throw new Error("unexpected sleep");
      },
      async do() {
        throw new Error("unexpected review work");
      },
    },
  };
  const result = await run(processQueue, workflow, {
    repository: "example-owner/example-repository",
  });
  const checkpointText = JSON.stringify(checkpoints);
  assert.deepEqual(
    {
      result,
      calls,
      sends,
      retryLimits,
      finalStatus: sql.exec("SELECT status FROM notification_outbox").toArray()[0].status,
      checkpointContainsMessage: checkpointText.includes("safe fixture"),
      checkpointContainsToken: checkpointText.includes("fake-token-handle"),
    },
    {
      result: { processed: 0 },
      calls: 1,
      sends: [{ outboxStatus: "sending", leaseActive: true }],
      retryLimits: [0, 0],
      finalStatus: "sent",
      checkpointContainsMessage: false,
      checkpointContainsToken: false,
    },
  );
});

test("workflow sends actionable results only after queue completion commits", async () => {
  const sql = await fixture();
  sql.exec("DELETE FROM notification_outbox");
  const deliveryId = "11111111-2222-4333-8444-555555555555";
  sql.exec(
    `INSERT INTO webhook_receipts
    (delivery_id, event, action, repository, pull_request_number, head_sha, pull_request_url, received_at, ping)
    VALUES (?, 'pull_request', 'opened', 'example-owner/example-repository', 42, ?, 'https://github.com/example-owner/example-repository/pull/42', 1, 0)`,
    deliveryId,
    "a".repeat(40),
  );
  sql.exec(
    `INSERT INTO review_queue
    (delivery_id, repository, pull_request_number, event_head_sha, state, received_at, updated_at)
    VALUES (?, 'example-owner/example-repository', 42, ?, 'queued', 1, 1)`,
    deliveryId,
    "a".repeat(40),
  );
  let calls = 0;
  const sends = [];
  const mutationContext = {
    sql,
    signal: new AbortController().signal,
    app: {
      accounts: {
        telegram: { fields: { token: "fake-token-handle" } },
        telegramDestination: { fields: { chatId: "fake-chat-handle" } },
      },
    },
    fetch: async (url, init) => {
      calls++;
      sends.push({
        queueState: sql.exec("SELECT state FROM review_queue").toArray()[0].state,
        jobDeliveryId: sql.exec("SELECT job_delivery_id FROM repository_locks").toArray()[0]
          .job_delivery_id,
        fixedHost: /^https:\/\/api.telegram.org\//.test(url),
        messageHasFailureCode: /Failure code: webhook_identity_unproven/.test(
          JSON.parse(init.body).text,
        ),
      });
      return Response.json({ ok: true, result: { message_id: 2 } });
    },
  };
  const result = await run(
    processQueue,
    {
      runId: "mock-run",
      step: {
        runQuery: (_name, operation, input) => run(operation, mutationContext, input),
        runMutation: (_name, operation, input) => run(operation, mutationContext, input),
        do: () => {
          throw new Error("invalid webhook identity must not trigger review or GitHub requests");
        },
        sleep: () => {
          throw new Error("unexpected sleep");
        },
      },
    },
    { repository: "example-owner/example-repository" },
  );
  assert.deepEqual(
    {
      result,
      calls,
      sends,
      finalStatus: sql.exec("SELECT status FROM notification_outbox").toArray()[0].status,
    },
    {
      result: { processed: 1 },
      calls: 1,
      sends: [
        {
          queueState: "needs-attention",
          jobDeliveryId: null,
          fixedHost: true,
          messageHasFailureCode: true,
        },
      ],
      finalStatus: "sent",
    },
  );
});
