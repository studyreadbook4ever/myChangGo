import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { authorizeOperator, receiveWebhook, receiverData, signPayload } from '../lib/receiver.ts';

const secret = 'receiver-test-secret-with-at-least-32-characters';
const now = Date.now();

function store() {
  const rows = new Map();
  return {
    rows,
    async insertIfAbsent(event) { if (rows.has(event.eventId)) return false; rows.set(event.eventId, event); return true; },
    async get(eventId) { return rows.get(eventId); },
    async list() { return [...rows.values()]; },
  };
}

function service(overrides = {}) {
  return {
    schemaVersion: '1.0', eventId: 'evt-service-1', type: 'service.requested', target: 'kitchen', timestamp: new Date(now).toISOString(),
    data: { id: 'svc-1', sessionId: 'session-1', table: '07', language: 'en', naturalLanguage: '  Water, please.\nNo ice.  ', status: 'requested', createdAt: new Date(now).toISOString() },
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    schemaVersion: '1.0', eventId: 'evt-order-1', type: 'order.created', target: 'kitchen', timestamp: new Date(now).toISOString(),
    data: { schemaVersion: '1.0', id: 'ord-1', eventId: 'domain-order-1', sessionId: 'session-1', table: '07', language: 'ko', items: [{ itemId: 'bibimbap', name: '계절 비빔밥', quantity: 2, unitPrice: 11000, lineTotal: 22000 }], total: 22000, currency: 'KRW', customerApproved: true, approvedAt: new Date(now).toISOString(), createdAt: new Date(now).toISOString() },
    ...overrides,
  };
}

async function request(event, overrides = {}) {
  const body = typeof event === 'string' ? event : JSON.stringify(event);
  return new Request('https://private.example.com/api/webhooks/orders', {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'x-kiosk-signature': await signPayload(body, secret), ...overrides },
  });
}

test('WebCrypto signature is byte-for-byte compatible with the kiosk Node HMAC', async () => {
  const body = JSON.stringify(service());
  assert.equal(await signPayload(body, secret), 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'));
});

test('raw natural-language service text persists exactly; Korean translation is optional', async () => {
  const db = store();
  const event = service();
  const response = await receiveWebhook(await request(event), { secret, store: db, now });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).accepted, true);
  const board = receiverData(await db.list());
  assert.equal(board.serviceRequests[0].naturalLanguage, event.data.naturalLanguage);
  assert.equal(board.serviceRequests[0].koreanText, undefined);
  assert.equal(board.deliveries[0].sourceId, event.data.id);
  assert.equal(board.deliveries[0].status, 'delivered');
});

test('concurrent retries insert one event; refreshed timestamp is idempotent', async () => {
  const db = store();
  const event = order();
  const responses = await Promise.all(Array.from({ length: 5 }, async () => receiveWebhook(await request(event), { secret, store: db, now })));
  assert.equal(responses.filter((response) => response.status === 202).length, 1);
  assert.equal(db.rows.size, 1);
  const refreshed = { ...event, timestamp: new Date(now + 1000).toISOString() };
  const retry = await receiveWebhook(await request(refreshed), { secret, store: db, now: now + 1000 });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  assert.equal(db.rows.size, 1);
});

test('same event ID with different content or target returns409 and preserves original', async () => {
  const db = store();
  const event = service();
  await receiveWebhook(await request(event), { secret, store: db, now });
  for (const changed of [{ ...event, target: 'robot' }, { ...event, data: { ...event.data, naturalLanguage: 'Something different.' } }]) {
    const response = await receiveWebhook(await request(changed), { secret, store: db, now });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'EVENT_ID_CONFLICT');
  }
  assert.equal(JSON.parse(db.rows.get(event.eventId).payload).data.naturalLanguage, event.data.naturalLanguage);
});

