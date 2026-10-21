-- A hook lock expires until its holder pins it immediately before a GitHub mutation.
-- Legacy locks start pinned and are released only when no mutation can be unresolved:
-- every registration is provably preflight or complete, and the repository has no
-- created hook that cleanup could have been deleting.
ALTER TABLE github_hook_locks ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 9007199254740991;

UPDATE github_hook_locks SET lease_until = 0
WHERE NOT EXISTS (
    SELECT 1 FROM github_hook_registrations
    WHERE lease_token IS NOT NULL
      AND lease_token NOT LIKE '{"version":1,"phase":"preflight",%'
      AND lease_token NOT LIKE '{"version":1,"phase":"complete",%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM github_hook_owners
    WHERE github_hook_owners.resource = github_hook_locks.resource
      AND released = 0 AND created_here = 1
  );
