-- Locks intentionally have no timeout: an interrupted external mutation needs operator recovery.
CREATE TABLE github_hook_locks (
  resource TEXT PRIMARY KEY,
  token TEXT NOT NULL
);
CREATE TABLE github_hook_owners (
  resource TEXT NOT NULL,
  hook_id INTEGER NOT NULL,
  subscription_id TEXT NOT NULL,
  callback_hash TEXT NOT NULL,
  secret_fingerprint TEXT NOT NULL,
  created_here INTEGER NOT NULL DEFAULT 0,
  released INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (resource, subscription_id)
);
CREATE TABLE github_hook_details (
  record_id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  field TEXT NOT NULL
);
