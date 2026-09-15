/** Local board library. Persistence never changes document identity or timestamps. */
import { validateDocument } from './engine.js';

const DATABASE = 'grimpan-v1';
const PREFIX = 'grimpan-v1:';
const BOARD_PREFIX = `${PREFIX}board:`;
const LAST_ID = `${PREFIX}lastId`;
const clone = (value) => structuredClone(value);

function failure(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}
function storageError(error) {
  if (error.code && typeof error.code === 'string') return error;
  if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED') return failure('Local storage is full. Export or share your board before removing saved work.', 'QUOTA_EXCEEDED', error);
  if (error.name === 'SecurityError' || error.name === 'NotAllowedError') return failure('Browser settings prevent saving boards on this device.', 'STORAGE_UNAVAILABLE', error);
  return failure(error.message || 'The board could not be saved on this device.', 'STORAGE_ERROR', error);
}
function checkedId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw failure('Invalid board ID.', 'INVALID_ID');
  return id;
}
function sorted(documents) {
  return documents.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
}

function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    let request;
    try { request = indexedDB.open(DATABASE, 1); } catch (error) { reject(error); return; }
    let rejected = false;
    const stop = (error) => { rejected = true; reject(error); };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('boards')) db.createObjectStore('boards', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('prefs')) db.createObjectStore('prefs');
    };
    request.onerror = () => stop(request.error || failure('Cannot open the local board library.', 'STORAGE_UNAVAILABLE'));
    request.onblocked = () => stop(failure('Another open tab is blocking the local board library.', 'STORAGE_BLOCKED'));
    request.onsuccess = () => {
      if (rejected) { request.result.close(); return; }
      resolve(request.result);
    };
  });
}

function indexedDriver(db) {
  let closed = false;
  db.onversionchange = () => { closed = true; db.close(); };
  function transaction(store, mode, action) {
    return new Promise((resolve, reject) => {
      if (closed) { reject(failure('This board library connection is closed. Reload to reconnect.', 'STORAGE_CLOSED')); return; }
      let tx, request, result;
      try { tx = db.transaction(store, mode); request = action(tx.objectStore(store)); }
      catch (error) { reject(storageError(error)); return; }
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => { /* The transaction abort is the authoritative failure. */ };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(storageError(tx.error || request.error || failure('The local save was aborted.', 'STORAGE_ABORTED')));
      tx.onerror = () => { /* Wait for onabort, rather than reporting a save before commit. */ };
    });
  }
  return {
    mode: 'indexeddb', degraded: false, message: '', get available() { return !closed; },
    save: (document) => transaction('boards', 'readwrite', (store) => store.put(document)),
    get: (id) => transaction('boards', 'readonly', (store) => store.get(id)),
    list: () => transaction('boards', 'readonly', (store) => store.getAll()),
    remove: (id) => transaction('boards', 'readwrite', (store) => store.delete(id)),
    getLastId: () => transaction('prefs', 'readonly', (store) => store.get('lastId')),
    setLastId: (id) => transaction('prefs', 'readwrite', (store) => id === null ? store.delete('lastId') : store.put(id, 'lastId')),
    close() { closed = true; db.close(); },
  };
}

function localDriver(storage, reason) {
  // This probe confirms writes really work; it never replaces an existing key.
  let probe = `${PREFIX}probe:${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  while (storage.getItem(probe) !== null) probe += '_';
  storage.setItem(probe, '1');
  storage.removeItem(probe);
  const parse = (value) => {
    if (value === null) return undefined;
    try { return JSON.parse(value); } catch (error) { throw failure('A saved board is damaged. Its stored data has been preserved.', 'CORRUPT_BOARD', error); }
  };
  return {
    mode: 'localStorage', available: true, degraded: true,
    message: 'Using limited local browser storage because IndexedDB is unavailable. Existing IndexedDB boards are not included in this library.',
    reason,
    save(document) { storage.setItem(`${BOARD_PREFIX}${document.id}`, JSON.stringify(document)); },
    get: (id) => parse(storage.getItem(`${BOARD_PREFIX}${id}`)),
    list() {
      const keys = [];
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key?.startsWith(BOARD_PREFIX)) keys.push(key);
      }
      return keys.map((key) => parse(storage.getItem(key))).filter((document) => document !== undefined);
    },
    remove: (id) => storage.removeItem(`${BOARD_PREFIX}${id}`),
    getLastId: () => storage.getItem(LAST_ID),
    setLastId(id) { if (id === null) storage.removeItem(LAST_ID); else storage.setItem(LAST_ID, id); },
    close() {},
  };
}

/** Calls are asynchronous for both storage backends; writes commit in call order. */
export async function createStorage() {
  let driver, reason;
  try {
    if (!globalThis.indexedDB) throw failure('IndexedDB is unavailable in this browser.', 'STORAGE_UNAVAILABLE');
    driver = indexedDriver(await openDatabase(globalThis.indexedDB));
  } catch (error) { reason = storageError(error); }
  if (!driver) {
    try {
      if (!globalThis.localStorage) throw failure('Local storage is unavailable in this browser.', 'STORAGE_UNAVAILABLE');
      driver = localDriver(globalThis.localStorage, reason);
    } catch (error) {
      reason = storageError(error);
      driver = { mode: 'unavailable', available: false, degraded: true, message: 'Boards cannot be saved on this device. Export or share your work to keep it.', reason, close() {} };
    }
  }
  let closed = false;
  let writes = Promise.resolve();
  function requireAvailable() {
    if (closed) throw failure('The board library is closed.', 'STORAGE_CLOSED');
    if (!driver.available) throw failure(driver.message || 'The board library is unavailable.', 'STORAGE_UNAVAILABLE', driver.reason);
  }
  function write(action) {
    const next = writes.then(async () => {
      requireAvailable();
      try { return await action(); } catch (error) { throw storageError(error); }
    });
    writes = next.catch(() => {});
    return next;
  }
  async function read(action, fallback) {
    await writes;
    if (closed) throw failure('The board library is closed.', 'STORAGE_CLOSED');
    if (!driver.available) return fallback;
    try { return await action(); } catch (error) { throw storageError(error); }
  }
  function documentFromStorage(value, expectedId) {
    if (value === undefined) return null;
    try {
      const document = validateDocument(value);
      if (expectedId && document.id !== expectedId) throw new Error('The saved board ID does not match its library entry.');
      return document;
    } catch (error) { throw failure('A saved board is invalid. Its stored data has been preserved.', 'CORRUPT_BOARD', error); }
  }
  return {
    get available() { return !closed && driver.available; },
    mode: driver.mode, degraded: driver.degraded, message: driver.message,
    async save(input) {
      // Validate before entering the queue so later caller edits cannot change this save.
      const document = validateDocument(input);
      return write(async () => { await driver.save(clone(document)); return clone(document); });
    },
    async get(id) { id = checkedId(id); return read(async () => documentFromStorage(await driver.get(id), id), null); },
    async list() { return read(async () => sorted((await driver.list()).map((document) => documentFromStorage(document))), []); },
    async remove(id) { id = checkedId(id); return write(() => driver.remove(id)); },
    async getLastId() {
      return read(async () => {
        const id = await driver.getLastId();
        if (id === undefined || id === null) return null;
        return checkedId(id);
      }, null);
    },
    async setLastId(id) { if (id !== null) id = checkedId(id); return write(() => driver.setLastId(id)); },
    close() { closed = true; driver.close(); },
  };
}
