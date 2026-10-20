import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { signRequest } from '../src/auth.ts';
import { validateCredential } from '../src/credentials.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function installationId() {
  // This app's nonsecret configuration only. Never read Pi/Codex credential files.
  const dir = join(homedir(), '.config', 'executor-review-worker');
  const path = join(dir, 'installation.json');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try { await writeFile(path, JSON.stringify({ deviceId: crypto.randomUUID() }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const { deviceId } = JSON.parse(await readFile(path, 'utf8'));
  if (!uuid.test(deviceId)) throw Error('Invalid installation configuration');
  return deviceId;
}

// No echo for any input, including the separate bootstrap secret. Nothing is
// read from argv/env for secrets and no shell/clipboard/auth-store is consulted.
function hiddenPrompt(message, signal) {
  if (!process.stdin.isTTY) throw Error('An interactive terminal is required');
  signal?.throwIfAborted();
  process.stderr.write(message + ': ');
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = process.stdin.isRaw;
    const done = error => {
      process.stdin.off('data', data); signal?.removeEventListener('abort', aborted);
      process.stdin.setRawMode(wasRaw); process.stdin.pause(); process.stderr.write('\n');
      if (error) reject(Error('Input cancelled')); else resolve(value);
    };
    const aborted = () => done(true);
    const data = chunk => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') { done(true); return; }
        if (char === '\r' || char === '\n') { done(); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.on('data', data); signal?.addEventListener('abort', aborted, { once: true });
  });
}
async function officialLogin(options) {
  registerBunOAuthFlows();
  const models = createModels({ credentials: new InMemoryCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(openaiProvider());
  // models.login writes only to the isolated in-memory store above.
  return models.login('openai', 'oauth', {
    prompt: p => hiddenPrompt(p.message, p.signal),
    notify: event => {
      if (event.type === 'auth_url') process.stderr.write('Open this official sign-in URL in your browser:\n' + event.url + '\n');
    },
  }, options);
}

async function availableAccountModels(accessToken, fetchImpl, supportedSlugs) {
  if (typeof accessToken !== 'string' || accessToken.length === 0)
    throw Error('Invalid OAuth access token');
  const response = await fetchImpl('https://api.openai.com/v1/models', {
    method: 'GET',
    redirect: 'error',
    cache: 'no-store',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw Error('Model catalog request failed');
  const value = await response.json();
  if (!value || !Array.isArray(value.models)) throw Error('Invalid model catalog');
  const seen = new Set();
  const usable = [];
  for (const model of value.models) {
    if (!model || typeof model !== 'object' || model.visibility !== 'list') continue;
    const slug = model.slug;
    if (typeof slug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(slug) || !supportedSlugs.has(slug) || seen.has(slug)) continue;
    seen.add(slug);
    const displayName = typeof model.display_name === 'string'
      ? model.display_name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim().slice(0, 120)
      : '';
    usable.push({ slug, displayName: displayName || slug });
  }
  if (usable.length === 0) throw Error('No account-listed model is supported by the installed Pi OpenAI provider');
  return usable;
}

export async function bootstrap(origin, injected = {}) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('A bare HTTPS Worker origin is required');
  const deviceId = injected.deviceId ?? await installationId();
  if (!uuid.test(deviceId)) throw Error('Invalid installation configuration');
  const secret = await (injected.promptSecret ?? (() => hiddenPrompt('Credential bootstrap secret')))();
  if (typeof secret !== 'string' || secret.length < 32) throw Error('Invalid bootstrap secret');
  let credential;
  try {
    try {
      credential = await (injected.login ?? officialLogin)({ getDeviceId: () => deviceId, agentName: 'executor-dependabot-review' });
      validateCredential(credential, true);
    } catch {
      throw Error('Official ChatGPT login failed');
    }
    const fetchImpl = injected.fetch ?? fetch;
    let models;
    try {
      const supportedSlugs = new Set(openaiProvider().getModels().map(model => model.id));
      models = await availableAccountModels(credential.access, fetchImpl, supportedSlugs);
    } catch (error) {
      if (error instanceof Error && error.message === 'No account-listed model is supported by the installed Pi OpenAI provider') {
        throw Error('No account-listed model is supported by the installed Pi OpenAI provider; credential was not imported');
      }
      throw Error('Account model catalog verification failed; credential was not imported');
    }
    try {
      const path = '/v1/credentials/import';
      const body = JSON.stringify({ provider: 'openai', credential });
      const signed = await signRequest(secret, 'POST', path, new TextEncoder().encode(body));
      const response = await fetchImpl(url.origin + path, {
        method: 'POST', redirect: 'error', body,
        headers: { 'content-type': 'application/json', 'x-executor-timestamp': signed.timestamp, 'x-executor-nonce': signed.nonce, 'x-executor-signature': signed.signature },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status !== 200 || (await response.json()).status !== 'configured') throw Error();
    } catch {
      // Do not print provider errors or HTTP response bodies: they may contain secrets.
      throw Error('Credential import failed');
    }
    return models;
  } finally { credential = undefined; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) { process.stderr.write('Usage: node --experimental-strip-types scripts/bootstrap.mjs https://WORKER\n'); process.exitCode = 1; }
  else {
    try {
      const models = await bootstrap(process.argv[2]);
      process.stderr.write('Authenticated models supported by this Pi installation (visibility=list):\n');
      for (const model of models) process.stderr.write(`- ${model.displayName} (${model.slug})\n`);
      process.stderr.write('Credential imported. Set OPENAI_MODEL only to a slug shown above. This process will now exit.\n');
    }
    catch (error) {
      const message = error instanceof Error && /^(Official ChatGPT login failed|Account model catalog verification failed; credential was not imported|No account-listed model is supported by the installed Pi OpenAI provider; credential was not imported|Credential import failed)$/.test(error.message)
        ? error.message
        : 'Setup failed; no credential details will be printed.';
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  }
}
