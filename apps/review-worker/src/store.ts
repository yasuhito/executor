import {
  canonicalSnapshot,
  parseReviewSnapshot,
  sha256Hex,
  type ReviewIdentity,
  type ReviewSnapshot,
  type ReviewStore,
  type ReviewVerdict,
  type StoredReview,
} from "./core.ts";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";

interface ReviewRow {
  identity_key: string;
  identity_json: string;
  snapshot_hash: string;
  state: "pending" | "complete" | "stale";
  verdict_json: string | null;
  failure_code: string | null;
}

function identityKey(identity: ReviewIdentity): string {
  return `${identity.repository}#${identity.pullRequest}:${identity.headSha}:${identity.testedBaseSha}`;
}

function decodeRow(row: ReviewRow): StoredReview {
  let identity: ReviewIdentity;
  try {
    identity = JSON.parse(row.identity_json) as ReviewIdentity;
  } catch {
    throw new Error("Review identity storage is unreadable.");
  }
  let verdict: ReviewVerdict | undefined;
  if (row.verdict_json !== null) {
    try {
      verdict = JSON.parse(row.verdict_json) as ReviewVerdict;
    } catch {
      return {
        identity,
        snapshotHash: row.snapshot_hash,
        state: "complete",
        failureCode: "stored_result_unreadable",
      };
    }
  }
  return {
    identity,
    snapshotHash: row.snapshot_hash,
    state: row.state,
    ...(verdict === undefined ? {} : { verdict }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
  };
}

const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const nonceRetentionMs = 10 * 60 * 1_000;

export type ReviewRequestState = "awaiting_ci" | "pending" | "complete" | "stale";

export interface ReviewRequest {
  reviewId: string;
  operationId: string;
  pullRequestUrl: string;
  pullRequestNumber: number;
  headSha: string | null;
  baseSha: string | null;
  title: string | null;
  state: ReviewRequestState;
  snapshotHash: string | null;
  failureCode: string | null;
}

interface ReviewRequestRow {
  review_id: string;
  operation_id: string;
  pull_request_url: string;
  pull_request_number: number;
  head_sha: string | null;
  base_sha: string | null;
  title: string | null;
  state: ReviewRequestState;
  snapshot_hash: string | null;
  failure_code: string | null;
}

function decodeRequest(row: ReviewRequestRow): ReviewRequest {
  return {
    reviewId: row.review_id,
    operationId: row.operation_id,
    pullRequestUrl: row.pull_request_url,
    pullRequestNumber: row.pull_request_number,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    title: row.title,
    state: row.state,
    snapshotHash: row.snapshot_hash,
    failureCode: row.failure_code,
  };
}

export class DurableReviewStore implements ReviewStore {
  private readonly database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.database = database;
  }

  async acceptNonce(nonce: string, acceptedAt: number): Promise<boolean> {
    if (!noncePattern.test(nonce) || !Number.isSafeInteger(acceptedAt)) return false;
    return this.database.transaction(async (transaction) => {
      await transaction.run(
        "DELETE FROM review_request_nonces WHERE accepted_at < ?",
        acceptedAt - nonceRetentionMs,
      );
      await transaction.run(
        "INSERT OR IGNORE INTO review_request_nonces (nonce, accepted_at) VALUES (?, ?)",
        nonce,
        acceptedAt,
      );
      const changes = await transaction.get<{ changes: number }>("SELECT changes() AS changes");
      return changes?.changes === 1;
    });
  }

  async reserve(
    identity: ReviewIdentity,
    snapshotHash: string,
    snapshot: ReviewSnapshot,
  ): Promise<"created" | "existing" | "conflict" | "stale"> {
    return this.database.transaction(async (transaction) => {
      const existing = await transaction.get<ReviewRow>(
        "SELECT identity_key, identity_json, snapshot_hash, state, verdict_json, failure_code FROM review_jobs WHERE singleton = 1",
      );
      const key = identityKey(identity);
      if (existing === undefined) {
        await transaction.run(
          `INSERT INTO review_jobs (singleton, identity_key, identity_json, snapshot_hash, snapshot_json, state, verdict_json, failure_code, updated_at)
           VALUES (1, ?, ?, ?, ?, 'pending', NULL, NULL, ?)`,
          key,
          JSON.stringify(identity),
          snapshotHash,
          JSON.stringify(snapshot),
          Date.now(),
        );
        return "created";
      }
      if (existing.identity_key !== key || existing.snapshot_hash !== snapshotHash)
        return "conflict";
      return existing.state === "stale" ? "stale" : "existing";
    });
  }

  async get(identity: ReviewIdentity): Promise<StoredReview | undefined> {
    const row = await this.database.get<ReviewRow>(
      "SELECT identity_key, identity_json, snapshot_hash, state, verdict_json, failure_code FROM review_jobs WHERE singleton = 1 AND identity_key = ?",
      identityKey(identity),
    );
    return row === undefined ? undefined : decodeRow(row);
  }

  async getSnapshot(
    identity: ReviewIdentity,
    snapshotHash: string,
  ): Promise<ReviewSnapshot | undefined> {
    const row = await this.database.get<{ snapshot_json: string }>(
      "SELECT snapshot_json FROM review_jobs WHERE singleton = 1 AND identity_key = ? AND snapshot_hash = ?",
      identityKey(identity),
      snapshotHash,
    );
    if (row === undefined) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(row.snapshot_json);
    } catch {
      return undefined;
    }
    const snapshot = parseReviewSnapshot(value);
    if (
      snapshot === null ||
      snapshot.identity.repository !== identity.repository ||
      snapshot.identity.pullRequest !== identity.pullRequest ||
      snapshot.identity.headSha !== identity.headSha ||
      snapshot.identity.testedBaseSha !== identity.testedBaseSha ||
      (await sha256Hex(canonicalSnapshot(snapshot))) !== snapshotHash
    )
      return undefined;
    return snapshot;
  }

  async complete(
    identity: ReviewIdentity,
    snapshotHash: string,
    verdict: ReviewVerdict,
  ): Promise<void> {
    await this.database.run(
      `UPDATE review_jobs SET state = 'complete', verdict_json = ?, failure_code = NULL, updated_at = ?
       WHERE singleton = 1 AND identity_key = ? AND snapshot_hash = ? AND state = 'pending'`,
      JSON.stringify(verdict),
      Date.now(),
      identityKey(identity),
      snapshotHash,
    );
  }

  async fail(identity: ReviewIdentity, snapshotHash: string, failureCode: string): Promise<void> {
    await this.database.run(
      `UPDATE review_jobs SET state = 'complete', verdict_json = NULL, failure_code = ?, updated_at = ?
       WHERE singleton = 1 AND identity_key = ? AND snapshot_hash = ? AND state = 'pending'`,
      failureCode,
      Date.now(),
      identityKey(identity),
      snapshotHash,
    );
  }

  async invalidate(identity: ReviewIdentity, snapshotHash: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      await transaction.run(
        `UPDATE review_jobs SET state = 'stale', verdict_json = NULL, failure_code = 'identity_changed', updated_at = ?
         WHERE singleton = 1 AND identity_key = ? AND snapshot_hash = ?`,
        Date.now(),
        identityKey(identity),
        snapshotHash,
      );
      const row = await transaction.get<ReviewRow>(
        "SELECT identity_key, identity_json, snapshot_hash, state, verdict_json, failure_code FROM review_jobs WHERE singleton = 1",
      );
      return (
        row?.identity_key === identityKey(identity) &&
        row.snapshot_hash === snapshotHash &&
        row.state === "stale"
      );
    });
  }
}

