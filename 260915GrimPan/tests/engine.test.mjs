import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createDocument, createEngine, validateDocument, objectBounds, LIMITS } from '../engine.js';
import { encodeSnapshot, decodeSnapshot, snapshotHash, shareURL, forkDocument, resolveSource, prepareQuoteCommand } from '../share.js';

const rectangle = (overrides = {}) => ({ type: 'rect', x: 20, y: 30, width: 100, height: 70, stroke: '#123456', fill: '#fedcba', strokeWidth: 3, ...overrides });
function populated() {
  const engine = createEngine(createDocument({ title: '함께 그리는 우주 🌌', author: '지은 🎨' }));
  engine.execute({ type: 'create', object: rectangle() });
  engine.execute({ type: 'create', object: { type: 'text', x: 60, y: 70, text: '안녕하세요\nשלום <plain text>', fontSize: 28 } });
  return engine.getDocument();
}

test('one atomic agent batch is one undo step with source and monotonic revisions', () => {
  const engine = createEngine();
  const events = [];
  engine.subscribe((event) => events.push(event));
  const before = engine.getDocument();
  const result = engine.execute({ type: 'batch', commands: [
    { type: 'create', object: rectangle({ id: 'shape_a' }) },
    { type: 'move', ids: ['shape_a'], dx: 12, dy: -3 },
    { type: 'agent_pen', down: true, color: '#c026d3', width: 5 },
    { type: 'agent_move', dx: 30, dy: 0 },
  ] }, { actor: 'agent' });
  assert.equal(result.ok, true);
  assert.equal(engine.getDocument().objects.length, 2);
  assert.equal(engine.getHistory().length, 1);
  assert.equal(events[0].actor, 'agent');
  const undo = engine.undo();
  assert.equal(undo.originalActor, 'agent');
  assert.deepEqual(engine.getDocument().objects, before.objects);
  assert.deepEqual(engine.getDocument().agent, before.agent);
  assert.ok(undo.revision > result.revision);
  const redo = engine.redo();
  assert.ok(redo.revision > undo.revision);
  assert.equal(engine.getDocument().objects[0].x, 32);
  assert.equal(engine.getDocument().objects.length, 2);
});

