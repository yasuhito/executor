import type { WorkflowStepContext } from "apps";
import type { requirements } from "./providers.ts";

export type TelegramOutcome =
  | { status: "sent" }
  | { status: "retry"; failureCode: "telegram_rate_limited"; retryAfterMs: number }
  | { status: "failed"; failureCode: "telegram_auth_failed" | "telegram_rejected" }
  | { status: "unknown"; failureCode: "telegram_delivery_unknown" };

const unknown: TelegramOutcome = { status: "unknown", failureCode: "telegram_delivery_unknown" };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// No SDK/client retries: a lost response may already have delivered the message.
export async function sendTelegramNotification(
  context: Pick<WorkflowStepContext<typeof requirements>, "app" | "fetch" | "signal">,
  text: string,
): Promise<TelegramOutcome> {
  try {
    const response = await context.fetch(
      `https://api.telegram.org/bot${context.app.accounts.telegram.fields.token}/sendMessage`,
      {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: context.app.accounts.telegramDestination.fields.chatId,
          text,
          link_preview_options: { is_disabled: true },
        }),
      },
    );
    if (response.status >= 500 || (response.status >= 300 && response.status < 400)) return unknown;
    const body: unknown = await response.json();
    if (!record(body)) return unknown;
    if (response.status === 200 && body.ok === true && record(body.result)
      && Number.isSafeInteger(body.result.message_id) && (body.result.message_id as number) > 0) {
      return { status: "sent" };
    }
    if (body.ok !== false || body.error_code !== response.status) return unknown;
    if (response.status === 429) {
      const delay = record(body.parameters) ? body.parameters.retry_after : undefined;
      if (typeof delay === "number" && Number.isSafeInteger(delay) && delay >= 1 && delay <= 3600) {
        return { status: "retry", failureCode: "telegram_rate_limited", retryAfterMs: delay * 1000 };
      }
      return unknown;
    }
    if (response.status === 401 || response.status === 403) return { status: "failed", failureCode: "telegram_auth_failed" };
    if (response.status === 400 || response.status === 404) return { status: "failed", failureCode: "telegram_rejected" };
    return unknown;
  } catch {
    // Never expose a fetch exception, request URL, account handle, or API body.
    return unknown;
  }
}
