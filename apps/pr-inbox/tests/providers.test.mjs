import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { github } from "../providers.ts";

const profile = {
  id: 42,
  login: "fixture-user",
  avatar_url: "https://example.test/avatar.png",
  html_url: "https://example.test/users/fixture-user",
};

test("GitHub account health sends the app User-Agent required by the API", async () => {
  let request;
  const account = { method: "token", fields: { token: "synthetic-fake-token" } };
  const result = await Effect.runPromise(
    github.health.run({
      account,
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        request = { url: String(input), userAgent: headers.get("User-Agent") };
        return headers.has("User-Agent")
          ? Response.json(profile)
          : Response.json(
              { message: "Resource not accessible without User-Agent" },
              { status: 403 },
            );
      },
      signal: new AbortController().signal,
    }),
  );

  assert.deepEqual(
    { ...request, username: result.accountInfo.username },
    {
      url: "https://api.github.com/user",
      userAgent: "executor-pr-inbox",
      username: "fixture-user",
    },
  );
});
