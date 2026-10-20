import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const deliveryId = "11111111-2222-4333-8444-555555555555";
const headSha = "0123456789abcdef0123456789abcdef01234567";
const baseSha = "89abcdef0123456789abcdef0123456789abcdef";

async function migration(name) {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

test("multi-repository migration preserves queued work and removes repository-specific schema constraints", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0001_webhook_receipts.sql",
    "0002_dependabot_review_queue.sql",
    "0003_url_only_review_telegram_pending.sql",
  ]) {
    database.exec(await migration(name));
  }

  database.prepare(`INSERT INTO webhook_receipts
    (delivery_id, event, action, repository, pull_request_number, head_sha, event_base_sha, pull_request_url, received_at, ping)
    VALUES (?, 'pull_request', 'opened', 'example-owner/example-repository', 42, ?, ?, ?, 1, 0)`)
    .run(deliveryId, headSha, baseSha, `https://github.com/example-owner/example-repository/pull/42`);
  database.prepare(`INSERT INTO review_queue
    (delivery_id, repository, pull_request_number, event_head_sha, state, received_at, updated_at, event_base_sha)
    VALUES (?, 'example-owner/example-repository', 42, ?, 'queued', 1, 1, ?)`)
    .run(deliveryId, headSha, baseSha);
  database.prepare(`INSERT INTO repository_locks
    (repository, run_id, lease_until, fencing, job_delivery_id)
    VALUES ('example-owner/example-repository', 'run-fixture', 100, 1, NULL)`).run();
  database.prepare(`INSERT INTO notification_outbox
    (notification_id, dedupe_key, repository, pull_request_number, head_sha, kind, message, status, next_attempt_at, created_at, updated_at)
    VALUES (?, 'fixture-dedupe-key', 'example-owner/example-repository', 42, ?, 'needs-attention', 'safe fixture', 'queued', 1, 1, 1)`)
    .run("a".repeat(64), headSha);

  database.exec(await migration("0004_multi_repository_config.sql"));

  const preserved = {
    receipt: { ...database.prepare("SELECT repository, event_base_sha FROM webhook_receipts WHERE delivery_id = ?").get(deliveryId) },
    queue: { ...database.prepare("SELECT repository, state, event_base_sha FROM review_queue WHERE delivery_id = ?").get(deliveryId) },
    lock: { ...database.prepare("SELECT repository, run_id, fencing FROM repository_locks WHERE run_id = ?").get("run-fixture") },
    notification: { ...database.prepare("SELECT repository, status, message FROM notification_outbox WHERE dedupe_key = ?").get("fixture-dedupe-key") },
  };
  const schema = database.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name IN ('webhook_receipts', 'review_queue', 'repository_locks', 'notification_outbox')`)
    .all();

  database.prepare(`INSERT INTO webhook_receipts
    (delivery_id, event, action, repository, pull_request_number, head_sha, event_base_sha, pull_request_url, received_at, ping)
    VALUES (?, 'pull_request', 'opened', 'another-owner/another-repository', 7, ?, ?, ?, 2, 0)`)
    .run("22222222-3333-4444-8555-666666666666", headSha, baseSha, "https://github.com/another-owner/another-repository/pull/7");

  assert.deepEqual(preserved, {
    receipt: { repository: "example-owner/example-repository", event_base_sha: baseSha },
    queue: { repository: "example-owner/example-repository", state: "queued", event_base_sha: baseSha },
    lock: { repository: "example-owner/example-repository", run_id: "run-fixture", fencing: 1 },
    notification: { repository: "example-owner/example-repository", status: "queued", message: "safe fixture" },
  });
  assert.equal(schema.length, 4);
  assert.ok(schema.every(({ sql }) => !/CHECK\s*\(\s*repository\s*=/i.test(sql)));
  assert.equal(database.prepare("SELECT repository FROM webhook_receipts WHERE delivery_id = ?").get("22222222-3333-4444-8555-666666666666").repository, "another-owner/another-repository");
});
