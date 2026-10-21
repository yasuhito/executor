import assert from "node:assert/strict";
import test from "node:test";
import { sendTelegramNotification } from "../telegram.ts";

function context(fetch) {
  return {
    app: {
      accounts: {
        telegram: { fields: { token: "opaque-token-handle" } },
        telegramDestination: { fields: { chatId: "opaque-chat-handle" } },
      },
    },
    signal: new AbortController().signal,
    fetch,
  };
}

test("sender uses unchanged app handles and the exact fixed-host JSON request", async () => {
  let request;
  const result = await sendTelegramNotification(
    context(async (url, init) => {
      request = { url, init };
      return Response.json({ ok: true, result: { message_id: 4 } });
    }),
    "safe message",
  );
  const observation = {
    result,
    url: request.url,
    method: request.init.method,
    redirect: request.init.redirect,
    contentType: request.init.headers["Content-Type"],
    hasSignal: request.init.signal instanceof AbortSignal,
    body: JSON.parse(request.init.body),
  };

  assert.deepEqual(observation, {
    result: { status: "sent" },
    url: "https://api.telegram.org/botopaque-token-handle/sendMessage",
    method: "POST",
    redirect: "manual",
    contentType: "application/json",
    hasSignal: true,
    body: {
      chat_id: "opaque-chat-handle",
      text: "safe message",
      link_preview_options: { is_disabled: true },
    },
  });
});

test("only explicit matching 429 with bounded retry_after may retry", async () => {
  const send = (status, body) =>
    sendTelegramNotification(
      context(async () => Response.json(body, { status })),
      "safe message",
    );
  const allowed = await send(429, { ok: false, error_code: 429, parameters: { retry_after: 60 } });
  const rejected = await Promise.all([
    send(429, { ok: false }),
    send(429, { ok: false, error_code: 429, parameters: { retry_after: 999999 } }),
    send(429, { ok: true }),
  ]);

  assert.deepEqual(
    [allowed, ...rejected.map(({ status }) => status)],
    [
      { status: "retry", failureCode: "telegram_rate_limited", retryAfterMs: 60000 },
      "unknown",
      "unknown",
      "unknown",
    ],
  );
});

test("auth is terminal; network, 5xx, redirects and malformed results are ambiguous without leakage", async () => {
  const leak = "opaque-token-handle opaque-chat-handle safe message private response";
  const cases = [
    [
      async () => {
        throw new Error(leak);
      },
      "unknown",
    ],
    [async () => Response.json({ ok: false, description: leak }, { status: 503 }), "unknown"],
    [async () => new Response(leak), "unknown"],
    [async () => Response.json({ ok: true, result: {} }), "unknown"],
    [
      async () =>
        new Response(null, { status: 302, headers: { location: "https://example.invalid" } }),
      "unknown",
    ],
    [
      async () => Response.json({ ok: false, error_code: 401, description: leak }, { status: 401 }),
      "failed",
    ],
  ];
  const results = await Promise.all(
    cases.map(async ([fetch, status]) => {
      const result = await sendTelegramNotification(context(fetch), "safe message");
      return {
        status: result.status,
        leaked: leak.split(" ").some((value) => JSON.stringify(result).includes(value)),
        expectedStatus: status,
      };
    }),
  );

  assert.deepEqual(
    results,
    cases.map(([, expectedStatus]) => ({ status: expectedStatus, leaked: false, expectedStatus })),
  );
});
