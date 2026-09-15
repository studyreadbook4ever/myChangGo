import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEngine } from '../engine.js';
import { installWebMCP, TOOL_CATALOG, TOOL_DEFINITIONS } from '../webmcp.js';
import { shareURL, decodeSnapshot, prepareQuoteCommand } from '../share.js';

function setup(overrides = {}) {
  const engine = createEngine();
  let selection = [];
  let viewport = { x: 0, y: 0, zoom: 1 };
  let nickname = '';
  const activities = [];
  const api = installWebMCP({ engine,
    getSelection: () => selection,
    setSelection: ids => { selection = ids; },
    getViewport: () => viewport,
    setViewport: value => { viewport = value; },
    shareBoard: async () => ({ ok: true, url: 'https://example.test/#board=snapshot', hash: 'snapshot' }),
    forkBoard: async () => {
      const result = engine.load(engine.getDocument(), { readOnly: false });
      return { ...result, documentId: engine.getDocument().id };
    },
    getNickname: () => nickname,
    setNickname: value => { nickname = value; },
    onActivity: value => activities.push(value), ...overrides,
  });
  return { engine, api, activities, selection: () => selection, viewport: () => viewport };
}

const line = { type: 'line', x: 100, y: 100, width: -60, height: 0, stroke: '#123abc' };

test('local tool commands use shared engine, free cursor coordinates and one undoable batch', async () => {
  const { engine, api } = setup();
  const result = await api.call('board_edit', { commands: [
    { type: 'agent_move', x: -30, y: -40 },
    { type: 'agent_pen', down: true, color: '#6366f1', width: 5 },
    { type: 'agent_move', dx: 120, dy: 0 },
    { type: 'agent_pen', down: false },
    { type: 'create', object: line },
  ] });
  assert.equal(result.ok, true);
  assert.equal(engine.getDocument().agent.x, 90);
  assert.equal(engine.getDocument().objects.length, 2);
  assert.equal(engine.getHistory().at(-1).actor, 'agent');
  assert.equal((await api.call('board_history', { action: 'undo' })).ok, true);
  assert.equal(engine.getDocument().objects.length, 0);
  assert.equal((await api.call('board_history', { action: 'redo' })).ok, true);
  assert.equal(engine.getDocument().objects.length, 2);
  api.dispose();
});

test('invalid schemas and batches do not partially mutate the board', async () => {
  const { engine, api } = setup();
  const before = engine.getDocument();
  for (const [name, args] of [
    ['agent_move', { x: 0.5, y: 2 }],
    ['agent_move', { x: 0, y: 0, dx: 2, dy: 2 }],
    ['agent_move', { x: Infinity, y: 0 }],
    ['agent_move', { x: 100001, y: 0 }],
    ['agent_pen', { down: true, color: 'url(https://example.test/x)' }],
    ['board_view', { x: 0, y: 0, zoom: 0 }],
    ['board_edit', { commands: Array.from({ length: 51 }, () => ({ type: 'create', object: line })) }],
    ['board_edit', { commands: [{ type: 'create', object: { ...line, type: 'rect', width: -2 } }] }],
    ['board_edit', { commands: [{ type: 'update', ids: ['o_exists'], changes: {} }] }],
    ['board_read', JSON.parse('{"__proto__":{}}')],
  ]) {
    const result = await api.call(name, args);
    assert.equal(result.ok, false, `${name} unexpectedly accepted ${JSON.stringify(args)}`);
    assert.equal(result.error.code, 'INVALID_ARGUMENT');
  }
  const atomicFailure = await api.call('board_edit', { commands: [
    { type: 'create', object: line }, { type: 'delete', ids: ['missing_object'] },
  ] });
  assert.equal(atomicFailure.ok, false);
  assert.equal(atomicFailure.error.code, 'NOT_FOUND');
  assert.deepEqual(engine.getDocument(), before);
  assert.equal((await api.call('made_up_tool', {})).error.code, 'UNKNOWN_TOOL');
  api.dispose();
});

