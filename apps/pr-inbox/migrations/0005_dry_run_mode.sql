ALTER TABLE configured_repositories
ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 1 CHECK (dry_run IN (0, 1));
