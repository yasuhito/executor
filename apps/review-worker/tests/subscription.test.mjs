import assert from "node:assert/strict";
import test from "node:test";
import { reviewModels, noAmbientAuth } from "../src/subscription.ts";

for (const [name, patch] of [
  ["API-key type", { type: "api_key" }],
  ["metered key", { access: "sk-fake-forbidden" }],
  ["wrong source", { source: "OPENAI_API_KEY" }],
  ["expired auth", { expires: 0 }],
]) {
  test(`internal subscription adapter rejects ${name}`, async () => {
    const models = reviewModels(async () => ({
      type: "oauth",
      source: "OAuth",
      access: "fake-access",
      expires: Date.now() + 60000,
      ...patch,
    }));
    await assert.rejects(() => models.getAuth("openai", { apiKey: "sk-fake-ambient" }));
  });
}
test("auth context never reads an environment key or filesystem auth", async () => {
  assert.deepEqual(
    await Promise.all([
      noAmbientAuth.env("OPENAI_API_KEY"),
      noAmbientAuth.fileExists("~/.pi/auth.json"),
    ]),
    [undefined, false],
  );
});
