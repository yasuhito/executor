# Executor

Public source for an Executor GitHub pull-request inbox and its review Worker. Repository names, numeric repository IDs, webhook and subscription identifiers, Worker URLs, and Cloudflare account settings belong in each installation's configuration. They do not belong in source files.

## Components

- [`apps/pr-inbox`](apps/pr-inbox/README.md) is the Executor app. It validates signed webhooks against a configured repository allowlist, stores durable queue state, requests review, and applies guarded merges through the configured GitHub account.
- [`apps/review-worker`](apps/review-worker) is a Cloudflare Worker. It accepts canonical pull-request URLs only for its configured repositories, reads public GitHub data, and sends an immutable snapshot to the review runtime. It has no GitHub write capability.
- [`apps/pr-inbox/examples/config.example.json`](apps/pr-inbox/examples/config.example.json) and [`apps/review-worker/examples/wrangler.toml.example`](apps/review-worker/examples/wrangler.toml.example) show placeholder configuration. Replace every placeholder before use.

The Executor app and Worker must have the same repository names and numeric IDs in their respective allowlists. The app's `reviewWorkerUrl` and the review-service HMAC secret must point to the same Worker installation.

## Installation configuration

1. Copy `apps/pr-inbox/examples/config.example.json` into your Executor configuration. Set a non-empty, duplicate-free `repositories` list. Each entry uses the repository's exact `fullName` and numeric GitHub repository ID. The `registration` block refers to the one existing hook that an approved registration may update. Use the source subscription, account, hook, migration record, and original callback values from your own hosting setup.
2. Use `apps/review-worker/examples/wrangler.toml.example` to prepare an ignored local `wrangler.local.toml`, then pass it to Wrangler with `--config wrangler.local.toml`. Configure the same `REPOSITORIES` list and set `OPENAI_MODEL` only to a model slug reported by the bootstrap script for your authenticated account. The tracked `wrangler.toml` contains bindings but no account ID, repository, Worker URL, or secret.
3. Configure Worker secrets outside source control:

   - `REVIEW_HMAC_SECRET`: shared with the Executor review-service secret account.
   - `CREDENTIAL_BOOTSTRAP_SECRET`: separate from the HMAC secret and used only for credential import.
   - `CREDENTIAL_ENCRYPTION_KEY`: base64 encoding of 32 random bytes.

   Generate secret values in your own environment, for example with `openssl rand -hex 32` for the first two and `openssl rand -base64 32` for the encryption key. Do not paste the generated values into this repository.
4. Configure the same HMAC secret as the Executor app's review-service account. Keep local Worker values in `.dev.vars`; the file is ignored by Git.
5. After you have configured and deployed your own Worker, the interactive bootstrap command can sign in with the official provider, verify the account-listed supported models, and import the credential into the Worker:

   ```sh
   cd apps/review-worker
   npm ci --ignore-scripts
   node --experimental-strip-types scripts/bootstrap.mjs https://YOUR-WORKER-ORIGIN
   ```

   It prompts for the bootstrap secret without echoing it. The bootstrap process does not read existing Pi or Codex credential files. Set `OPENAI_MODEL` only after checking its output.

The review Worker uses unauthenticated GitHub reads. Repositories must expose the pull-request data and checks it needs through GitHub's public API. Executor uses its configured GitHub account for the final merge request. Registration only updates the callback and signing secret of the exact pre-existing hook after checking its current settings. It does not create or delete hooks.

## Validation

Run the packages' tests and type checks without deployment credentials:

```sh
(cd apps/pr-inbox && npm ci --ignore-scripts && npm test && npm run typecheck)
(cd apps/review-worker && npm ci --ignore-scripts && npm test && npm run typecheck)
```

The PR-inbox test command also scans source and documentation for deployment IDs, concrete Worker hostnames, and repository identifiers. Files under `tests/` and `examples/` are excluded from that scan so fixtures and placeholders remain usable.