test('metadata, a one-point path and clear are undoable through the same API', async () => {
  const { engine, api } = setup();
  const create = await api.call('board_edit', { commands: [
    { type: 'metadata', title: 'Shared board', author: 'Guest' },
    { type: 'create', object: { type: 'path', points: [[1, 2]], strokeWidth: 0 } },
  ] });
  assert.equal(create.ok, true);
  assert.equal(engine.getDocument().title, 'Shared board');
  assert.equal(engine.getDocument().objects.length, 1);
  assert.equal((await api.call('board_edit', { commands: [{ type: 'clear' }] })).ok, true);
  assert.equal(engine.getDocument().objects.length, 0);
  await api.call('board_history', { action: 'undo' });
  assert.equal(engine.getDocument().objects.length, 1);
  api.dispose();
});

test('reaction tools require a tab nickname and never accept an author override', async () => {
  const { api, engine } = setup();
  const beforeIdentity = engine.getDocument();
  assert.equal((await api.call('board_react', { emoji: '💡' })).error.code, 'NICKNAME_REQUIRED');
  const identity = await api.call('board_identity', { nickname: '  Mina  ' });
  assert.deepEqual(identity, { ok: true, nickname: 'Mina', scope: 'current_tab', authenticated: false });
  assert.deepEqual(engine.getDocument(), beforeIdentity);
  assert.equal((await api.call('board_react', { emoji: '💡' })).ok, true);
  const preview = await api.call('board_read');
  assert.equal(preview.sessionNickname, 'Mina');
  assert.equal(preview.reactions.find(item => item.emoji === '💡').count, 1);
  assert.equal(engine.getDocument().reactions[0].author, 'Mina');
  assert.equal((await api.call('board_react', { emoji: '💡' })).ok, true);
  assert.equal(engine.getDocument().reactions.length, 0);
  const before = engine.getDocument();
  assert.equal((await api.call('board_react', { emoji: '💡', author: 'Someone else' })).error.code, 'INVALID_ARGUMENT');
  assert.equal((await api.call('board_react', { emoji: '🦄' })).error.code, 'INVALID_ARGUMENT');
  assert.equal((await api.call('board_identity', { nickname: '  ' })).error.code, 'INVALID_ARGUMENT');
  assert.deepEqual(engine.getDocument(), before);
  const otherTab = setup();
  assert.equal((await otherTab.api.call('board_read')).sessionNickname, '');
  otherTab.api.dispose();
  api.dispose();
});

test('note and bubble objects and story frames share one undoable batch', async () => {
  const { api, engine } = setup();
  const result = await api.call('board_edit', { commands: [
    { type: 'create', object: { type: 'note', x: 10, y: 20, text: '첫 장면' } },
    { type: 'create', object: { type: 'bubble', x: 250, y: 20, text: '안녕!' } },
    { type: 'frame_add', frame: { id: 'frame_intro', title: '소개', description: '가'.repeat(500), x: 0, y: 0, width: 500, height: 200 } },
  ] });
  assert.equal(result.ok, true);
  assert.equal(engine.getDocument().objects[0].width, 220);
  assert.equal(engine.getDocument().objects[1].height, 140);
  assert.equal((await api.call('board_read')).frames[0].descriptionTruncated, true);
  assert.equal((await api.call('board_read', { frameId: 'frame_intro' })).frames[0].description.length, 500);
  assert.equal((await api.call('board_edit', { commands: [{ type: 'frame_update', id: 'frame_intro', changes: { title: '시작' } }] })).ok, true);
  assert.equal(engine.getDocument().frames[0].title, '시작');
  await api.call('board_history', { action: 'undo' });
  assert.equal(engine.getDocument().frames[0].title, '소개');
  await api.call('board_history', { action: 'undo' });
  assert.equal(engine.getDocument().objects.length, 0);
  assert.equal(engine.getDocument().frames.length, 0);
  api.dispose();
});