test('modified wire bytes, expired/future timestamps, invalid totals and unapproved orders are rejected', async () => {
  const db = store();
  const event = order();
  const changedBytes = JSON.stringify(event) + ' ';
  const tampered = new Request('https://private.example.com/api/webhooks/orders', { method: 'POST', body: changedBytes, headers: { 'content-type': 'application/json', 'x-kiosk-signature': await signPayload(JSON.stringify(event), secret) } });
  assert.equal((await receiveWebhook(tampered, { secret, store: db, now })).status, 401);
  for (const timestamp of [new Date(now - 300001).toISOString(), new Date(now + 30001).toISOString()]) {
    const response = await receiveWebhook(await request({ ...event, timestamp }), { secret, store: db, now });
    assert.equal((await response.json()).code, 'EXPIRED_EVENT');
  }
  for (const changed of [{ ...event, data: { ...event.data, total: 1 } }, { ...event, data: { ...event.data, customerApproved: false } }]) {
    assert.equal((await receiveWebhook(await request(changed), { secret, store: db, now })).status, 400);
  }
  assert.equal(db.rows.size, 0);
});

test('input is bounded before persistence and missing configuration fails closed', async () => {
  const db = store();
  const tooLarge = ' '.repeat(256 * 1024 + 1);
  const response = await receiveWebhook(await request(tooLarge), { secret, store: db, now });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'PAYLOAD_TOO_LARGE');
  assert.equal((await receiveWebhook(await request(service()), { secret: undefined, store: db, now })).status, 503);
  assert.equal((await receiveWebhook(await request('{bad json'), { secret, store: db, now })).status, 400);
  assert.equal((await receiveWebhook(await request(service(), { 'content-type': 'text/plain' }), { secret, store: db, now })).status, 415);
  assert.equal(db.rows.size, 0);
});

test('storage failures never acknowledge receipt or expose customer text', async () => {
  const event = service();
  const db = { ...store(), async insertIfAbsent() { throw new Error('Private database details ' + event.data.naturalLanguage); } };
  const response = await receiveWebhook(await request(event), { secret, store: db, now });
  assert.equal(response.status, 503);
  const data = await response.json();
  assert.equal(data.accepted, undefined);
  assert.equal(JSON.stringify(data).includes(event.data.naturalLanguage), false);
});

test('operator token or private-owner identity is required for order reads', async () => {
  const token = 'operator-token-long-enough-for-production';
  assert.equal(await authorizeOperator(null, token, false), false);
  assert.equal(await authorizeOperator('Bearer wrong-token', token, false), false);
  assert.equal(await authorizeOperator('Bearer ' + token, token, false), true);
  assert.equal(await authorizeOperator(null, token, true), true);
  assert.equal(await authorizeOperator('Bearer ', undefined, false), false);
});

test('two target receipts show one approved order with both actual deliveries', async () => {
  const db = store();
  const kitchen = order();
  const robot = { ...kitchen, eventId: 'evt-order-robot', target: 'robot' };
  for (const event of [kitchen, robot]) await receiveWebhook(await request(event), { secret, store: db, now });
  const board = receiverData(await db.list());
  assert.equal(board.orders.length, 1);
  assert.equal(board.events.length, 2);
  assert.deepEqual(new Set(board.deliveries.map((delivery) => delivery.target)), new Set(['kitchen', 'robot']));
});

test('generated D1 migration enforces unique event IDs with an atomic insert', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
    for (const entry of journal.entries) db.exec(readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
    const insert = db.prepare('INSERT INTO received_events (event_id, source_id, type, target, payload_hash, payload, received_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING RETURNING event_id');
    const values = ['evt-1', 'svc-1', 'service.requested', 'kitchen', 'hash-original', '{}', new Date(now).toISOString()];
    assert.equal(insert.all(...values).length, 1);
    assert.equal(insert.all('evt-1', 'svc-2', 'service.requested', 'robot', 'hash-conflict', '{}', values[6]).length, 0);
    const row = db.prepare('SELECT * FROM received_events WHERE event_id = ?').get('evt-1');
    assert.equal(row.payload_hash, 'hash-original');
    assert.equal(row.target, 'kitchen');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM received_events').get().n, 1);
  } finally { db.close(); }
});
