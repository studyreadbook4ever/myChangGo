import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { RECEIPT_SOURCE_LIMIT, recentReceiptsQuery } from '../lib/receipt-window.ts';
import { receiverData } from '../lib/receiver.ts';

function database(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const journal = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) db.exec(readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  return db;
}

const iso = (seconds) => new Date(Date.UTC(2026, 9, 22) + seconds * 1000).toISOString();

function insert(db, sourceId, target, seconds, eventId = `${sourceId}-${target}`, createdSeconds = seconds) {
  const event = {
    schemaVersion: '1.0', eventId, type: 'service.requested', target, timestamp: iso(seconds),
    data: { id: sourceId, sessionId: 'session', table: '07', language: 'en', naturalLanguage: `  ${sourceId}\nWater, please.  `, status: 'requested', createdAt: iso(createdSeconds) },
  };
  db.prepare('INSERT INTO received_events (event_id, source_id, type, target, payload_hash, payload, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(eventId, sourceId, event.type, target, `hash-${eventId}`, JSON.stringify(event), iso(seconds));
}

// Compile the same Drizzle query used by the production D1 store, then execute
// it against the generated SQLite migration rather than a simulated filter.
function list(db) {
  const query = new SQLiteSyncDialect().sqlToQuery(recentReceiptsQuery);
  return db.prepare(query.sql).all(...query.params);
}

test('a recent source retains both receipts when its pair straddles the old 200-event cutoff', (t) => {
  const db = database(t);
  insert(db, 'svc-straddling', 'kitchen', 0);
  for (let index = 1; index <= 105; index += 1) {
    insert(db, `svc-${String(index).padStart(3, '0')}`, 'kitchen', index * 2);
    insert(db, `svc-${String(index).padStart(3, '0')}`, 'robot', index * 2 + 1);
  }
  insert(db, 'svc-straddling', 'robot', 1000, undefined, 0);
  const oldWindow = db.prepare('SELECT source_id, target FROM received_events ORDER BY received_at DESC, event_id DESC LIMIT 200').all();
  assert.deepEqual(oldWindow.filter((row) => row.source_id === 'svc-straddling').map((row) => row.target), ['robot']);

  const rows = list(db), board = receiverData(rows);
  assert.equal(rows.length, RECEIPT_SOURCE_LIMIT * 2);
  assert.equal(board.serviceRequests.length, RECEIPT_SOURCE_LIMIT);
  assert.equal(board.serviceRequests[0].id, 'svc-straddling');
  assert.deepEqual(new Set(board.deliveries.filter((row) => row.sourceId === 'svc-straddling').map((row) => row.target)), new Set(['kitchen', 'robot']));
  assert.equal(board.serviceRequests[0].naturalLanguage, '  svc-straddling\nWater, please.  ');
  assert.ok(board.serviceRequests.every((request) => board.deliveries.filter((row) => row.sourceId === request.id).length === 2));
  assert.equal(board.serviceRequests.at(-1).id, 'svc-007');
  assert.ok(!board.serviceRequests.some((request) => request.id === 'svc-006'));
});

test('source selection is ordered by latest receipt with deterministic ties and a 100-source limit', (t) => {
  const db = database(t);
  for (let index = 0; index < 102; index += 1) {
    insert(db, `svc-${String(index).padStart(3, '0')}`, 'kitchen', 10, undefined, 1000 - index);
  }
  insert(db, 'svc-000', 'robot', 20, undefined, 1000);
  const rows = list(db), board = receiverData(rows);
  const expected = ['svc-000', ...Array.from({ length: 99 }, (_, index) => `svc-${String(101 - index).padStart(3, '0')}`)];
  assert.deepEqual(board.serviceRequests.map((request) => request.id), expected);
  assert.equal(rows.length, 101);
  assert.equal(board.deliveries.filter((row) => row.sourceId === 'svc-000').length, 2);
  assert.equal(board.deliveries.filter((row) => row.sourceId === 'svc-101').length, 1);
});

test('extra event IDs for one target cannot displace the other target or exceed the bounded result', (t) => {
  const db = database(t);
  insert(db, 'svc-many', 'robot', 0);
  for (let index = 1; index <= 205; index += 1) insert(db, 'svc-many', 'kitchen', index, `evt-${index}`);
  insert(db, 'svc-many', 'kitchen', 205, 'evt-z-tie');
  insert(db, 'svc-other', 'robot', 10);
  const rows = list(db), board = receiverData(rows);
  assert.equal(rows.length, 3);
  assert.deepEqual(board.serviceRequests.map((request) => request.id), ['svc-many', 'svc-other']);
  const receipts = board.events.filter((event) => event.data.id === 'svc-many');
  assert.deepEqual(receipts.map((event) => event.eventId), ['evt-z-tie', 'svc-many-robot']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM received_events').get().count, 208);
});
