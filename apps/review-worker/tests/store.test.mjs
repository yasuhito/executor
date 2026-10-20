import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalSnapshot, sha256Hex } from "../src/core.ts";
import { createReviewSchema, DurableReviewStore } from "../src/store.ts";

const identity = {
  repository: "example-owner/example-repository",
  pullRequest: 42,
  headSha: "0123456789abcdef0123456789abcdef01234567",
  testedBaseSha: "89abcdef0123456789abcdef0123456789abcdef",
};
const snapshot = {
  identity,
  title: "Bump example from 1.0.0 to 1.0.1",
  commitMessages: ["Bump example from 1.0.0 to 1.0.1"],
  files: [{ path: "Cargo.toml", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }],
  contextFiles: [{ path: "AGENTS.md", content: "Repository instructions" }],
};

async function snapshotHash(value) {
  return sha256Hex(canonicalSnapshot(value));
}

class SqliteAdapter {
  database = new DatabaseSync(":memory:");
  tail = Promise.resolve();

  async exec(query) {
    this.database.exec(query);
  }

  async get(query, ...bindings) {
    const rows = this.database.prepare(query).all(...bindings);
    return rows[0];
  }

  async run(query, ...bindings) {
    this.database.prepare(query).run(...bindings);
  }

  async transaction(work) {
    let unlock;
    const previous = this.tail;
    this.tail = new Promise((resolve) => { unlock = resolve; });
    await previous;
    this.database.exec("BEGIN IMMEDIATE");
    const database = this.database;
    const executor = {
      async exec(query) { database.exec(query); },
      async get(query, ...bindings) { return database.prepare(query).all(...bindings)[0]; },
      async run(query, ...bindings) { database.prepare(query).run(...bindings); },
    };
    try {
      const result = await work(executor);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      unlock();
    }
  }
}

async function makeStore() {
  const database = new SqliteAdapter();
  await createReviewSchema(database);
  return { database, store: new DurableReviewStore(database) };
}

test("SQLite rejects a concurrently replayed authenticated request nonce", async () => {
  const { store } = await makeStore();
  const nonce = "550e8400-e29b-41d4-a716-446655440000";
  const accepted = await Promise.all([
    store.acceptNonce(nonce, 1_000),
    store.acceptNonce(nonce, 1_000),
  ]);

  assert.deepEqual(accepted.sort(), [false, true]);
});

test("SQLite prunes request nonces only after their authentication window closes", async () => {
  const { store } = await makeStore();
  const nonce = "550e8400-e29b-41d4-a716-446655440000";
  await store.acceptNonce(nonce, 1_000);
  const acceptedAfterWindow = await store.acceptNonce(nonce, 601_001);

  assert.equal(acceptedAfterWindow, true);
});

test("SQLite reservation deduplicates concurrent requests for one immutable identity", async () => {
  const { store } = await makeStore();
  const hash = await snapshotHash(snapshot);
  const reservations = await Promise.all([
    store.reserve(identity, hash, snapshot),
    store.reserve(identity, hash, snapshot),
  ]);

  assert.deepEqual(reservations.sort(), ["created", "existing"]);
});

test("SQLite restores only a snapshot that matches its persisted identity and hash", async () => {
  const { store } = await makeStore();
  const hash = await snapshotHash(snapshot);
  await store.reserve(identity, hash, snapshot);
  const restored = await store.getSnapshot(identity, hash);

  assert.deepEqual(restored, snapshot);
});

test("SQLite rejects a second snapshot for the same repository PR head and tested base", async () => {
  const { store } = await makeStore();
  const hash = await snapshotHash(snapshot);
  const altered = { ...snapshot, files: [{ ...snapshot.files[0], patch: "altered" }] };
  await store.reserve(identity, hash, snapshot);
  const reservation = await store.reserve(identity, await snapshotHash(altered), altered);

  assert.equal(reservation, "conflict");
});

test("an invalidated SQLite result remains stale and cannot be completed", async () => {
  const { store } = await makeStore();
  const hash = await snapshotHash(snapshot);
  await store.reserve(identity, hash, snapshot);
  await store.invalidate(identity, hash);
  await store.complete(identity, hash, {
    decision: "reviewable",
    standards: { status: "pass", findings: [] },
    changeIntent: { status: "pass", findings: [] },
  });
  const row = await store.get(identity);

  assert.deepEqual({ state: row.state, verdict: row.verdict, failureCode: row.failureCode }, { state: "stale", verdict: undefined, failureCode: "identity_changed" });
});