test('quotation tool merges source frames and preserves original reactions, then undo restores target', async () => {
  let target;
  const fixture = setup({ quoteBoard: async ({ url, dx = 0, dy = 0, signal }) => {
    signal.throwIfAborted();
    const quoted = await decodeSnapshot(new URL(url).hash.slice(7));
    const command = await prepareQuoteCommand(target.getDocument(), quoted, { dx, dy });
    signal.throwIfAborted();
    return target.execute(command, { actor: 'agent' });
  } });
  target = fixture.engine;
  target.execute({ type: 'create', object: line });
  const source = createEngine();
  source.execute({ type: 'create', object: { ...line, x: 500 } });
  source.execute({ type: 'reaction_toggle', emoji: '👍', author: 'Guest' });
  source.execute({ type: 'frame_add', frame: { title: '원본 장면', x: 500, y: 100, width: 100, height: 100 } });
  const url = await shareURL(source.getDocument(), 'https://example.test/260915GrimPan/');
  const before = target.getDocument();
  assert.equal((await fixture.api.call('board_quote', { url, dx: 20, dy: 40 })).ok, true);
  const after = target.getDocument();
  assert.equal(after.objects.length, 2);
  assert.equal(after.frames[0].x, 520);
  assert.equal(after.frames[0].y, 140);
  assert.deepEqual(after.provenance[0].snapshot.reactions, source.getDocument().reactions);
  await fixture.api.call('board_history', { action: 'undo' });
  assert.deepEqual(target.getDocument().objects, before.objects);
  assert.deepEqual(target.getDocument().frames, before.frames);
  assert.deepEqual(target.getDocument().provenance, before.provenance);
  target.load(target.getDocument(), { readOnly: true });
  assert.equal((await fixture.api.call('board_quote', { url })).error.code, 'READ_ONLY');
  fixture.api.dispose();
});

test('readonly snapshots allow selection and viewing; fork enables editing', async () => {
  const { engine, api, selection, viewport } = setup();
  const created = engine.execute({ type: 'create', object: line });
  engine.load(engine.getDocument(), { readOnly: true });
  assert.equal((await api.call('board_read')).readOnly, true);
  assert.equal((await api.call('agent_move', { x: 5, y: 5 })).error.code, 'READ_ONLY');
  assert.equal((await api.call('board_history', { action: 'undo' })).error.code, 'READ_ONLY');
  assert.equal((await api.call('board_select', { ids: created.createdIds })).ok, true);
  assert.deepEqual(selection(), created.createdIds);
  assert.equal((await api.call('board_view', { x: 20, y: 50, zoom: 2 })).ok, true);
  assert.deepEqual(viewport(), { x: 20, y: 50, zoom: 2 });
  assert.equal((await api.call('board_fork', { selectionOnly: true })).ok, true);
  assert.equal((await api.call('agent_move', { x: 5, y: 5 })).ok, true);
  await api.call('board_select', { ids: [] });
  assert.equal((await api.call('board_fork', { selectionOnly: true })).error.code, 'EMPTY_SELECTION');
  assert.equal((await api.call('board_select', { ids: ['not_found'] })).error.code, 'NOT_FOUND');
  api.dispose();
});

test('read pages summaries and long paths within bounded detail budgets', async () => {
  const { engine, api } = setup();
  const commands = Array.from({ length: 12 }, (_, index) => ({ type: 'create', object: {
    type: 'path', id: `long_path_${index}`, points: Array.from({ length: 800 }, (_, n) => [n, index]),
  } }));
  assert.equal(engine.execute({ type: 'batch', commands }).ok, true);
  await api.call('board_select', { ids: commands.map(cmd => cmd.object.id) });
  const state = await api.call('board_read', { limit: 5, pointLimit: 500 });
  assert.equal(state.ok, true);
  assert.equal(state.objects.length, 5);
  assert.equal(state.nextOffset, 5);
  assert.equal(state.details.length, 10);
  assert.equal(state.detailsTruncated, true);
  assert.equal(state.details.reduce((sum, object) => sum + (object.points?.length ?? 0), 0), 500);
  const last = await api.call('board_read', { ids: ['long_path_0'], pointOffset: 500, pointLimit: 500 });
  assert.deepEqual(last.details[0].points[0], [500, 0]);
  assert.equal(last.details[0].points.length, 300);
  api.dispose();
});

