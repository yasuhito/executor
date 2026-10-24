-- A fixed reason and HTTP status show which preflight check stopped a registration.
ALTER TABLE github_hook_details ADD COLUMN reason TEXT;
ALTER TABLE github_hook_details ADD COLUMN http_status INTEGER;
ALTER TABLE github_hook_details ADD COLUMN recorded_at INTEGER;

-- Lock holders let a blocked registration name who holds the repository lock.
-- Older deployed versions can still take a lock without these columns, so a holder is
-- trusted only while holder_token still equals the lock token.
ALTER TABLE github_hook_locks ADD COLUMN holder TEXT;
ALTER TABLE github_hook_locks ADD COLUMN holder_token TEXT;
ALTER TABLE github_hook_locks ADD COLUMN operation TEXT;
ALTER TABLE github_hook_locks ADD COLUMN acquired_at INTEGER;
