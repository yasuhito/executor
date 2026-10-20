# PR inbox app

This Executor app receives signed GitHub pull-request webhooks, stores durable queue entries, and processes allowlisted repositories one at a time. It sends the review service a canonical pull-request URL and an opaque operation ID. The review service performs bounded, read-only GitHub inspection. Executor requests a merge only after the review result, required checks, pull-request identity, and mergeability pass the final guards.

## Configuration

Start from [`examples/config.example.json`](examples/config.example.json). Replace every placeholder with values for your own Executor and GitHub setup before registering the webhook.

- `repositories` must be a non-empty list of unique `{ "fullName", "id" }` pairs. Both the repository name and numeric GitHub repository ID are checked against each webhook. Use the same values in the review Worker `REPOSITORIES` variable.
- `reviewWorkerUrl` must be the review Worker HTTPS origin without a path, query, or fragment.
- `registration` describes one existing webhook that an approved registration may update. Its `repository` must be in `repositories`. The source subscription, account ID, hook ID, migration record ID, and original callback URL are installation-specific values. Keep them in the host's configuration, not in source control.

Registration verifies the exact existing GitHub hook and its callback settings before changing only the callback URL and signing secret. It does not create or delete hooks, read the old secret, or change the event list and TLS/content-type settings. Treat a failed or unresolved replacement as an operator recovery task. Do not retry with a different registration identity.

The app's configured GitHub and Telegram accounts are managed by Executor. The Worker HMAC secret is configured separately in the Worker and as the app's review-service secret account. Never place secret values in the JSON example or commit local configuration. `config.local.json` is ignored by Git.

## Local validation

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
```

`npm test` also checks that deployment identifiers and concrete Worker hostnames have not entered source or documentation. Test fixtures and files under `examples/` are excluded from that scan.
