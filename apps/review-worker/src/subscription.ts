import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import type { AuthResult } from '@earendil-works/pi-ai';

export const noAmbientAuth = { env: async () => undefined, fileExists: async () => false };
export interface SubscriptionAccess { type: 'oauth'; source: 'OAuth'; access: string; expires: number }

/** Only privileged DO RPC supplies auth. No stored key, environment or filesystem path. */
export function reviewModels(resolve: () => Promise<SubscriptionAccess>) {
  const models = createModels({ authContext: noAmbientAuth });
  models.setProvider({
    ...openaiProvider(),
    auth: { apiKey: { name: 'Internal ChatGPT subscription', resolve: async (): Promise<AuthResult> => {
      const result = await resolve();
      if (result.type !== 'oauth' || result.source !== 'OAuth' || typeof result.access !== 'string' ||
          !result.access || result.access.startsWith('sk-') || !Number.isSafeInteger(result.expires) || result.expires <= Date.now()) {
        throw new Error('Subscription authentication unavailable');
      }
      return { auth: { apiKey: result.access }, source: 'OAuth' };
    } } },
  });
  return models;
}
