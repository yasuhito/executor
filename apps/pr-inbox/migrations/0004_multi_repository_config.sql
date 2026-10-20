CREATE TABLE webhook_receipts_rebuilt (
  delivery_id TEXT PRIMARY KEY NOT NULL CHECK (length(delivery_id) = 36),
  event TEXT NOT NULL CHECK (event IN ('ping', 'pull_request')),
  action TEXT,
  repository TEXT NOT NULL,
  pull_request_number INTEGER,
  head_sha TEXT,
  event_base_sha TEXT CHECK (event_base_sha IS NULL OR length(event_base_sha) = 40),
  pull_request_url TEXT,
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  ping INTEGER NOT NULL CHECK (ping IN (0, 1)),
  CHECK (
    (event = 'ping' AND action IS NULL AND pull_request_number IS NULL AND head_sha IS NULL AND event_base_sha IS NULL AND pull_request_url IS NULL AND ping = 1)
    OR
    (event = 'pull_request' AND action IN ('opened', 'reopened', 'synchronize') AND pull_request_number IS NOT NULL AND pull_request_number > 0 AND head_sha IS NOT NULL AND length(head_sha) = 40 AND pull_request_url IS NOT NULL AND ping = 0)
  )
);

INSERT INTO webhook_receipts_rebuilt
SELECT delivery_id, event, action, repository, pull_request_number, head_sha, event_base_sha, pull_request_url, received_at, ping
FROM webhook_receipts;

CREATE TABLE review_queue_rebuilt (
  delivery_id TEXT PRIMARY KEY NOT NULL REFERENCES webhook_receipts_rebuilt(delivery_id),
  repository TEXT NOT NULL,
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
  event_base_sha TEXT CHECK (event_base_sha IS NULL OR length(event_base_sha) = 40),
  CHECK (
    (state = 'processing' AND run_id IS NOT NULL AND fencing IS NOT NULL AND lease_until IS NOT NULL)
    OR
    (state <> 'processing' AND run_id IS NULL AND fencing IS NULL AND lease_until IS NULL)
  )
);

INSERT INTO review_queue_rebuilt
SELECT delivery_id, repository, pull_request_number, event_head_sha, state, run_id, fencing, lease_until, attempts,
       tested_base_sha, snapshot_hash, review_decision, outcome_kind, failure_code, received_at, updated_at, event_base_sha
FROM review_queue;

CREATE TABLE repository_locks_rebuilt (
  repository TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  lease_until INTEGER NOT NULL CHECK (lease_until >= 0),
  fencing INTEGER NOT NULL CHECK (fencing > 0),
  job_delivery_id TEXT REFERENCES review_queue_rebuilt(delivery_id)
);

INSERT INTO repository_locks_rebuilt
SELECT repository, run_id, lease_until, fencing, job_delivery_id FROM repository_locks;

CREATE TABLE notification_outbox_rebuilt (
  notification_id TEXT PRIMARY KEY NOT NULL CHECK (length(notification_id) = 64),
  dedupe_key TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL,
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

INSERT INTO notification_outbox_rebuilt
SELECT notification_id, dedupe_key, repository, pull_request_number, head_sha, tested_base_sha, kind, message, status,
       failure_code, attempts, next_attempt_at, send_run_id, send_fencing, created_at, updated_at
FROM notification_outbox;

DROP TABLE repository_locks;
DROP TABLE notification_outbox;
DROP TABLE review_queue;
DROP TABLE webhook_receipts;

ALTER TABLE webhook_receipts_rebuilt RENAME TO webhook_receipts;
ALTER TABLE review_queue_rebuilt RENAME TO review_queue;
ALTER TABLE repository_locks_rebuilt RENAME TO repository_locks;
ALTER TABLE notification_outbox_rebuilt RENAME TO notification_outbox;

CREATE INDEX webhook_receipts_recent ON webhook_receipts(received_at DESC, delivery_id);
CREATE INDEX review_queue_pending ON review_queue(state, received_at, delivery_id);
CREATE UNIQUE INDEX review_queue_pr_head_base
  ON review_queue(repository, pull_request_number, event_head_sha, event_base_sha)
  WHERE event_base_sha IS NOT NULL AND state = 'queued';
CREATE INDEX notification_outbox_pending ON notification_outbox(repository, status, next_attempt_at);

CREATE TABLE configured_repositories (
  subscription_id TEXT NOT NULL CHECK (length(subscription_id) BETWEEN 1 AND 128),
  full_name TEXT NOT NULL,
  repository_id INTEGER NOT NULL CHECK (repository_id > 0),
  review_worker_url TEXT NOT NULL,
  PRIMARY KEY (subscription_id, full_name)
);

CREATE INDEX configured_repositories_lookup ON configured_repositories(full_name);
