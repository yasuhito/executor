import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signRequest } from "../src/auth.ts";

const reviewSecret = "fake-review-hmac-secret-012345678901234";
const bootstrapSecret = "fake-bootstrap-secret-012345678901234";
const headSha = "0123456789abcdef0123456789abcdef01234567";
const baseSha = "89abcdef0123456789abcdef0123456789abcdef";
const mergeSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const credential = () => ({
  type: "oauth",
  access: "fake-initial-access",
  refresh: "fake-initial-refresh",
  expires: Date.now() + 1000,
  clientId: "fake-issued-client",
  scopes: ["chatgpt.tokens.use.direct"],
});
const pullRequestUrl = (number) =>
  `https://github.com/example-owner/example-repository/pull/${number}`;
const reviewRequest = (number, operationId) => ({
  pullRequestUrl: pullRequestUrl(number),
  operationId,
});
async function signed(mf, path, value, secret = bootstrapSecret, nonce) {
  const body = JSON.stringify(value);
  const sig = await signRequest(
    secret,
    "POST",
    path,
    new TextEncoder().encode(body),
    undefined,
    nonce,
  );
  return mf.dispatchFetch(`https://review.example${path}`, {
    method: "POST",
    body,
    headers: {
      "x-executor-timestamp": sig.timestamp,
      "x-executor-nonce": sig.nonce,
      "x-executor-signature": sig.signature,
    },
  });
}
async function setup(t, bindings = {}) {
  const {
    omitOpenAiModel = false,
    omitCredentialBootstrapSecret = false,
    omitCredentialEncryptionKey = false,
    ...bindingOverrides
  } = bindings;
  const workerBindings = {
    REVIEW_HMAC_SECRET: reviewSecret,
    CREDENTIAL_BOOTSTRAP_SECRET: bootstrapSecret,
    CREDENTIAL_ENCRYPTION_KEY: btoa("0123456789abcdef0123456789abcdef"),
    OPENAI_MODEL: "gpt-5.4",
    REPOSITORIES: JSON.stringify([{ fullName: "example-owner/example-repository", id: 123456789 }]),
    OPENAI_API_KEY: "sk-fake-ambient-forbidden",
    ...bindingOverrides,
  };
  if (omitOpenAiModel) delete workerBindings.OPENAI_MODEL;
  if (omitCredentialBootstrapSecret) delete workerBindings.CREDENTIAL_BOOTSTRAP_SECRET;
  if (omitCredentialEncryptionKey) delete workerBindings.CREDENTIAL_ENCRYPTION_KEY;
  const dir = await mkdtemp(join(tmpdir(), "executor-subscription-"));
  const scriptPath = join(dir, "worker.mjs");
  await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: scriptPath,
    external: ["cloudflare:*", "node:*"],
    conditions: ["workerd", "worker", "browser"],
    logLevel: "silent",
  });
  let refreshes = 0;
  let requests = 0;
  let invalid = false;
  let diskLeak = false;
  const logs = [];
  const observed = [];
  const githubRequests = [];
  const options = {
    modules: true,
    unsafeInspectDurableObjects: true,
    modulesRoot: dir,
    scriptPath,
    compatibilityDate: "2026-10-18",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      REVIEWS: { className: "ReviewDurableObject", useSQLite: true },
      CREDENTIALS: { className: "CredentialDurableObject", useSQLite: true },
    },
    resourcePersistencePath: join(dir, "state"),
    bindings: workerBindings,
    handleStructuredLogs: (entries) => {
      logs.push(JSON.stringify(entries));
    },
    outboundService: async (req) => {
      if (req.url === "https://auth.openai.com/api/accounts/oauth/token" && req.method === "POST") {
        refreshes++;
        const body = new URLSearchParams(await req.text());
        observed.push(body.get("refresh_token"));
        await new Promise((r) => setTimeout(r, 30));
        return invalid
          ? Response.json({ error: "invalid_grant" }, { status: 400 })
          : Response.json({
              access_token: "fake-rotated-access",
              refresh_token: "fake-rotated-refresh",
              expires_in: 3600,
              scope: "chatgpt.tokens.use.direct",
            });
      }
      if (req.url === "https://api.openai.com/v1/responses" && req.method === "POST") {
        requests++;
        const body = await req.json();
        if (
          req.headers.get("authorization") !== "Bearer fake-rotated-access" ||
          body.store !== false ||
          body.stream !== true ||
          JSON.stringify(body).includes("fake-rotated")
        )
          throw Error("Auth isolation violated");
        const text = JSON.stringify({
          standards: { status: "unverifiable", findings: [] },
          changeIntent: { status: "unverifiable", findings: [] },
        });
        const item = {
          type: "message",
          id: "msg_mock",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        };
        const events = [
          { type: "response.created", response: { id: "resp_mock", status: "in_progress" } },
          { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
          { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "resp_mock",
              status: "completed",
              output: [item],
              usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
            },
          },
        ];
        return new Response(
          events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const url = new URL(req.url);
      if (url.origin === "https://api.github.com") {
        githubRequests.push({
          url: req.url,
          method: req.method,
          authorization: req.headers.get("authorization"),
        });
        const prefix = "/repos/example-owner/example-repository";
        if (req.method !== "GET") throw Error("GitHub write calls are forbidden in Worker tests");
        if (url.pathname === prefix)
          return Response.json({
            id: 123456789,
            full_name: "example-owner/example-repository",
            default_branch: "main",
          });
        const pull = new RegExp(`^${prefix}/pulls/(\\d+)$`).exec(url.pathname);
        if (pull) {
          const number = Number(pull[1]);
          return Response.json({
            number,
            state: "open",
            title: `Bump example for ${number}`,
            draft: false,
            merged: false,
            mergeable: true,
            mergeable_state: "clean",
            merged_at: null,
            merge_commit_sha: null,
            user: { login: "dependabot[bot]", type: "Bot" },
            head: {
              sha: headSha,
              ref: "dependabot/example-1.0.1",
              repo: { id: 123456789, full_name: "example-owner/example-repository" },
            },
            base: {
              sha: baseSha,
              ref: "main",
              repo: { id: 123456789, full_name: "example-owner/example-repository" },
            },
          });
        }
        if (url.pathname === `${prefix}/actions/runs`) {
          return Response.json({
            total_count: 1,
            workflow_runs: [
              {
                id: 77,
                event: "pull_request",
                status: "completed",
                conclusion: "success",
                head_sha: mergeSha,
                check_suite_id: 20,
                created_at: "2026-01-02T00:00:00Z",
                pull_requests: [42, 43, 44, 11, 12, 13, 20].map((number) => ({ number })),
              },
            ],
          });
        }
        if (url.pathname === `${prefix}/commits/${mergeSha}`)
          return Response.json({ sha: mergeSha, parents: [{ sha: baseSha }, { sha: headSha }] });
        if (url.pathname === `${prefix}/commits/${mergeSha}/check-runs`) {
          const check_runs = ["web", "tui", "qiskit-backend"].map((name, index) => ({
            id: index + 1,
            name,
            head_sha: mergeSha,
            status: "completed",
            conclusion: "success",
            check_suite: { id: 20 },
            app: { slug: "github-actions" },
          }));
          return Response.json({ total_count: check_runs.length, check_runs });
        }
        if (url.pathname.match(new RegExp(`^${prefix}/pulls/\\d+/files$`)))
          return Response.json([
            { filename: "Cargo.toml", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" },
          ]);
        if (url.pathname.match(new RegExp(`^${prefix}/pulls/\\d+/commits$`)))
          return Response.json([{ commit: { message: "Bump example from 1.0.0 to 1.0.1" } }]);
        if (url.pathname === `${prefix}/contents/AGENTS.md`)
          return Response.json({
            type: "file",
            encoding: "base64",
            content: btoa("Repository review instructions"),
          });
        if (url.pathname === `${prefix}/contents/CONTRIBUTING.md`)
          return Response.json({ message: "Not Found" }, { status: 404 });
        throw Error(`Unmatched GitHub read endpoint: ${url.pathname}`);
      }
      throw Error("Unmatched outbound URL forbidden");
    },
  };
  let mf = new Miniflare(convertV4MiniflareOptions(options));
  t.after(async () => {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    get mf() {
      return mf;
    },
    stats: () => ({ refreshes, requests }),
    logs,
    observed,
    githubRequests,
    diskLeak: () => diskLeak,
    invalid: () => {
      invalid = true;
    },
    restart: async () => {
      await mf.dispose();
      for (const path of await readdir(join(dir, "state"), { recursive: true })) {
        if (!/\.(sqlite|sqlite-wal)$/.test(path)) continue;
        const data = await readFile(join(dir, "state", path));
        diskLeak ||= [
          "fake-initial-access",
          "fake-initial-refresh",
          "fake-rotated-access",
          "fake-rotated-refresh",
        ].some((token) => data.includes(token));
      }
      mf = new Miniflare(convertV4MiniflareOptions(options));
    },
  };
}

test("static OAuth loader: concurrent URL-only reviews share one refresh and persist no plaintext token", {
  timeout: 90_000,
}, async (t) => {
  const s = await setup(t);
  const nonce = crypto.randomUUID();
  const imported = await signed(
    s.mf,
    "/v1/credentials/import",
    { provider: "openai", credential: credential() },
    bootstrapSecret,
    nonce,
  );
  const responses = await Promise.all(
    [42, 43].map((number) =>
      signed(
        s.mf,
        "/v1/review",
        reviewRequest(number, String(number).padStart(64, "0")),
        reviewSecret,
      ).then((r) => r.json()),
    ),
  );
  await s.restart();
  const replay = await signed(
    s.mf,
    "/v1/credentials/import",
    { provider: "openai", credential: credential() },
    bootstrapSecret,
    nonce,
  );
  const third = await (
    await signed(s.mf, "/v1/review", reviewRequest(44, "4".repeat(64)), reviewSecret)
  ).json();
  const all = [...responses, third];

  assert.deepEqual(
    {
      imported: imported.status,
      replay: replay.status,
      stats: s.stats(),
      results: all.map((r) => [
        r.status,
        !!r.verdict,
        r.verdict?.decision,
        r.identity,
        typeof r.snapshotHash === "string" && /^[0-9a-f]{64}$/.test(r.snapshotHash),
      ]),
      githubCallsPublic:
        s.githubRequests.length > 0 &&
        s.githubRequests.every(
          (r) =>
            r.authorization === null &&
            r.method === "GET" &&
            new URL(r.url).origin === "https://api.github.com",
        ),
      snapshotsAcquiredByWorker:
        [42, 43, 44].every((number) =>
          s.githubRequests.some(
            ({ url }) =>
              new URL(url).pathname ===
              `/repos/example-owner/example-repository/pulls/${number}/files`,
          ),
        ) &&
        s.githubRequests.some(({ url }) => {
          const parsed = new URL(url);
          return (
            parsed.pathname === "/repos/example-owner/example-repository/contents/AGENTS.md" &&
            parsed.searchParams.get("ref") === baseSha
          );
        }),
      leak: s.diskLeak() || /fake-(initial|rotated|ambient)/.test(JSON.stringify([all, s.logs])),
    },
    {
      imported: 200,
      replay: 409,
      stats: { refreshes: 1, requests: 3 },
      results: [42, 43, 44].map((number) => [
        "complete",
        true,
        "needs-attention",
        {
          repository: "example-owner/example-repository",
          pullRequest: number,
          headSha,
          testedBaseSha: baseSha,
        },
        true,
      ]),
      githubCallsPublic: true,
      snapshotsAcquiredByWorker: true,
      leak: false,
    },
  );
});

test("wrong secret, invalid credential, replay, and public resolver are rejected", {
  timeout: 60_000,
}, async (t) => {
  const s = await setup(t);
  const nonce = crypto.randomUUID();
  const statuses = [];
  statuses.push(
    (
      await signed(
        s.mf,
        "/v1/credentials/import",
        { provider: "openai", credential: credential() },
        reviewSecret,
      )
    ).status,
  );
  for (const patch of [{ type: "api_key", key: "sk-fake" }, { scopes: [] }])
    statuses.push(
      (
        await signed(s.mf, "/v1/credentials/import", {
          provider: "openai",
          credential: { ...credential(), ...patch },
        })
      ).status,
    );
  statuses.push(
    (
      await signed(
        s.mf,
        "/v1/credentials/import",
        { provider: "openai", credential: credential() },
        bootstrapSecret,
        nonce,
      )
    ).status,
  );
  statuses.push((await signed(s.mf, "/v1/credentials/revoke", {}, bootstrapSecret, nonce)).status);
  statuses.push((await signed(s.mf, "/v1/credentials/resolve", {})).status);

  assert.deepEqual(statuses, [401, 400, 400, 200, 409, 404]);
});

test("credential decryption failures return a safe operation error", {
  timeout: 60_000,
}, async (t) => {
  const s = await setup(t);
  await signed(s.mf, "/v1/credentials/import", { provider: "openai", credential: credential() });

  const storage = await s.mf.unsafeGetDurableObjectStorage("", "CredentialDurableObject", {
    name: "installation",
  });
  await storage.exec(
    "UPDATE credential SET envelope = ? WHERE id = 1",
    JSON.stringify({ version: 1, nonce: Array(12).fill(0), ciphertext: Array(32).fill(0) }),
  );

  const response = await signed(s.mf, "/v1/credentials/status", {});
  assert.deepEqual(
    [response.status, await response.json()],
    [503, { status: "credential_operation_failed", errorCode: "crypto_operation_failed" }],
  );
  assert.match(JSON.stringify(s.logs), /OperationError/);
  assert.doesNotMatch(JSON.stringify(s.logs), /fake-initial-(access|refresh)/);
});

test("unrecoverable OAuth refresh failure requires reauthentication and does not loop", {
  timeout: 90_000,
}, async (t) => {
  const s = await setup(t);
  s.invalid();
  await signed(s.mf, "/v1/credentials/import", { provider: "openai", credential: credential() });
  const first = await (
    await signed(s.mf, "/v1/review", reviewRequest(11, "1".repeat(64)), reviewSecret)
  ).json();
  const second = await (
    await signed(s.mf, "/v1/review", reviewRequest(12, "2".repeat(64)), reviewSecret)
  ).json();

  assert.deepEqual(
    [first.failureCode, second.failureCode, s.stats()],
    ["reauth_required", "reauth_required", { refreshes: 1, requests: 0 }],
  );
});

test("revocation requires reauthentication and an explicit import clears that state", {
  timeout: 90_000,
}, async (t) => {
  const s = await setup(t);
  await signed(s.mf, "/v1/credentials/import", { provider: "openai", credential: credential() });
  const revoked = await signed(s.mf, "/v1/credentials/revoke", {});
  const reimported = await signed(s.mf, "/v1/credentials/import", {
    provider: "openai",
    credential: credential(),
  });
  const state = await signed(s.mf, "/v1/credentials/status", {});

  assert.deepEqual(
    [revoked.status, reimported.status, await state.json()],
    [200, 200, { status: "configured", reauthRequired: false }],
  );
});

test("missing bootstrap secret rejects import before parsing credential data", {
  timeout: 60_000,
}, async (t) => {
  const s = await setup(t, { omitCredentialBootstrapSecret: true });
  const response = await s.mf.dispatchFetch("https://review.example/v1/credentials/import", {
    method: "POST",
    body: "not-json",
  });

  assert.deepEqual(
    [response.status, await response.json(), s.stats()],
    [503, { status: "bootstrap_unavailable" }, { refreshes: 0, requests: 0 }],
  );
});

test("missing encryption key rejects import without reporting secrets", {
  timeout: 60_000,
}, async (t) => {
  const s = await setup(t, { omitCredentialEncryptionKey: true });
  const response = await signed(s.mf, "/v1/credentials/import", {
    provider: "openai",
    credential: credential(),
  });

  assert.deepEqual(
    [response.status, await response.json(), s.stats()],
    [
      503,
      { status: "credential_operation_failed", errorCode: "invalid_encryption_binding" },
      { refreshes: 0, requests: 0 },
    ],
  );
});

test("invalid encryption binding rejects import without reporting secrets", {
  timeout: 60_000,
}, async (t) => {
  const s = await setup(t, { CREDENTIAL_ENCRYPTION_KEY: "fake-invalid-key" });
  const response = await signed(s.mf, "/v1/credentials/import", {
    provider: "openai",
    credential: credential(),
  });

  assert.deepEqual(
    [response.status, await response.json(), s.stats()],
    [
      503,
      { status: "credential_operation_failed", errorCode: "invalid_encryption_binding" },
      { refreshes: 0, requests: 0 },
    ],
  );
});

test("missing model configuration makes no auth refresh or inference request", {
  timeout: 60_000,
}, async (t) => {
  const s = await setup(t, { omitOpenAiModel: true });
  await signed(s.mf, "/v1/credentials/import", { provider: "openai", credential: credential() });
  const result = await (
    await signed(s.mf, "/v1/review", reviewRequest(20, "3".repeat(64)), reviewSecret)
  ).json();

  assert.deepEqual(
    [result.failureCode, s.stats()],
    ["model_unavailable", { refreshes: 0, requests: 0 }],
  );
});

test("empty model configuration also makes no auth refresh or inference request", {
  timeout: 60_000,
}, async (t) => {
  const s = await setup(t, { OPENAI_MODEL: "" });
  await signed(s.mf, "/v1/credentials/import", { provider: "openai", credential: credential() });
  const result = await (
    await signed(s.mf, "/v1/review", reviewRequest(20, "5".repeat(64)), reviewSecret)
  ).json();

  assert.deepEqual(
    [result.failureCode, s.stats()],
    ["model_unavailable", { refreshes: 0, requests: 0 }],
  );
});

test("bootstrap requires HTTPS and exact signed path and body", { timeout: 60_000 }, async (t) => {
  const s = await setup(t);
  const path = "/v1/credentials/import";
  const value = { provider: "openai", credential: credential() };
  const body = JSON.stringify(value);
  const sig = await signRequest(bootstrapSecret, "POST", path, new TextEncoder().encode(body));
  const headers = {
    "x-executor-timestamp": sig.timestamp,
    "x-executor-nonce": sig.nonce,
    "x-executor-signature": sig.signature,
  };
  const statuses = [];
  statuses.push(
    (await s.mf.dispatchFetch(`http://review.example${path}`, { method: "POST", body, headers }))
      .status,
  );
  statuses.push(
    (
      await s.mf.dispatchFetch("https://review.example/v1/credentials/revoke", {
        method: "POST",
        body,
        headers,
      })
    ).status,
  );
  statuses.push(
    (
      await s.mf.dispatchFetch(`https://review.example${path}`, {
        method: "POST",
        body: `${body} `,
        headers,
      })
    ).status,
  );
  statuses.push((await signed(s.mf, path, { ...value, provider: "other" })).status);

  assert.deepEqual(statuses, [400, 401, 401, 400]);
});
