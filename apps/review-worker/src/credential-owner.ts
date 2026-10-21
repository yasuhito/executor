import { DurableObject } from 'cloudflare:workers';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { EncryptedCredentialStore, validateCredential, type EncryptedRow } from './credentials.ts';
import { noAmbientAuth, type SubscriptionAccess } from './subscription.ts';
import { readBoundedBody, verifyRequest } from './auth.ts';
import type { Env } from './index.ts';

export const credentialOwnerName = 'installation';
type AuthState = 'ready' | 'reauth_required';
type AuthCheck = 'ready' | 'reauth_required' | 'unavailable';
const reply = (status: number, state: string) => Response.json({ status: state }, { status, headers: { 'cache-control': 'no-store' } });

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    parts.push(current.name, current.message);
    current = current.cause;
  }
  return parts.join(' ').toLowerCase();
}

function requiresReauthentication(error: unknown): boolean {
  const text = errorText(error);
  return text.includes('invalid_grant') || text.includes('invalid_token') ||
    /http(?: error)?(?: status)? 40[13]/.test(text) ||
    /refresh token.{0,40}(?:revoked|expired|invalid)/.test(text);
}

function isValidAccess(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('sk-');
}

export class CredentialDurableObject extends DurableObject<Env> {
  private readonly credentials: EncryptedCredentialStore;
  private readonly models;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS credential (id INTEGER PRIMARY KEY CHECK(id = 1), envelope TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS bootstrap_nonce (nonce TEXT PRIMARY KEY)');
    sql.exec(`CREATE TABLE IF NOT EXISTS credential_auth_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      state TEXT NOT NULL CHECK(state IN ('ready', 'reauth_required')),
      failure_code TEXT,
      updated_at INTEGER NOT NULL
    )`);
    this.credentials = new EncryptedCredentialStore({
      read: () => {
        const row = sql.exec<{ envelope: string }>('SELECT envelope FROM credential WHERE id = 1').toArray()[0];
        return row ? JSON.parse(row.envelope) as EncryptedRow : undefined;
      },
      write: row => { sql.exec('INSERT INTO credential(id, envelope) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET envelope = excluded.envelope', JSON.stringify(row)); },
      delete: () => { sql.exec('DELETE FROM credential WHERE id = 1'); },
    }, env.CREDENTIAL_ENCRYPTION_KEY);
    this.models = createModels({ credentials: this.credentials, authContext: noAmbientAuth });
    const provider = openaiProvider();
    this.models.setProvider({ ...provider, auth: { oauth: provider.auth.oauth } });
  }

  private readAuthState(): AuthState | undefined {
    const row = this.ctx.storage.sql.exec<{ state: AuthState }>('SELECT state FROM credential_auth_state WHERE id = 1').toArray()[0];
    return row?.state;
  }

  private writeAuthState(state: AuthState, failureCode: string | null): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO credential_auth_state(id, state, failure_code, updated_at) VALUES(1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, failure_code = excluded.failure_code, updated_at = excluded.updated_at`,
      state,
      failureCode,
      Date.now(),
    );
  }

  private async resolveStoredAccess(): Promise<string> {
    const result = await this.models.getAuth('openai', { minOAuthValidityMs: 60_000 });
    const access = result?.auth.apiKey;
    if (result?.source !== 'OAuth' || !isValidAccess(access)) throw new Error('EXECUTOR_REAUTH_REQUIRED');
    return access;
  }

  /** Safe private health RPC. It refreshes within this owner but never returns the token. */
  async checkAuth(): Promise<AuthCheck> {
    if (this.readAuthState() === 'reauth_required') return 'reauth_required';
    try {
      await this.resolveStoredAccess();
      return 'ready';
    } catch (error) {
      if (errorText(error).includes('executor_reauth_required') || requiresReauthentication(error)) {
        this.writeAuthState('reauth_required', 'oauth_refresh_rejected');
        return 'reauth_required';
      }
      return 'unavailable';
    }
  }

  /** Privileged RPC only. Never routed by the public HTTP handler. */
  async resolveAuth(): Promise<SubscriptionAccess> {
    const status = await this.checkAuth();
    if (status !== 'ready') {
      throw new Error(status === 'reauth_required' ? 'EXECUTOR_REAUTH_REQUIRED' : 'EXECUTOR_AUTH_UNAVAILABLE');
    }
    try {
      const access = await this.resolveStoredAccess();
      return { type: 'oauth', source: 'OAuth', access, expires: Date.now() + 60_000 };
    } catch (error) {
      if (requiresReauthentication(error) || errorText(error).includes('executor_reauth_required')) {
        this.writeAuthState('reauth_required', 'oauth_refresh_rejected');
        throw new Error('EXECUTOR_REAUTH_REQUIRED');
      }
      throw new Error('EXECUTOR_AUTH_UNAVAILABLE');
    }
  }

  private async statusResponse(): Promise<Response> {
    const configured = (await this.credentials.list()).some(({ providerId }) => providerId === 'openai');
    const reauthRequired = this.readAuthState() === 'reauth_required';
    return Response.json({ status: configured ? 'configured' : 'unconfigured', reauthRequired }, { headers: { 'cache-control': 'no-store' } });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!['/v1/credentials/import', '/v1/credentials/revoke', '/v1/credentials/status'].includes(url.pathname)) return reply(404, 'not_found');
    if (request.method !== 'POST') return reply(405, 'method_not_allowed');
    if (url.protocol !== 'https:' || url.search) return reply(400, 'https_required');
    const secret = this.env.CREDENTIAL_BOOTSTRAP_SECRET;
    if (typeof secret !== 'string' || secret.length < 32 || secret === this.env.REVIEW_HMAC_SECRET || secret === this.env.CREDENTIAL_ENCRYPTION_KEY) return reply(503, 'bootstrap_unavailable');
    const body = await readBoundedBody(request, 16 * 1024);
    if (!body) return reply(413, 'request_too_large');
    if (!(await verifyRequest(secret, request, body))) return reply(401, 'unauthorized');
    const nonce = request.headers.get('x-executor-nonce');
    if (nonce === null) return reply(401, 'unauthorized');
    const inserted = this.ctx.storage.sql.exec('INSERT OR IGNORE INTO bootstrap_nonce(nonce) VALUES (?) RETURNING nonce', nonce).toArray();
    if (inserted.length !== 1) return reply(409, 'replayed_request');
    try {
      if (url.pathname.endsWith('/import')) {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
        if (value?.provider !== 'openai') return reply(400, 'invalid_credential');
        try { validateCredential(value.credential, true); } catch { return reply(400, 'invalid_credential'); }
        await this.credentials.modify('openai', async () => value.credential);
        this.writeAuthState('ready', null);
      } else if (url.pathname.endsWith('/revoke')) {
        await this.credentials.delete('openai');
        this.writeAuthState('reauth_required', 'operator_revoked');
      } else if (url.pathname.endsWith('/status')) {
        return this.statusResponse();
      }
      return this.statusResponse();
    } catch {
      return reply(503, 'credential_operation_failed');
    }
  }
}