export class DurableReviewRequestStore {
  private readonly database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.database = database;
  }

  async get(reviewId: string): Promise<ReviewRequest | undefined> {
    const row = await this.database.get<ReviewRequestRow>(
      `SELECT review_id, operation_id, pull_request_url, pull_request_number, head_sha, base_sha, title, state, snapshot_hash, failure_code
       FROM review_request_jobs WHERE singleton = 1 AND review_id = ?`,
      reviewId,
    );
    return row === undefined ? undefined : decodeRequest(row);
  }

  async reserve(
    input: Omit<
      ReviewRequest,
      "headSha" | "baseSha" | "title" | "state" | "snapshotHash" | "failureCode"
    >,
  ): Promise<"created" | "existing" | "conflict"> {
    return this.database.transaction(async (transaction) => {
      const existing = await transaction.get<ReviewRequestRow>(
        `SELECT review_id, operation_id, pull_request_url, pull_request_number, head_sha, base_sha, title, state, snapshot_hash, failure_code
         FROM review_request_jobs WHERE singleton = 1`,
      );
      if (existing === undefined) {
        await transaction.run(
          `INSERT INTO review_request_jobs
            (singleton, review_id, operation_id, pull_request_url, pull_request_number, head_sha, base_sha, title, state, snapshot_hash, failure_code, updated_at)
           VALUES (1, ?, ?, ?, ?, NULL, NULL, NULL, 'awaiting_ci', NULL, NULL, ?)`,
          input.reviewId,
          input.operationId,
          input.pullRequestUrl,
          input.pullRequestNumber,
          Date.now(),
        );
        return "created";
      }
      if (
        existing.review_id !== input.reviewId ||
        existing.operation_id !== input.operationId ||
        existing.pull_request_url !== input.pullRequestUrl ||
        existing.pull_request_number !== input.pullRequestNumber
      )
        return "conflict";
      return "existing";
    });
  }

  async bindCandidate(
    reviewId: string,
    candidate: { headSha: string; baseSha: string; title: string },
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const row = await transaction.get<ReviewRequestRow>(
        `SELECT review_id, operation_id, pull_request_url, pull_request_number, head_sha, base_sha, title, state, snapshot_hash, failure_code
         FROM review_request_jobs WHERE singleton = 1 AND review_id = ?`,
        reviewId,
      );
      if (row === undefined || row.state === "stale") return false;
      if (row.head_sha !== null) {
        const matches =
          row.head_sha === candidate.headSha &&
          row.base_sha === candidate.baseSha &&
          row.title === candidate.title;
        if (!matches) {
          await transaction.run(
            "UPDATE review_request_jobs SET state = 'stale', failure_code = 'pull_request_changed', updated_at = ? WHERE singleton = 1 AND review_id = ?",
            Date.now(),
            reviewId,
          );
        }
        return matches;
      }
      await transaction.run(
        `UPDATE review_request_jobs SET head_sha = ?, base_sha = ?, title = ?, updated_at = ?
         WHERE singleton = 1 AND review_id = ? AND head_sha IS NULL AND state = 'awaiting_ci'`,
        candidate.headSha,
        candidate.baseSha,
        candidate.title,
        Date.now(),
        reviewId,
      );
      const saved = await transaction.get<ReviewRequestRow>(
        `SELECT review_id, operation_id, pull_request_url, pull_request_number, head_sha, base_sha, title, state, snapshot_hash, failure_code
         FROM review_request_jobs WHERE singleton = 1 AND review_id = ?`,
        reviewId,
      );
      return (
        saved?.head_sha === candidate.headSha &&
        saved.base_sha === candidate.baseSha &&
        saved.title === candidate.title
      );
    });
  }

  async update(
    reviewId: string,
    update: {
      state: ReviewRequestState;
      snapshotHash?: string | null;
      failureCode?: string | null;
    },
  ): Promise<void> {
    await this.database.run(
      `UPDATE review_request_jobs SET state = ?, snapshot_hash = COALESCE(?, snapshot_hash), failure_code = ?, updated_at = ?
       WHERE singleton = 1 AND review_id = ?`,
      update.state,
      update.snapshotHash ?? null,
      update.failureCode ?? null,
      Date.now(),
      reviewId,
    );
  }
}

export async function createReviewSchema(database: SqliteExecutor): Promise<void> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS review_request_nonces (
      nonce TEXT PRIMARY KEY,
      accepted_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_request_jobs (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      review_id TEXT NOT NULL UNIQUE,
      operation_id TEXT NOT NULL,
      pull_request_url TEXT NOT NULL,
      pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
      head_sha TEXT,
      base_sha TEXT,
      title TEXT,
      state TEXT NOT NULL CHECK (state IN ('awaiting_ci', 'pending', 'complete', 'stale')),
      snapshot_hash TEXT,
      failure_code TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_jobs (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      identity_key TEXT NOT NULL,
      identity_json TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
      snapshot_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'stale')),
      verdict_json TEXT,
      failure_code TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
}
