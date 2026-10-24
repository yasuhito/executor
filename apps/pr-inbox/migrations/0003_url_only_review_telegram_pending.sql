ALTER TABLE webhook_receipts
  ADD COLUMN event_base_sha TEXT CHECK (event_base_sha IS NULL OR length(event_base_sha) = 40);

ALTER TABLE review_queue
  ADD COLUMN event_base_sha TEXT CHECK (event_base_sha IS NULL OR length(event_base_sha) = 40);

CREATE UNIQUE INDEX review_queue_pr_head_base
  ON review_queue(repository, pull_request_number, event_head_sha, event_base_sha)
  WHERE event_base_sha IS NOT NULL AND state = 'queued';

DROP INDEX IF EXISTS notification_outbox_pending;
DROP TABLE notification_outbox;

CREATE TABLE notification_outbox (
  notification_id TEXT PRIMARY KEY NOT NULL CHECK (length(notification_id) = 64),
  dedupe_key TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL CHECK (repository = 'qniapp/qni-webgpu'),
  pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
  head_sha TEXT NOT NULL CHECK (length(head_sha) = 40),
  tested_base_sha TEXT CHECK (tested_base_sha IS NULL OR length(tested_base_sha) = 40),
  kind TEXT NOT NULL CHECK (kind IN ('needs-attention', 'stale')),
  message TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'unknown')),
  failure_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  send_run_id TEXT,
  send_fencing INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

CREATE INDEX notification_outbox_pending ON notification_outbox(repository, status, next_attempt_at);
