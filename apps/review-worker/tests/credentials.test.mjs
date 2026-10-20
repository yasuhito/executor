import assert from 'node:assert/strict';
import test from 'node:test';
import { EncryptedCredentialStore, validateCredential } from '../src/credentials.ts';

const key = btoa('0123456789abcdef0123456789abcdef');
const fixture = () => ({ type: 'oauth', access: 'fake-access', refresh: 'fake-refresh', clientId: 'fake-issued-client', scopes: ['chatgpt.tokens.use.direct'], expires: Date.now() + 3600000 });
function setup() {
  let row; let fail = false;
  const backend = { read: () => row, write: value => { if (fail) throw Error('simulated save failure'); row = structuredClone(value); }, delete: () => { row = undefined; } };
  return { store: new EncryptedCredentialStore(backend, key), backend, row: () => row, fail: () => { fail = true; } };
}
test('complete rotated credentials are encrypted and survive reopening', async () => {
  const s = setup(); await s.store.modify('openai', async () => fixture());
  await s.store.modify('openai', async c => ({ ...c, access: 'fake-rotated-access', refresh: 'fake-rotated-refresh' }));
  const restored = await new EncryptedCredentialStore(s.backend, key).read('openai');
  assert.deepEqual([restored.access, restored.refresh, JSON.stringify(s.row()).includes('fake-'), s.row().nonce.length], ['fake-rotated-access', 'fake-rotated-refresh', false, 12]);
});
test('failed persistence preserves prior complete row', async () => {
  const s = setup(); const original = fixture(); await s.store.modify('openai', async () => original); s.fail();
  let rejected = false; try { await s.store.modify('openai', async c => ({ ...c, refresh: 'fake-rotated' })); } catch { rejected = true; }
  assert.deepEqual([rejected, await s.store.read('openai')], [true, original]);
});
test('reads and deletion wait for started refresh despite caller abort', async () => {
  const s = setup(); await s.store.modify('openai', async () => fixture());
  let release; const gate = new Promise(r => { release = r; }); const abort = new AbortController();
  let started; const begun = new Promise(r => { started = r; });
  const refresh = s.store.modify('openai', async c => { started(); await gate; return { ...c, refresh: 'fake-rotated' }; }, { signal: abort.signal });
  await begun; abort.abort(); const read = s.store.read('openai'); const deletion = s.store.delete('openai'); release(); await refresh;
  assert.deepEqual([(await read).refresh, await deletion, await s.store.list()], ['fake-rotated', undefined, []]);
});
test('cancelled waiter and rejected callback release the queue', async () => {
  const s = setup(); const abort = new AbortController(); abort.abort();
  await s.store.modify('openai', async () => { throw Error('callback'); }).catch(() => {});
  await s.store.read('openai', { signal: abort.signal }).catch(() => {});
  assert.equal(await s.store.modify('openai', async () => fixture()).then(c => c.type), 'oauth');
});
for (const [label, patch] of [['type', { type: 'api_key' }], ['scope', { scopes: [] }], ['client', { clientId: '' }], ['expiry', { expires: 0 }], ['api key', { access: 'sk-fake-never-valid' }]]) {
  test(`import rejects invalid ${label}`, () => { assert.throws(() => validateCredential({ ...fixture(), ...patch }, true)); });
}
test('ciphertext metadata/key tampering fails closed', async () => {
  const s = setup(); await s.store.modify('openai', async () => fixture()); s.row().version = 2;
  await assert.rejects(() => s.store.read('openai'));
});
test('cancelled waiter cannot invoke callback while started refresh persists', async () => {
  const s = setup(); await s.store.modify('openai', async () => fixture());
  let release; let started; let invoked = false;
  const gate = new Promise(r => { release = r; }); const begun = new Promise(r => { started = r; });
  const refresh = s.store.modify('openai', async c => { started(); await gate; return { ...c, access: 'fake-rotated' }; });
  await begun;
  const abort = new AbortController();
  const waiter = s.store.modify('openai', async () => { invoked = true; return fixture(); }, { signal: abort.signal }).then(() => false, () => true);
  abort.abort(); release(); await refresh;
  assert.deepEqual([await waiter, invoked, (await s.store.read('openai')).access], [true, false, 'fake-rotated']);
});
test('every replacement uses a new nonce and wrong encryption key fails closed', async () => {
  const s = setup(); await s.store.modify('openai', async () => fixture()); const previous = s.row().nonce;
  await s.store.modify('openai', async () => fixture());
  const wrong = new EncryptedCredentialStore(s.backend, btoa('fedcba9876543210fedcba9876543210'));
  const rejected = await wrong.read('openai').then(() => false, () => true);
  assert.deepEqual([JSON.stringify(previous) !== JSON.stringify(s.row().nonce), rejected], [true, true]);
});
