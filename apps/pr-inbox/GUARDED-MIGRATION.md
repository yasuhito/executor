# Guarded registration migration - PAUSED

This patch is not authority to deploy, activate, reconcile, mutate GitHub, or
create/remove subscriptions. Captain must merge and separately authorize live work.
Never print callback URLs, credentials, or stored identity hashes. Never retrieve
the old hook secret. Cleanup DELETE never targets the sole approved incident hook;
this does not prohibit an explicitly authorized registration update. Adopted hooks
are also excluded from cleanup deletion.

## Supported configuration and local checks

Use `examples/config.example.json`: `repositories`, `reviewWorkerUrl`, `dryRun: true`,
and **nested** `registration` containing `repository`, `hookId`,
`sourceSubscriptionId`, `sourceAccountId`, `migrationRecordId`, `fromCallbackUrl`.
The previous flat migration configuration is not this declaration's schema.
Keep installation values in host configuration, never in this document/source.
The replacement subscription must differ from the source. Original and target
callbacks must be canonical HTTPS URLs on the same origin, with distinct paths.
The account and repository numeric identity must match the approved configuration.

Run locally: `npm test` and `npm run typecheck` in this app directory.
Migrations `0006_guarded_hook_ownership.sql`, `0007_expiring_hook_locks.sql` and
`0008_registration_failure_reasons.sql` are additive; do not edit applied migrations. They do not backfill legacy
ownership or grant deletion rights.

## Read-only diagnostics

- `registrationConfigurationDiagnostic({ configJson })` validates proposed config
  JSON, returning only fixed codes and field names. Supply config only, **never
  credentials**. It checks structure, not host account/callback/secret binding.
- `registrationDetail({ recordId })` reads the latest recorded attempt detail;
  `recordId` is `registration.migrationRecordId`, not the Executor subscription ID.
  Possible details include `invalid_input/input`, `identity_hash_failed/identity`,
  `claim_failed/storage`, `registration_blocked/storage`, `preflight_failed/hook`,
  `mutation_unresolved/hook`, or `complete/hook`. A blocked or failed attempt
  also carries a fixed `reason` (for example `reservation_leased`,
  `reservation_identity_mismatch`, `hook_busy`, `github_status`,
  `github_request_failed`, `shared_hook_mismatch`, `hook_has_other_owner`), the
  GitHub `httpStatus` when one was returned, and `recordedAt`.
- `replacementRegistrationDiagnostic({ recordId })` uses the same
  `registration.migrationRecordId` and independently reads the durable reservation
  phase. `patching` means **mutation outcome unresolved**, including
  POST; no automatic retry is safe. A later blocked attempt may replace the detail
  code but does not clear this reservation or the repository lock. `lease` is
  `active`, `expired` (the next identical attempt may retake it) or `pinned`.
- `hookOwnershipDiagnostic({ repositoryId })` reads the repository lock and owner
  rows for a numeric GitHub repository ID: lock holder subscription, operation,
  `lease`, `acquiredAt` and `leaseUntil`, and each owner's subscription, hook ID,
  `createdHere` and `released`. A lock taken by an older deployed version, or
  before `0008`, has a `null` holder; older versions insert locks that read as
  `pinned`.

These queries never return raw config, callbacks, hashes, fingerprints, or secrets.
`not_recorded`, `before_reservation`, and `diagnostic_unavailable` are not success:
Executor may reject the schema before app code runs; SQL diagnostic writes can
also fail. Configuration preflight is the read-only fallback for schema rejection.
Executor's `webhooks.sources`/`webhooks.get` expose a closed `failure` enum; this
patch **does not change that platform field** or add field-level platform errors.

## Registration and cleanup contract

Registration verifies repository full name and numeric ID, paginates all hook
records, and refuses duplicate targets, wrong IDs, wrong visible settings, or an
approved ID at a different URL. A match may be at the exact original or target
callback, but must have the approved hook ID. Adoption GETs that ID, PATCHes only
`url` and the host-supplied `secret` through the config endpoint, then GETs readback.
Only absence of both matching URLs and the approved hook ID allows one POST with
`web`/active/`pull_request`/JSON/secure-TLS settings. A completed identical retry
verifies its current target. A 404 for that hook triggers a fresh exhaustive list.
If the fully paginated list has no original or target callback and neither the
recorded nor approved hook ID exists at another URL, the same registration may
recreate the hook only when no other live owner references either missing ID.
The migration is durably marked `patching` before POST; success requires GET
readback and updates both the owner row and returned subscription state with the
new hook ID. An ambiguous POST or readback remains
unresolved and blocks retry. Changed identity is rejected. Lost mutation responses
require operator investigation, not a new record ID or clearing a lock.

References are durable and locks cover the entire repository across linked
accounts. A lock expires after 60 seconds until its holder pins it immediately
before a GitHub PATCH, POST, or DELETE, so an attempt interrupted before any
mutation cannot strand the repository. A registration pins the lock and marks
its reservation `patching` in one transaction, so a pinned registration lock
always has a patching record. A pinned lock never expires: do not
manually clear it without proving the external outcome. `0007` releases a legacy
lock only when no registration can be mid-mutation and the repository has no
created hook cleanup could delete. Cleanup releases only its own reference;
shared hooks are not deleted. Adopted and unknown/legacy hooks are never deleted.
Only a hook created here with a sole live reference can be deleted; repeated
cleanup uses a retained retirement record and does not repeat DELETE. This cannot
protect against old deployed callbacks or independent external administrators.

## Live retirement sequence: blocked before any mutation

The local official docs were read in full:

- `executor-docs/webhooks.md`, “Webhook subscriptions”: “Subscriptions pin their
  original version and account IDs; recreate to upgrade.” It also says removal
  precedes app/account deletion and cleanup is retried by reconcile.
- `executor-docs/deploy.md`, “Version activation” text (lines 466–478): activation
  “re-registers each webhook source's subscriptions on it in the background” and
  `apps.activate` takes `version`/`expectedVersion`. It does not specify whether
  re-registration invokes an old unregister callback or guarantee every pinned
  subscription is repointed without cleanup.

These statements do **not** prove a preserve-only activation path. Existing
subscriptions remain on old versions in this incident despite activation/reconcile;
the old unregister callback sends GitHub DELETE. New code cannot intercept it.
There is no documented skip-unregister/force-retire operation. Do not invent one,
and do not use remove/recreate, account unlink, app deletion, or old-version
reconcile as a workaround. Stopped subscriptions also remain unsafe to remove.

The exact safe sequence currently supported is:

1. Review/merge the patch; keep `dryRun: true`. No live operations in this task.
2. Perform only read-only configuration/status checks under Captain authorization.
3. **STOP before activation, reconciliation, registration, or retirement.** Obtain
   an authoritative host contract (or audited host implementation plus an isolated
   non-production lifecycle test) proving how *each existing subscription* can
   move to preserve-only callbacks without executing its original unregister.
4. Captain must approve a concrete host-supported sequence using that evidence.
   Verify pinned versions and callbacks read-only after any separately authorized
   transition, before removing anything. If evidence is unavailable, retain the old
   subscriptions indefinitely; there is no supported safe retirement recipe yet.

Even a new replacement subscription can rotate the shared hook's URL/secret and
interrupt old deliveries, so it is not an alternative way past this pause. This
patch supplies self-healing code, not proof that the host will run it for the
currently pending/pinned registrations.