test('busy document transitions reject reads and edits until the current board is ready', async () => {
  let busy = true;
  const { api, engine } = setup({ isBusy: () => busy });
  const before = engine.getDocument();
  const blockedRead = await api.call('board_read');
  assert.equal(blockedRead.ok, false);
  assert.equal(blockedRead.error.code, 'DOCUMENT_BUSY');
  assert.equal(blockedRead.objects, undefined);
  assert.equal((await api.call('agent_move', { x: 1, y: 2 })).error.code, 'DOCUMENT_BUSY');
  assert.deepEqual(engine.getDocument(), before);
  busy = false;
  assert.equal((await api.call('board_read')).ok, true);
  assert.equal((await api.call('agent_move', { x: 1, y: 2 })).ok, true);
  api.dispose();
});

test('bounded lineage retains the direct quote when more than ten ancestors exist', async () => {
  const { api, engine } = setup();
  const doc = engine.getDocument();
  doc.provenance = Array.from({ length: 12 }, (_, index) => ({
    sourceHash: index.toString(16).padStart(64, '0'),
    title: index === 0 ? 'Directly quoted original' : `Earlier source ${index}`,
    author: 'Guest', createdAt: doc.createdAt, sourceURL: 'https://example.test/',
  }));
  assert.equal(engine.load(doc).ok, true);
  const state = await api.call('board_read');
  assert.equal(state.sourceCount, 12);
  assert.equal(state.provenanceTruncated, true);
  assert.equal(state.provenance.length, 10);
  assert.equal(state.provenance[0].title, 'Directly quoted original');
  assert.equal(state.provenance[0].sourceHash, doc.provenance[0].sourceHash);
  assert.equal(state.provenance[9].sourceHash, doc.provenance[9].sourceHash);
  api.dispose();
});

test('native registration has current execute signature, JSON results and unregister lifecycle', async t => {
  const original = globalThis.document;
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
  const registered = new Map();
  globalThis.document = { modelContext: {
    async registerTool(definition, { signal }) {
      registered.set(definition.name, definition);
      signal.addEventListener('abort', () => registered.delete(definition.name), { once: true });
    },
  } };
  const { api, engine } = setup();
  assert.deepEqual(await api.ready, { ok: true, native: true, registered: 13 });
  assert.equal(registered.size, TOOL_DEFINITIONS.length);
  const result = JSON.parse(await registered.get('agent_move').execute({ x: -20, y: -30 }, { signal: new AbortController().signal }));
  assert.equal(result.ok, true);
  assert.equal(engine.getDocument().agent.x, -20);
  assert.equal(JSON.parse(await registered.get('agent_move').execute('{"x":1,"y":2}')).ok, false);
  api.dispose();
  assert.equal(registered.size, 0);
  assert.equal((await api.call('board_read')).error.code, 'ABORTED');
});

test('registration rejection is reported and does not disable ordinary local tools', async t => {
  const original = globalThis.document;
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
  globalThis.document = { modelContext: { registerTool() { throw new Error('Feature blocked by browser policy'); } } };
  const { api, activities } = setup();
  assert.equal((await api.ready).ok, false);
  assert.equal(api.supported, false);
  assert.ok(activities.some(event => event.kind === 'webmcp' && event.status === 'error'));
  assert.equal((await api.call('agent_move', { x: 5, y: 6 })).ok, true);
  api.dispose();
});

test('cancellation is passed through async callbacks and checked before edits', async () => {
  let started = false;
  const { api, engine } = setup({ shareBoard: ({ signal }) => new Promise((resolve, reject) => {
    started = true;
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }) });
  const aborted = new AbortController();
  aborted.abort();
  const before = engine.getDocument();
  assert.equal((await api.call('agent_move', { x: 1, y: 2 }, { signal: aborted.signal })).error.code, 'ABORTED');
  assert.deepEqual(engine.getDocument(), before);
  const pending = api.call('board_share', {});
  assert.equal(started, true);
  api.dispose();
  assert.equal((await pending).error.code, 'ABORTED');
});

test('published JSON schemas match the adapter source of truth', async () => {
  const published = JSON.parse(await readFile(new URL('../tools.json', import.meta.url), 'utf8'));
  assert.deepEqual(published, TOOL_CATALOG);
});
