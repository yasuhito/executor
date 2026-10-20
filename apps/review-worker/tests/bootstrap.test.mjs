import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrap } from '../scripts/bootstrap.mjs';
import { verifyRequest } from '../src/auth.ts';
const fake = { type: 'oauth', access: 'fake-cli-access', refresh: 'fake-cli-refresh', expires: Date.now() + 3600000, clientId: 'fake-issued-client', scopes: ['chatgpt.tokens.use.direct'] };
const secret = 'fake-bootstrap-only-secret-0123456789';
test('CLI verifies the signed-in account model catalog before importing credentials', async () => {
  let importSignatureValid = false; let options;
  const requests = [];
  const models = await bootstrap('https://review.example', { deviceId: '550e8400-e29b-41d4-a716-446655440000', promptSecret: async () => secret, login: async opts => { options = opts; return fake; }, fetch: async (url, init) => {
    const parsed = new URL(url);
    requests.push({ method: init.method, path: parsed.pathname, authorization: init.headers.authorization, redirect: init.redirect, body: init.body !== undefined });
    if (url === 'https://api.openai.com/v1/models') {
      return Response.json({ models: [
        { slug: 'gpt-6.1-sol', visibility: 'list', display_name: 'GPT\u001b[31m 6.1 Sol' },
        { slug: 'gpt-6.1-sol', visibility: 'list', display_name: 'Duplicate' },
        { slug: 'invalid slug', visibility: 'list', display_name: 'Invalid slug' },
        { slug: 'future-account-model', visibility: 'list', display_name: 'Unsupported by installed SDK' },
        { slug: 'gpt-hidden', visibility: 'hide', display_name: 'Hidden' },
      ] });
    }
    if (url !== 'https://review.example/v1/credentials/import') throw Error('Unmatched URL');
    importSignatureValid = init.redirect === 'error' && await verifyRequest(secret, new Request(url, init), new TextEncoder().encode(init.body));
    return Response.json({ status: 'configured' });
  } });
  assert.deepEqual({ models, importSignatureValid, deviceId: options.getDeviceId(), agentName: options.agentName, requests }, {
    models: [{ slug: 'gpt-6.1-sol', displayName: 'GPT [31m 6.1 Sol' }], importSignatureValid: true, deviceId: '550e8400-e29b-41d4-a716-446655440000', agentName: 'executor-dependabot-review', requests: [
      { method: 'GET', path: '/v1/models', authorization: 'Bearer fake-cli-access', redirect: 'error', body: false },
      { method: 'POST', path: '/v1/credentials/import', authorization: undefined, redirect: 'error', body: true },
    ],
  });
});
test('CLI does not import credentials when the account catalog shape is invalid', async () => {
  const requests = [];
  let message;
  try {
    await bootstrap('https://review.example', { deviceId: crypto.randomUUID(), promptSecret: async () => secret, login: async () => fake, fetch: async (url, init) => {
      requests.push(`${init.method} ${new URL(url).pathname}`);
      return Response.json({ models: {} });
    } });
  } catch (error) { message = error.message; }
  assert.deepEqual({ message, requests }, {
    message: 'Account model catalog verification failed; credential was not imported',
    requests: ['GET /v1/models'],
  });
});
test('CLI does not import credentials when the authenticated account catalog is unavailable', async () => {
  const requests = [];
  let message;
  try {
    await bootstrap('https://review.example', { deviceId: crypto.randomUUID(), promptSecret: async () => secret, login: async () => fake, fetch: async (url, init) => {
      requests.push(`${init.method} ${new URL(url).pathname}`);
      return new Response('fake-sensitive-response', { status: 403 });
    } });
  } catch (error) { message = error.message; }
  assert.deepEqual({ message, requests }, {
    message: 'Account model catalog verification failed; credential was not imported',
    requests: ['GET /v1/models'],
  });
});
test('CLI does not import credentials when no account-listed model is supported by Pi', async () => {
  const requests = [];
  let message;
  try {
    await bootstrap('https://review.example', { deviceId: crypto.randomUUID(), promptSecret: async () => secret, login: async () => fake, fetch: async (url, init) => {
      requests.push(`${init.method} ${new URL(url).pathname}`);
      return Response.json({ models: [{ slug: 'future-account-model', visibility: 'list' }] });
    } });
  } catch (error) { message = error.message; }
  assert.deepEqual({ message, requests }, {
    message: 'No account-listed model is supported by the installed Pi OpenAI provider; credential was not imported',
    requests: ['GET /v1/models'],
  });
});
test('CLI rejects HTTP before login', async () => { await assert.rejects(() => bootstrap('http://review.example', { login: async () => { throw Error('Must not login'); } }), /HTTPS/); });
test('CLI hides an import redirect response after catalog verification', async () => {
  const requests = [];
  let message;
  try {
    await bootstrap('https://review.example', { deviceId: crypto.randomUUID(), promptSecret: async () => secret, login: async () => fake, fetch: async (url, init) => {
      requests.push({ method: init.method, url, redirect: init.redirect });
      if (url === 'https://api.openai.com/v1/models') {
        return Response.json({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list', display_name: 'GPT 6.1 Sol' }] });
      }
      return new Response('fake-sensitive-body', { status: 302, headers: { location: 'https://other.example' } });
    } });
  } catch (error) { message = error.message; }
  assert.deepEqual({ message, requests }, {
    message: 'Credential import failed',
    requests: [
      { method: 'GET', url: 'https://api.openai.com/v1/models', redirect: 'error' },
      { method: 'POST', url: 'https://review.example/v1/credentials/import', redirect: 'error' },
    ],
  });
});
test('CLI rejects catalog redirects without following them or importing credentials', async () => {
  const requests = [];
  let message;
  try {
    await bootstrap('https://review.example', { deviceId: crypto.randomUUID(), promptSecret: async () => secret, login: async () => fake, fetch: async (url, init) => {
      requests.push({ url, redirect: init.redirect });
      return new Response('fake-sensitive-body', { status: 302, headers: { location: 'https://other.example' } });
    } });
  } catch (error) { message = error.message; }
  assert.deepEqual({ message, requests }, {
    message: 'Account model catalog verification failed; credential was not imported',
    requests: [{ url: 'https://api.openai.com/v1/models', redirect: 'error' }],
  });
});
