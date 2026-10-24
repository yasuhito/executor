CREATE TABLE review_queue (
  delivery_id TEXT PRIMARY KEY NOT NULL REFERENCES webhook_receipts(delivery_id),
  repository TEXT NOT NULL CHECK (repository = 'qniapp/qni-webgpu'),
  pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
  event_head_sha TEXT NOT NULL CHECK (length(event_head_sha) = 40),
  state TEXT NOT NULL CHECK (state IN ('queued', 'processing', 'complete', 'needs-attention', 'stale')),
  run_id TEXT,
  fencing INTEGER,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  tested_base_sha TEXT CHECK (tested_base_sha IS NULL OR length(tested_base_sha) = 40),
  snapshot_hash TEXT CHECK (snapshot_hash IS NULL OR length(snapshot_hash) = 64),
  review_decision TEXT CHECK (review_decision IS NULL OR review_decision IN ('reviewable', 'needs-attention')),
  outcome_kind TEXT,
  failure_code TEXT,
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK (
    (state = 'processing' AND run_id IS NOT NULL AND fencing IS NOT NULL AND lease_until IS NOT NULL)
    OR
    (state <> 'processing' AND run_id IS NULL AND fencing IS NULL AND lease_until IS NULL)
  )
);

CREATE INDEX review_queue_pending ON review_queue(state, received_at, delivery_id);

CREATE TABLE repository_locks (
  repository TEXT PRIMARY KEY NOT NULL CHECK (repository = 'qniapp/qni-webgpu'),
  run_id TEXT NOT NULL,
  lease_until INTEGER NOT NULL CHECK (lease_until >= 0),
  fencing INTEGER NOT NULL CHECK (fencing > 0),
  job_delivery_id TEXT REFERENCES review_queue(delivery_id)
);

CREATE TABLE notification_outbox (
  notification_id TEXT PRIMARY KEY NOT NULL CHECK (length(notification_id) = 64),
  dedupe_key TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL CHECK (repository = 'qniapp/qni-webgpu'),
  pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
  head_sha TEXT NOT NULL CHECK (length(head_sha) = 40),
  tested_base_sha TEXT CHECK (tested_base_sha IS NULL OR length(tested_base_sha) = 40),
  kind TEXT NOT NULL CHECK (kind IN ('reviewable', 'needs-attention', 'ci-failed', 'stale', 'unproven', 'service-failed')),
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'ready', 'sent', 'failed')),
  draft_id TEXT,
  sent_message_id TEXT,
  sent_at INTEGER CHECK (sent_at IS NULL OR sent_at >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failure_code TEXT,
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK (
    (status = 'queued' AND draft_id IS NULL AND sent_message_id IS NULL AND sent_at IS NULL)
    OR (status = 'ready' AND draft_id IS NOT NULL AND sent_message_id IS NULL AND sent_at IS NULL)
    OR (status = 'sent' AND draft_id IS NOT NULL AND sent_message_id IS NOT NULL AND sent_at IS NOT NULL)
    OR status = 'failed'
  )
);

CREATE INDEX notification_outbox_pending ON notification_outbox(status, next_attempt_at, created_at, notification_id);
