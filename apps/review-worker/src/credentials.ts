import type { AuthOperationOptions, Credential, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai';

export interface EncryptedRow { version: number; nonce: number[]; ciphertext: number[] }
export interface CredentialBackend {
  read(): EncryptedRow | undefined;
  // One atomic SQLite statement; never wrap a network refresh in a transaction.
  write(row: EncryptedRow): void;
  delete(): void;
}
const metadata = new TextEncoder().encode('executor-review-credentials:v1:installation:openai');

export function validateCredential(value: unknown, importing = false): asserts value is OAuthCredential {
  const c = value as OAuthCredential | undefined;
  if (!c || c.type !== 'oauth' ||
      typeof c.access !== 'string' || !c.access.trim() || c.access.startsWith('sk-') ||
      typeof c.refresh !== 'string' || !c.refresh.trim() ||
      typeof c.clientId !== 'string' || !c.clientId.trim() ||
      !Array.isArray(c.scopes) || !c.scopes.includes('chatgpt.tokens.use.direct') ||
      !Number.isSafeInteger(c.expires) || c.expires <= 0 || (importing && c.expires <= Date.now())) {
    throw new Error('Invalid ChatGPT subscription credential');
  }
}

/** Single-owner store. Every operation joins the same provider queue, including reads.
 * Abort only prevents entry; once fn starts, rotation and persistence must finish. */
export class EncryptedCredentialStore implements CredentialStore {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly backend: CredentialBackend;
  private readonly secret: string | undefined;
  constructor(backend: CredentialBackend, secret: string | undefined) { this.backend = backend; this.secret = secret; }
  private queued<T>(provider: string, options: AuthOperationOptions | undefined, fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => {
      options?.signal?.throwIfAborted();
      if (provider !== 'openai') throw new Error('Unsupported credential provider');
      return fn();
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
  private async key() {
    if (typeof this.secret !== 'string') throw new Error('Invalid credential encryption binding');
    const bytes = Uint8Array.from(atob(this.secret), c => c.charCodeAt(0));
    if (bytes.length !== 32) throw new Error('Invalid credential encryption binding');
    return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  private async load(): Promise<Credential | undefined> {
    const row = this.backend.read();
    if (!row) return undefined;
    if (row.version !== 1 || row.nonce.length !== 12) throw new Error('Invalid credential metadata');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(row.nonce), additionalData: metadata }, await this.key(), new Uint8Array(row.ciphertext));
    const credential: unknown = JSON.parse(new TextDecoder().decode(plain));
    validateCredential(credential);
    return credential;
  }
  read(provider: string, options?: AuthOperationOptions) { return this.queued(provider, options, () => this.load()); }
  list(options?: AuthOperationOptions) {
    return this.queued('openai', options, async () => (await this.load()) ? [{ providerId: 'openai', type: 'oauth' as const }] : []);
  }
  modify(provider: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
    return this.queued(provider, options, async () => {
      const current = await this.load();
      const next = await fn(current);
      if (next === undefined) return current;
      validateCredential(next);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: metadata }, await this.key(), new TextEncoder().encode(JSON.stringify(next)));
      this.backend.write({ version: 1, nonce: [...nonce], ciphertext: [...new Uint8Array(ciphertext)] });
      return structuredClone(next);
    });
  }
  delete(provider: string, options?: AuthOperationOptions) {
    return this.queued(provider, options, async () => { this.backend.delete(); });
  }
}
