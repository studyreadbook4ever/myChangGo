import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createEngine } from '../engine.js';
import { createStorage } from '../storage.js';
import { snapshotHash } from '../share.js';

// Exercise the real localStorage backend contract. IndexedDB transaction behavior
// is covered by browser integration rather than a permissive fake IndexedDB.
class LocalStore {
  values = new Map();
  quota = Infinity;
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(String(key)) ?? null; }
  setItem(key, value) {
    key = String(key); value = String(value);
    const size = [...this.values].filter(([item]) => item !== key).reduce((sum, [item, data]) => sum + item.length + data.length, 0) + key.length + value.length;
    if (size > this.quota) throw new DOMException('Full', 'QuotaExceededError');
    this.values.set(key, value);
  }
  removeItem(key) { this.values.delete(String(key)); }
}

async function withLocal(run, storage = new LocalStore()) {
  const descriptors = ['indexedDB', 'localStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.defineProperty(globalThis, 'indexedDB', { value: undefined, writable: true, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true, configurable: true });
  try { await run(storage); }
  finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test('fallback declares degraded mode and preserves identity, timestamp and snapshot hash', async () => {
  await withLocal(async () => {
    const storage = await createStorage();
    assert.equal(storage.available, true);
    assert.equal(storage.mode, 'localStorage');
    assert.equal(storage.degraded, true);
    assert.match(storage.message, /IndexedDB/);
    const document = createDocument({ title: '영구 저장 🌿', author: '원작자' });
    const hash = await snapshotHash(document);
    assert.deepEqual(await storage.save(document), document);
    const restored = await storage.get(document.id);
    assert.deepEqual(restored, document);
    assert.equal(await snapshotHash(restored), hash);
    storage.close();
  });
});

test('concurrent saves commit in order and caller changes do not mutate queued writes', async () => {
  await withLocal(async () => {
    const storage = await createStorage();
    const original = createDocument({ title: 'First' });
    const second = { ...structuredClone(original), title: 'Second', revision: 1 };
    const firstSave = storage.save(original);
    original.title = 'Unexpected';
    const secondSave = storage.save(second);
    second.title = 'Unexpected too';
    await Promise.all([firstSave, secondSave]);
    assert.equal((await storage.get(original.id)).title, 'Second');
    assert.equal((await storage.get(original.id)).revision, 1);
  });
});

test('library sorts full documents by engine timestamps and preferences survive reopen', async () => {
  await withLocal(async () => {
    let storage = await createStorage();
    const old = createDocument({ title: 'Older' });
    old.updatedAt = '2025-01-01T00:00:00.000Z';
    const recent = createDocument({ title: 'Recent' });
    recent.updatedAt = '2026-01-01T00:00:00.000Z';
    await storage.save(recent); await storage.save(old);
    await storage.setLastId(recent.id);
    storage.close();
    storage = await createStorage();
    assert.deepEqual(await storage.list(), [recent, old]);
    assert.equal(await storage.getLastId(), recent.id);
    await storage.remove(recent.id);
    assert.deepEqual(await storage.list(), [old]);
    assert.equal(await storage.get(recent.id), null);
    await storage.setLastId(null);
    assert.equal(await storage.getLastId(), null);
  });
});

test('quota failure preserves prior save and other boards, with no silent eviction', async () => {
  await withLocal(async (backend) => {
    const storage = await createStorage();
    const original = createDocument({ title: 'Saved' });
    const other = createDocument({ title: 'Keep me too' });
    await storage.save(original); await storage.save(other);
    backend.quota = [...backend.values].reduce((sum, [key, value]) => sum + key.length + value.length, 0);
    const engine = createEngine(original);
    engine.execute({ type: 'create', object: { type: 'text', text: 'New content'.repeat(100) } });
    await assert.rejects(storage.save(engine.getDocument()), (error) => error.code === 'QUOTA_EXCEEDED');
    assert.deepEqual(await storage.get(original.id), original);
    assert.deepEqual(await storage.get(other.id), other);
    backend.quota = Infinity;
    await storage.save(engine.getDocument());
    assert.equal((await storage.get(original.id)).objects.length, 1);
  });
});

test('unavailable persistence is explicit and all mutations reject', async () => {
  const blocked = new LocalStore();
  blocked.quota = 0;
  await withLocal(async () => {
    const storage = await createStorage();
    assert.equal(storage.available, false);
    assert.equal(storage.mode, 'unavailable');
    assert.deepEqual(await storage.list(), []);
    assert.equal(await storage.getLastId(), null);
    const document = createDocument();
    await assert.rejects(storage.save(document), (error) => error.code === 'STORAGE_UNAVAILABLE');
    await assert.rejects(storage.setLastId(document.id), (error) => error.code === 'STORAGE_UNAVAILABLE');
    await assert.rejects(storage.remove(document.id), (error) => error.code === 'STORAGE_UNAVAILABLE');
  }, blocked);
});

test('damaged data stays intact and cannot be mistaken for an empty board', async () => {
  await withLocal(async (backend) => {
    const storage = await createStorage();
    backend.setItem('grimpan-v1:board:board_bad', '{damaged');
    await assert.rejects(storage.get('board_bad'), (error) => error.code === 'CORRUPT_BOARD');
    await assert.rejects(storage.list(), (error) => error.code === 'CORRUPT_BOARD');
    assert.equal(backend.getItem('grimpan-v1:board:board_bad'), '{damaged');
    backend.setItem('grimpan-v1:board:board_null', 'null');
    await assert.rejects(storage.get('board_null'), (error) => error.code === 'CORRUPT_BOARD');
    assert.equal(await storage.get('missing'), null);
  });
});
