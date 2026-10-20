import assert from "node:assert/strict";
import test from "node:test";
import app from "../index.ts";
import { telegram, telegramDestination } from "../providers.ts";

// The installed apps SDK wraps scheduled operations under this symbol.
function nativeOperation(declaration) {
  const symbol = Object.getOwnPropertySymbols(declaration).find(
    (candidate) => candidate.description === "apps.Operation",
  );
  return symbol === undefined ? undefined : declaration[symbol];
}

const context = {
  app: {
    accounts: {
      telegram: { method: "apiKey", fields: { token: "fake-token-handle" } },
      telegramDestination: { method: "secret", fields: { chatId: "fake-chat-handle" } },
      reviewService: { id: "review-fixture", method: "secret", fields: { hmacSecret: "x".repeat(32) } },
    },
  },
  user: {
    accounts: {
      github: { id: "github-fixture", method: "token", fields: { token: "fixture" } },
    },
  },
  cache: {},
  files: [],
  workflows: { get: async () => ({}), list: async () => ({ items: [] }) },
  elicit: async () => ({}),
  fetch: async () => { throw new Error("network access is disabled in this test"); },
  signal: new AbortController().signal,
};

test("the app keeps the existing webhook and registers its workflow, queries, and recovery schedule", async () => {
  const definition = await app.evaluate(context);
  const tools = Object.getOwnPropertySymbols(definition.tools)
    .map((symbol) => definition.tools[symbol])
    .find((value) => value?.kind === "router")?.children;
  const exportedMutations = Object.values(tools).filter(
    (operation) => operation?.kind === "mutation",
  );

  assert.deepEqual(
    {
      appAccounts: Object.keys(app.accounts.app),
      webhooks: Object.keys(definition.webhooks),
      workflows: Object.keys(definition.workflows),
      schedules: Object.keys(definition.schedules),
      hasReceiptQuery: "recentReceipts" in tools,
      hasReviewQuery: "recentReviews" in tools,
      hasNotificationStatus: "notificationStatus" in tools,
      hasReplacementRegistrationDiagnostic:
        "replacementRegistrationDiagnostic" in tools,
      recoverQueueIsExportedMutation:
        tools.recoverQueue ===
        nativeOperation(definition.schedules.recoverQueue.operation),
      everyScheduleUsesExportedMutation: Object.values(definition.schedules).every(
        ({ operation }) =>
          operation.kind === "mutation" &&
          exportedMutations.includes(nativeOperation(operation)),
      ),
    },
    {
      appAccounts: ["reviewService", "telegram", "telegramDestination"],
      webhooks: ["github"],
      workflows: ["processQueue"],
      schedules: ["recoverQueue"],
      hasReceiptQuery: true,
      hasReviewQuery: true,
      hasNotificationStatus: true,
      hasReplacementRegistrationDiagnostic: true,
      recoverQueueIsExportedMutation: true,
      everyScheduleUsesExportedMutation: true,
    },
  );
});


test("Telegram account requirements retain official provider compatibility and host-bound destination secrets", () => {
  assert.deepEqual({
    name: telegram.name,
    hosts: telegram.hosts,
    authKeys: Object.keys(telegram.auth),
    tokenLabel: telegram.auth.apiKey.label,
    tokenTag: telegram.auth.apiKey._tag,
    tokenFields: Object.keys(telegram.auth.apiKey.fields.fields),
    health: typeof telegram.health.run,
    destinationHosts: telegramDestination.hosts,
    destinationTag: telegramDestination.auth.secret._tag,
    destinationFields: Object.keys(telegramDestination.auth.secret.fields.fields),
  }, {
    name: "Telegram",
    hosts: ["api.telegram.org"],
    authKeys: ["apiKey"],
    tokenLabel: "Bot token",
    tokenTag: "secrets",
    tokenFields: ["token"],
    health: "function",
    destinationHosts: ["api.telegram.org"],
    destinationTag: "secrets",
    destinationFields: ["chatId"],
  });
});
