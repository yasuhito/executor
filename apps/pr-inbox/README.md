# PR inbox app

This Executor app receives signed GitHub pull-request webhooks, stores durable queue entries, and processes allowlisted repositories one at a time. It sends the review service a canonical pull-request URL and an opaque operation ID. The review service performs bounded, read-only GitHub inspection. Dry-run is the safe default: a passing review is recorded without calling the merge adapter. Set `dryRun` to `false` only in a separately approved merge-enable deployment.

## Configuration

Start from [`examples/config.example.json`](examples/config.example.json). Replace every placeholder with values for your own Executor and GitHub setup before registering the webhook.

- `repositories` must be a non-empty list of unique `{ "fullName", "id" }` pairs. Both the repository name and numeric GitHub repository ID are checked against each webhook. Use the same values in the review Worker `REPOSITORIES` variable.
- `reviewWorkerUrl` must be the review Worker HTTPS origin without a path, query, or fragment.
- `dryRun` defaults to `true`. In this mode both review axes and current pull-request identity are verified and stored, but no merge request is sent. It does not run the final mergeability check or the last pre-merge CI recheck, so a passing dry-run does not prove GitHub would accept a merge.
- `registration` describes one existing webhook that an approved registration may update. Its `repository` must be in `repositories`. The source subscription, account ID, hook ID, migration record ID, and original callback URL are installation-specific values. Keep them in the host's configuration, not in source control.

Registration verifies the exact existing GitHub hook and its callback settings before changing only the callback URL and signing secret. It does not create or delete hooks, read the old secret, or change the event list and TLS/content-type settings. Treat a failed or unresolved replacement as an operator recovery task. Do not retry with a different registration identity.

The app's configured GitHub and Telegram accounts are managed by Executor. Telegram is reserved for actionable `needs-attention` and `stale` results; successful dry-run reviews do not create routine notifications. The bot and approved private destination remain in Executor's secure accounts. The Worker HMAC secret is configured separately in the Worker and as the app's review-service secret account. Never place secret values in the JSON example or commit local configuration. `config.local.json` is ignored by Git.

## Database migrations

Once a migration has been applied to the hosted app database, its file is immutable. Do not edit or remove it; make schema changes in a new, higher-numbered migration. The migration tests pin SHA-256 hashes for migrations already applied to the live database.

## Local validation

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
```

`npm test` also checks that deployment identifiers and concrete Worker hostnames have not entered source or documentation. Test fixtures and files under `examples/` are excluded from that scan.
