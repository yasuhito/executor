CREATE TABLE webhook_receipts (
  delivery_id TEXT PRIMARY KEY NOT NULL CHECK (length(delivery_id) = 36),
  event TEXT NOT NULL CHECK (event IN ('ping', 'pull_request')),
  action TEXT,
  repository TEXT NOT NULL CHECK (repository = 'qniapp/qni-webgpu'),
  pull_request_number INTEGER,
  head_sha TEXT,
  pull_request_url TEXT,
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  ping INTEGER NOT NULL CHECK (ping IN (0, 1)),
  CHECK (
    (event = 'ping' AND action IS NULL AND pull_request_number IS NULL AND head_sha IS NULL AND pull_request_url IS NULL AND ping = 1)
    OR
    (event = 'pull_request' AND action IN ('opened', 'reopened', 'synchronize') AND pull_request_number IS NOT NULL AND pull_request_number > 0 AND head_sha IS NOT NULL AND length(head_sha) = 40 AND pull_request_url IS NOT NULL AND ping = 0)
  )
);

CREATE INDEX webhook_receipts_recent ON webhook_receipts(received_at DESC, delivery_id);

CREATE TABLE github_hook_registrations (
  subscription_id TEXT PRIMARY KEY NOT NULL CHECK (length(subscription_id) BETWEEN 1 AND 128),
  hook_id INTEGER CHECK (hook_id IS NULL OR hook_id > 0),
  lease_token TEXT,
  lease_until INTEGER,
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