test('invalid command midway through batch changes neither state nor history', () => {
  const engine = createEngine();
  const before = engine.getDocument();
  let notifications = 0;
  engine.subscribe(() => notifications++);
  const result = engine.execute({ type: 'batch', commands: [
    { type: 'create', object: rectangle({ id: 'temporary' }) },
    { type: 'move', ids: ['missing'], dx: 1, dy: 1 },
  ] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NOT_FOUND');
  assert.deepEqual(engine.getDocument(), before);
  assert.equal(engine.canUndo(), false);
  assert.equal(notifications, 0);
});

test('readonly source blocks mutation, undo and redo, and invalid load preserves source', () => {
  const engine = createEngine();
  const original = populated();
  assert.equal(engine.load(original, { readOnly: true }).ok, true);
  assert.equal(engine.isReadOnly(), true);
  for (const result of [engine.execute({ type: 'clear' }), engine.undo(), engine.redo()]) {
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'READ_ONLY');
  }
  assert.equal(engine.load({ schema: 'bad' }).ok, false);
  assert.deepEqual(engine.getDocument(), original);
  engine.load(original);
  assert.equal(engine.execute({ type: 'clear' }).ok, true);
});

test('returned documents and command inputs cannot mutate committed history', () => {
  const engine = createEngine();
  const object = rectangle();
  engine.execute({ type: 'create', object });
  object.x = 9999;
  engine.getDocument().objects[0].x = -9999;
  assert.equal(engine.getDocument().objects[0].x, 20);
  engine.undo(); engine.redo();
  assert.equal(engine.getDocument().objects[0].x, 20);
});

test('paths retain absolute coordinates while translating and calculating bounds', () => {
  const engine = createEngine();
  engine.execute({ type: 'create', object: { id: 'path_1', type: 'path', points: [[10, 20], [40, 80]], x: 0, y: 0 } });
  engine.execute({ type: 'move', ids: ['path_1'], dx: -3, dy: 5 });
  const path = engine.getDocument().objects[0];
  assert.equal(path.x, 0);
  assert.equal(path.y, 0);
  assert.deepEqual(path.points, [[7, 25], [37, 85]]);
  assert.deepEqual(objectBounds(path), { x: 7, y: 25, width: 30, height: 60 });
});

test('agent pen shares shape engine and does not draw while lifted', () => {
  const engine = createEngine();
  engine.execute({ type: 'agent_move', x: 10, y: 20 });
  assert.equal(engine.getDocument().objects.length, 0);
  engine.execute({ type: 'agent_pen', down: true, color: '#009900', width: 8 });
  engine.execute({ type: 'agent_move', dx: 0, dy: 50 });
  const document = engine.getDocument();
  assert.deepEqual(document.objects[0].points, [[10, 20], [10, 70]]);
  assert.equal(document.objects[0].stroke, '#009900');
  assert.equal(document.objects[0].strokeWidth, 8);
  assert.equal(document.agent.heading, 90);
  engine.execute({ type: 'agent_turn', angle: -90 });
  assert.equal(engine.getDocument().agent.heading, 270);
});

test('validation rejects unbounded data, unsafe types and unsafe color/source payloads', () => {
  const document = populated();
  for (const change of [{ x: Infinity }, { x: NaN }, { stroke: 'url(javascript:alert(1))' }, { type: 'html', text: '<script>' }]) {
    const invalid = structuredClone(document);
    Object.assign(invalid.objects[0], change);
    assert.throws(() => validateDocument(invalid));
  }
  const duplicate = structuredClone(document);
  duplicate.objects.push(duplicate.objects[0]);
  assert.throws(() => validateDocument(duplicate), /unique/);
  const oversized = createDocument();
  oversized.objects = Array.from({ length: 350 }, (_, index) => rectangle({ id: `object_${index}`, type: 'text', text: '한'.repeat(9999) }));
  assert.throws(() => validateDocument(oversized), /3 MiB/);
});

test('point limit applies across the full board with atomic rejection', () => {
  const engine = createEngine();
  const points = Array.from({ length: 60000 }, (_, i) => [i % 1000, i % 100]);
  assert.equal(engine.execute({ type: 'create', object: { type: 'path', points } }).ok, true);
  const before = engine.getDocument();
  assert.equal(engine.execute({ type: 'create', object: { type: 'path', points } }).ok, false);
  assert.deepEqual(engine.getDocument(), before);
});

test('compressed snapshot and portable URL preserve Unicode and exact document', async () => {
  const document = populated();
  const token = await encodeSnapshot(document);
  assert.match(token, /^[gj]1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeSnapshot(token), document);
  const url = await shareURL(document, 'https://example.test/board/?theme=dark#old');
  assert.equal(new URL(url).search, '');
  assert.deepEqual(await decodeSnapshot(new URL(url).hash.slice(7)), document);
});

test('uncompressed fallback roundtrips when browser compression is unavailable', async () => {
  const compression = globalThis.CompressionStream;
  try {
    globalThis.CompressionStream = undefined;
    const document = populated();
    const token = await encodeSnapshot(document);
    assert.ok(token.startsWith('j1.'));
    assert.deepEqual(await decodeSnapshot(token), document);
  } finally { globalThis.CompressionStream = compression; }
});

test('decoder rejects malformed input and a small compressed expansion bomb', async () => {
  for (const token of ['bad', 'g1.', 'j1.A', 'j1.___', 'g1.invalid']) await assert.rejects(decodeSnapshot(token));
  const bomb = gzipSync(Buffer.alloc(LIMITS.bytes + 1, 32)).toString('base64url');
  assert.ok(bomb.length < 10000);
  await assert.rejects(decodeSnapshot(`g1.${bomb}`), (error) => error.code === 'SNAPSHOT_TOO_LARGE');
});

test('fork retains exact original snapshot and gives copied objects new identities', async () => {
  const original = populated();
  const sourceHash = await snapshotHash(original);
  const fork = await forkDocument(original, { author: '새 작업자', selectionIds: [original.objects[0].id], sourceURL: await shareURL(original, 'https://example.test/') });
  assert.notEqual(fork.id, original.id);
  assert.notEqual(fork.objects[0].id, original.objects[0].id);
  assert.equal(fork.objects.length, 1);
  assert.equal(fork.provenance[0].sourceURL, 'https://example.test/');
  assert.deepEqual(resolveSource(fork, sourceHash), original);
  const engine = createEngine(fork);
  engine.execute({ type: 'clear' });
  assert.deepEqual(resolveSource(engine.getDocument(), sourceHash), original);
});

test('multiple fork generations flatten, verify, and reopen every exact ancestor', async () => {
  const first = populated();
  const second = await forkDocument(first, { author: '두 번째', sourceURL: 'https://example.test/' });
  const editor = createEngine(second);
  editor.execute({ type: 'create', object: rectangle({ fill: '#abcdef' }) });
  const editedSecond = editor.getDocument();
  const third = await forkDocument(editedSecond, { author: '세 번째', sourceURL: 'https://example.test/#board=g1.placeholder' });
  assert.equal(third.provenance.length, 2);
  for (const entry of third.provenance) for (const ancestor of entry.snapshot.provenance) assert.equal(ancestor.snapshot, undefined);
  const restored = await decodeSnapshot(await encodeSnapshot(third));
  assert.deepEqual(resolveSource(restored, await snapshotHash(first)), first);
  assert.deepEqual(resolveSource(restored, await snapshotHash(editedSecond)), editedSecond);
  const again = await forkDocument(resolveSource(restored, await snapshotHash(first)), { title: '원본에서 다시' });
  assert.equal(again.provenance.length, 1);
});

test('tampered quoted sources fail content integrity and nested source payloads fail validation', async () => {
  const fork = await forkDocument(populated());
  const tampered = structuredClone(fork);
  tampered.provenance[0].snapshot.objects[0].x += 1;
  await assert.rejects(encodeSnapshot(tampered), (error) => error.code === 'SOURCE_HASH_MISMATCH');
  const token = `j1.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}`;
  await assert.rejects(decodeSnapshot(token), (error) => error.code === 'SOURCE_HASH_MISMATCH');
  const nested = structuredClone(fork);
  nested.provenance[0].snapshot.provenance = [structuredClone(fork.provenance[0])];
  assert.throws(() => validateDocument(nested), /flattened/);
});

test('new edits after undo clear redo; no-op operations do not add history', () => {
  const engine = createEngine();
  engine.execute({ type: 'create', object: rectangle() });
  engine.undo();
  assert.equal(engine.canRedo(), true);
  engine.execute({ type: 'create', object: rectangle({ fill: '#aabbcc' }) });
  assert.equal(engine.canRedo(), false);
  const history = engine.getHistory().length;
  engine.execute({ type: 'batch', commands: [] });
  assert.equal(engine.getHistory().length, history);
});

test('rotated text uses its natural multiline extent when geometry is unspecified', () => {
  const bounds = objectBounds({ type: 'text', x: 10, y: 20, width: 0, height: 0, text: 'abcd\nef', fontSize: 20, rotation: 90 });
  assert.ok(Math.abs(bounds.x - 11) < 1e-9);
  assert.ok(Math.abs(bounds.y - 19) < 1e-9);
  assert.ok(Math.abs(bounds.width - 50) < 1e-9);
  assert.ok(Math.abs(bounds.height - 52) < 1e-9);
});

test('batch delete-all preserves original objects for one undo and reports each removed id', () => {
  const document = populated();
  const engine = createEngine(document);
  const result = engine.execute({ type: 'batch', commands: document.objects.map((object) => ({ type: 'delete', ids: [object.id] })) }, { actor: 'agent' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changedIds, document.objects.map((object) => object.id));
  assert.equal(engine.getDocument().objects.length, 0);
  engine.undo();
  assert.deepEqual(engine.getDocument().objects, document.objects);
});

function storyBoard() {
  const engine = createEngine(populated());
  engine.execute({ type: 'reaction_toggle', emoji: '💡', author: '준' });
  engine.execute({ type: 'frame_add', frame: { title: '첫 장면', description: '작은 영역의 이야기', x: 30, y: 40, width: 40, height: 30 } });
  engine.execute({ type: 'frame_add', frame: { title: '전체', x: 0, y: 0, width: 600, height: 500 } });
  return engine.getDocument();
}

test('legacy snapshot links and their source hashes survive optional collection upgrades', async () => {
  const legacy = { schema: 'grimpan/1', id: 'board_legacy', title: 'Legacy', author: 'Original', revision: 0, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z', objects: [], agent: { x: 160, y: 160, heading: 0, penDown: false, color: '#2563eb', width: 4 }, provenance: [] };
  // Content ID emitted by the original grimpan/1 format.
  const originalHash = 'a8c37224c20084f7a9945751632201694d2384ee9064dd9202b5e03f864df442';
  assert.equal(await snapshotHash(legacy), originalHash);
  const legacyFork = structuredClone(legacy);
  legacyFork.id = 'board_legacy_fork';
  legacyFork.provenance = [{ sourceHash: originalHash, title: legacy.title, author: legacy.author, createdAt: legacy.createdAt, sourceURL: '', snapshot: legacy }];
  const token = `j1.${Buffer.from(JSON.stringify(legacyFork)).toString('base64url')}`;
  const decoded = await decodeSnapshot(token);
  assert.deepEqual(decoded.reactions, []);
  assert.deepEqual(decoded.frames, []);
  assert.equal(await snapshotHash(resolveSource(decoded, originalHash)), originalHash);
});

test('reactions and story frames share atomic undo history', () => {
  const engine = createEngine();
  const first = engine.execute({ type: 'frame_add', frame: { title: '첫 장면', x: 0, y: 0, width: 200, height: 100 } });
  assert.ok(first.frameId);
  const before = engine.getDocument();
  const result = engine.execute({ type: 'batch', commands: [
    { type: 'frame_update', id: first.frameId, changes: { title: '첫 장면 수정', width: 250 } },
    { type: 'reaction_toggle', emoji: '👍', author: '에이전트' },
    { type: 'frame_add', frame: { title: '설명', x: 20, y: 20, width: 300, height: 200 } },
  ] }, { actor: 'agent' });
  assert.equal(result.ok, true);
  assert.ok(result.frameId);
  assert.equal(engine.getDocument().frames.length, 2);
  assert.equal(engine.getDocument().frames[0].width, 250);
  assert.equal(engine.getDocument().reactions.length, 1);
  engine.undo();
  for (const key of ['reactions', 'frames']) assert.deepEqual(engine.getDocument()[key], before[key]);
  engine.redo();
  assert.equal(engine.getDocument().frames[0].description, '');
  engine.execute({ type: 'reaction_toggle', emoji: '👍', author: '에이전트' });
  assert.equal(engine.getDocument().reactions.length, 0);
  engine.execute({ type: 'frame_delete', id: first.frameId });
  assert.equal(engine.getDocument().frames.length, 1);
  engine.undo();
  assert.equal(engine.getDocument().frames[0].id, first.frameId);
});

test('frame limits, IDs and reaction choices are validated before commit', () => {
  const engine = createEngine();
  const before = engine.getDocument();
  assert.equal(engine.execute({ type: 'batch', commands: [
    { type: 'frame_add', frame: { title: 'Temporary', x: 0, y: 0, width: 100, height: 100 } },
    { type: 'reaction_toggle', emoji: '<script>', author: 'A' },
  ] }).ok, false);
  assert.deepEqual(engine.getDocument(), before);
  const commands = Array.from({ length: 31 }, () => ({ type: 'frame_add', frame: { title: 'Frame', x: 0, y: 0, width: 100, height: 100 } }));
  assert.equal(engine.execute({ type: 'batch', commands }).ok, false);
  assert.equal(engine.getDocument().frames.length, 0);
  assert.equal(engine.execute({ type: 'frame_add', frame: { title: 'Frame', description: 'x'.repeat(2001), x: 0, y: 0, width: 100, height: 100 } }).ok, false);
  assert.equal(engine.execute({ type: 'frame_delete', id: 'missing' }).ok, false);
  const duplicate = storyBoard();
  duplicate.reactions.push(structuredClone(duplicate.reactions[0]));
  assert.throws(() => validateDocument(duplicate), /only once/);
  engine.load(storyBoard(), { readOnly: true });
  assert.equal(engine.execute({ type: 'frame_delete', id: engine.getDocument().frames[0].id }).error.code, 'READ_ONLY');
});

test('note and bubble objects retain text, defaults and bounds through moves and sharing', async () => {
  const engine = createEngine();
  const result = engine.execute({ type: 'batch', commands: [
    { type: 'create', object: { type: 'note', text: '생각을 붙이기', x: 20, y: 30 } },
    { type: 'create', object: { type: 'bubble', text: '대화하기 💬', x: 300, y: 30, fontSize: 26 } },
  ] });
  assert.equal(result.ok, true);
  assert.deepEqual(objectBounds(engine.getDocument().objects[0]), { x: 20, y: 30, width: 220, height: 140 });
  engine.execute({ type: 'move', ids: result.createdIds, dx: 10, dy: -5 });
  const restored = await decodeSnapshot(await encodeSnapshot(engine.getDocument()));
  assert.equal(restored.objects[0].x, 30);
  assert.equal(restored.objects[1].text, '대화하기 💬');
  assert.equal(restored.objects[1].fontSize, 26);
  assert.equal(engine.execute({ type: 'update', ids: [result.createdIds[0]], changes: { type: 'bubble' } }).ok, false);
});

test('full forks preserve reactions and frames across multiple source generations', async () => {
  const original = storyBoard();
  const second = await forkDocument(original, { author: '두 번째' });
  assert.notEqual(second.frames[0].id, original.frames[0].id);
  assert.deepEqual(second.reactions, original.reactions);
  const editor = createEngine(second);
  editor.execute({ type: 'frame_update', id: second.frames[0].id, changes: { description: '새 맥락' } });
  const edited = editor.getDocument();
  const third = await forkDocument(edited, { author: '세 번째' });
  const restored = await decodeSnapshot(await encodeSnapshot(third));
  assert.deepEqual(resolveSource(restored, await snapshotHash(original)), original);
  assert.deepEqual(resolveSource(restored, await snapshotHash(edited)), edited);
});

test('selected fork includes contained frames with a complete source', async () => {
  const source = storyBoard();
  const fork = await forkDocument(source, { selectionIds: [source.objects[0].id] });
  assert.equal(fork.objects.length, 1);
  assert.equal(fork.frames.length, 1);
  assert.equal(fork.frames[0].title, '첫 장면');
  assert.deepEqual(fork.reactions, []);
  assert.deepEqual(resolveSource(fork, await snapshotHash(source)), source);
});

test('quote merges translated content into current board with one undo and an immutable full source', async () => {
  const target = storyBoard(), source = storyBoard();
  const sourceBefore = structuredClone(source);
  const engine = createEngine(target);
  const command = await prepareQuoteCommand(target, source, { selectionIds: [source.objects[0].id], dx: 200, dy: 300 });
  const result = engine.execute(command, { actor: 'agent' });
  assert.equal(result.ok, true);
  const quoted = engine.getDocument();
  assert.equal(quoted.id, target.id);
  assert.equal(quoted.title, target.title);
  assert.deepEqual(quoted.objects.slice(0, target.objects.length), target.objects);
  assert.equal(quoted.objects.at(-1).x, source.objects[0].x + 200);
  assert.equal(quoted.frames.at(-1).x, source.frames[0].x + 200);
  assert.notEqual(quoted.objects.at(-1).id, source.objects[0].id);
  assert.deepEqual(resolveSource(quoted, await snapshotHash(source)), source);
  assert.deepEqual(source, sourceBefore);
  assert.equal(engine.getHistory().length, 1);
  engine.undo();
  for (const key of ['objects', 'reactions', 'frames', 'provenance']) assert.deepEqual(engine.getDocument()[key], target[key]);
  engine.redo();
  assert.deepEqual(await decodeSnapshot(await encodeSnapshot(engine.getDocument())), engine.getDocument());
});

test('quote failures roll back all content, and repeat quotes deduplicate source payloads', async () => {
  const target = createDocument(), source = storyBoard();
  const engine = createEngine(target);
  const first = await prepareQuoteCommand(target, source);
  assert.equal(engine.execute(first).ok, true);
  const before = engine.getDocument();
  assert.equal(engine.execute(first).ok, false);
  assert.deepEqual(engine.getDocument(), before);
  const second = await prepareQuoteCommand(before, source, { dx: 600 });
  assert.equal(engine.execute(second).ok, true);
  assert.equal(engine.getDocument().provenance.length, 1);
  assert.equal(new Set(engine.getDocument().objects.map((object) => object.id)).size, engine.getDocument().objects.length);
  const invalid = await prepareQuoteCommand(engine.getDocument(), source);
  invalid.frames[0].x = Infinity;
  const last = engine.getDocument();
  assert.equal(engine.execute(invalid).ok, false);
  assert.deepEqual(engine.getDocument(), last);
});

test('share links and quoted source locations do not retain query or fragment credentials', async () => {
  const original = createDocument({ title: 'portable', author: 'display name' });
  const url = await shareURL(original, 'https://example.test/board/?access_token=do-not-store#session=do-not-store');
  assert.equal(new URL(url).search, '');
  assert.ok(!url.includes('do-not-store'));
  const fork = await forkDocument(original, { sourceURL: 'https://example.test/board/?token=do-not-store#session=do-not-store' });
  assert.equal(fork.provenance[0].sourceURL, 'https://example.test/board/');
  assert.ok(!JSON.stringify(fork).includes('do-not-store'));
});
