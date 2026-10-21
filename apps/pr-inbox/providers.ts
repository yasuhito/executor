import {
  boolean,
  decodeJson,
  defineProvider,
  number,
  object,
  oauth2,
  raw,
  secrets,
  string,
  type AccountOf,
  type WebhookContext,
} from "apps";

const User = object({
  id: number(),
  login: string(),
  avatar_url: string(),
  html_url: string(),
});

export const github = defineProvider({
  name: "GitHub",
  hosts: ["api.github.com"],
  auth: {
    token: secrets({
      label: "Personal access token",
      fields: object({ token: string({ minLength: 1 }) }),
    }),
    oauth: oauth2({
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      tokenEndpointAuthMethod: "client_secret_post",
      scopes: [
        "repo",
        "read:org",
        "workflow",
        "gist",
        "notifications",
        "read:user",
        "user:email",
        "project",
      ],
    }),
  },
  async health({ account, fetch, signal }) {
    const token = account.method === "oauth" ? account.fields.access_token : account.fields.token;
    const response = await fetch("https://api.github.com/user", {
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "executor-pr-inbox",
      },
    });
    const me = await decodeJson(response, User);
    return {
      accountInfo: {
        externalId: String(me.id),
        username: me.login,
        avatarUrl: me.avatar_url,
        profileUrl: me.html_url,
      },
    };
  },
});

export const reviewService = defineProvider({
  name: "Dependabot review service",
  auth: {
    secret: secrets({
      label: "Review service HMAC secret",
      fields: object({ hmacSecret: raw(string({ minLength: 32 })) }),
    }),
  },
});

// Match the official provider so deployment can link the existing bot account.
export const telegram = defineProvider({
  name: "Telegram",
  hosts: ["api.telegram.org"],
  auth: {
    apiKey: secrets({
      label: "Bot token",
      fields: object({ token: string({ minLength: 1 }) }),
    }),
  },
  async health({ account, fetch, signal }) {
    const response = await fetch(`https://api.telegram.org/bot${account.fields.token}/getMe`, {
      signal,
    });
    await decodeJson(response, object({ ok: boolean() }));
  },
});

export const telegramDestination = defineProvider({
  name: "Telegram notification destination",
  hosts: ["api.telegram.org"],
  auth: {
    secret: secrets({
      label: "Approved private chat",
      fields: object({ chatId: string({ minLength: 1 }) }),
    }),
  },
});

export const requirements = {
  user: { accounts: { github } },
  app: { accounts: { reviewService, telegram, telegramDestination } },
};

export type GitHubAccount = AccountOf<typeof github>;
export type ReviewServiceAccount = AccountOf<typeof reviewService>;
export type HookContext = WebhookContext<typeof requirements>;

export const apiOrigin = "https://api.github.com";
