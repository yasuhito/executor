import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const deliveryId = "11111111-2222-4333-8444-555555555555";
const headSha = "0123456789abcdef0123456789abcdef01234567";
const baseSha = "89abcdef0123456789abcdef0123456789abcdef";

async function migration(name) {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

test("already-applied migrations match their immutable deployed hashes", async () => {
  const expectedHashes = [
    [
      "0001_webhook_receipts.sql",
      "50f30001e36f735b5d0b0f9c09764ff2c1299dcab88bac02b73ed5aeeea9913b",
    ],
    [
      "0002_dependabot_review_queue.sql",
      "5f800ff12dba6c7af4b44db86b2e8d096e8e5fc6bf19fa3f026173fdc30da820",
    ],
    [
      "0003_url_only_review_telegram_pending.sql",
      "d83916af27bbf42fe8079b01362306cc64a803d39298cc7ed9519d22fda170ff",
    ],
  ];

  for (const [name, expectedHash] of expectedHashes) {
    const hash = createHash("sha256")
      .update(await migration(name))
      .digest("hex");
    assert.equal(hash, expectedHash, `${name} is an applied migration and must remain unchanged`);
  }
});

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

  database
    .prepare(`INSERT INTO webhook_receipts
    (delivery_id, event, action, repository, pull_request_number, head_sha, event_base_sha, pull_request_url, received_at, ping)
    VALUES (?, 'pull_request', 'opened', 'qniapp/qni-webgpu', 42, ?, ?, ?, 1, 0)`)
    .run(deliveryId, headSha, baseSha, `https://github.com/qniapp/qni-webgpu/pull/42`);
  database
    .prepare(`INSERT INTO review_queue
    (delivery_id, repository, pull_request_number, event_head_sha, state, received_at, updated_at, event_base_sha)
    VALUES (?, 'qniapp/qni-webgpu', 42, ?, 'queued', 1, 1, ?)`)
    .run(deliveryId, headSha, baseSha);
  database
    .prepare(`INSERT INTO repository_locks
    (repository, run_id, lease_until, fencing, job_delivery_id)
    VALUES ('qniapp/qni-webgpu', 'run-fixture', 100, 1, NULL)`)
    .run();
  database
    .prepare(`INSERT INTO notification_outbox
    (notification_id, dedupe_key, repository, pull_request_number, head_sha, kind, message, status, next_attempt_at, created_at, updated_at)
    VALUES (?, 'fixture-dedupe-key', 'qniapp/qni-webgpu', 42, ?, 'needs-attention', 'safe fixture', 'queued', 1, 1, 1)`)
    .run("a".repeat(64), headSha);

  database.exec(await migration("0004_multi_repository_config.sql"));

  const preserved = {
    receipt: {
      ...database
        .prepare("SELECT repository, event_base_sha FROM webhook_receipts WHERE delivery_id = ?")
        .get(deliveryId),
    },
    queue: {
      ...database
        .prepare("SELECT repository, state, event_base_sha FROM review_queue WHERE delivery_id = ?")
        .get(deliveryId),
    },
    lock: {
      ...database
        .prepare("SELECT repository, run_id, fencing FROM repository_locks WHERE run_id = ?")
        .get("run-fixture"),
    },
    notification: {
      ...database
        .prepare("SELECT repository, status, message FROM notification_outbox WHERE dedupe_key = ?")
        .get("fixture-dedupe-key"),
    },
  };
  const schema = database
    .prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name IN ('webhook_receipts', 'review_queue', 'repository_locks', 'notification_outbox')`)
    .all();

  database
    .prepare(`INSERT INTO webhook_receipts
    (delivery_id, event, action, repository, pull_request_number, head_sha, event_base_sha, pull_request_url, received_at, ping)
    VALUES (?, 'pull_request', 'opened', 'another-owner/another-repository', 7, ?, ?, ?, 2, 0)`)
    .run(
      "22222222-3333-4444-8555-666666666666",
      headSha,
      baseSha,
      "https://github.com/another-owner/another-repository/pull/7",
    );

  assert.deepEqual(preserved, {
    receipt: { repository: "qniapp/qni-webgpu", event_base_sha: baseSha },
    queue: {
      repository: "qniapp/qni-webgpu",
      state: "queued",
      event_base_sha: baseSha,
    },
    lock: { repository: "qniapp/qni-webgpu", run_id: "run-fixture", fencing: 1 },
    notification: {
      repository: "qniapp/qni-webgpu",
      status: "queued",
      message: "safe fixture",
    },
  });
  assert.equal(schema.length, 4);
  assert.ok(schema.every(({ sql }) => !/CHECK\s*\(\s*repository\s*=/i.test(sql)));
  assert.equal(
    database
      .prepare("SELECT repository FROM webhook_receipts WHERE delivery_id = ?")
      .get("22222222-3333-4444-8555-666666666666").repository,
    "another-owner/another-repository",
  );
});

test("dry-run migration defaults existing configurations to safe and stores explicit mode", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0001_webhook_receipts.sql",
    "0002_dependabot_review_queue.sql",
    "0003_url_only_review_telegram_pending.sql",
    "0004_multi_repository_config.sql",
  ]) {
    database.exec(await migration(name));
  }
  database
    .prepare(`INSERT INTO configured_repositories
      (subscription_id, full_name, repository_id, review_worker_url)
      VALUES ('existing', 'example-owner/example-repository', 123456789, 'https://review.example')`)
    .run();

  database.exec(await migration("0005_dry_run_mode.sql"));
  database
    .prepare(`INSERT INTO configured_repositories
      (subscription_id, full_name, repository_id, review_worker_url, dry_run)
      VALUES ('merge-disabled-later', 'another-owner/another-repository', 987654321, 'https://review.example', 0)`)
    .run();

  assert.deepEqual(
    database
      .prepare(
        "SELECT subscription_id, dry_run FROM configured_repositories ORDER BY subscription_id",
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { subscription_id: "existing", dry_run: 1 },
      { subscription_id: "merge-disabled-later", dry_run: 0 },
    ],
  );
  assert.throws(() =>
    database
      .prepare(`INSERT INTO configured_repositories
        (subscription_id, full_name, repository_id, review_worker_url, dry_run)
        VALUES ('invalid', 'third-owner/third-repository', 333333333, 'https://review.example', 2)`)
      .run(),
  );
});

test("guarded registration migration preserves legacy registrations and adds independent ownership", async () => {
  const database = new DatabaseSync(":memory:");
  for (const name of [
    "0001_webhook_receipts.sql",
    "0002_dependabot_review_queue.sql",
    "0003_url_only_review_telegram_pending.sql",
    "0004_multi_repository_config.sql",
    "0005_dry_run_mode.sql",
  ])
    database.exec(await migration(name));
  database.exec(
    "INSERT INTO github_hook_registrations (subscription_id, hook_id) VALUES ('legacy', 42)",
  );
  database.exec(await migration("0006_guarded_hook_ownership.sql"));
  assert.equal(database.prepare("SELECT hook_id FROM github_hook_registrations").get().hook_id, 42);
  assert.equal(database.prepare("SELECT count(*) AS count FROM github_hook_owners").get().count, 0);
  database.close();
});
