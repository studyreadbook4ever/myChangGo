/** Shared, dependency-free document and command engine for humans and agents. */
export const LIMITS = Object.freeze({ objects: 3000, points: 100000, bytes: 3 * 1024 * 1024, coordinate: 1_000_000, provenance: 64, frames: 30, reactions: 256 });
export const REACTION_EMOJI = Object.freeze(['👍', '❤️', '✨', '💡', '👏', '❓']);
const TYPES = new Set(['path', 'rect', 'ellipse', 'line', 'text', 'note', 'bubble']);
const encoder = new TextEncoder();
const copy = (value) => structuredClone(value);
const now = () => new Date().toISOString();
const makeId = (prefix = 'o') => `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
const fail = (message, code = 'INVALID_INPUT') => { const error = new Error(message); error.code = code; throw error; };

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}
function number(value, label, min = -LIMITS.coordinate, max = LIMITS.coordinate) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be a finite number between ${min} and ${max}.`);
  return value;
}
function string(value, label, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.length > max) fail(`${label} must be text of at most ${max} characters.`);
  return value;
}
function identifier(value, label = 'id') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail(`${label} is invalid.`);
  return value;
}
function color(value, label, fallback) {
  const result = string(value, label, 100, fallback);
  if (!/^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|[a-z]{1,25}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%/+\-]+\))$/i.test(result)) fail(`${label} must be a CSS color, not markup or a URL.`);
  return result;
}
function timestamp(value, label) {
  const result = string(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || !Number.isFinite(Date.parse(result))) fail(`${label} is invalid.`);
  return result;
}
function angle(value) { return ((number(value, 'angle') % 360) + 360) % 360; }
function boolean(value, label) { if (typeof value !== 'boolean') fail(`${label} must be true or false.`); return value; }

function boundedArray(value, label, limit) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) fail(`${label} supports at most ${limit} entries.`);
  return value;
}
function uniqueIds(entries, label) {
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) fail(`${label} IDs must be unique.`);
  return entries;
}
function normalizeFrame(input, create = false) {
  const frame = record(input, 'frame');
  return {
    id: identifier(frame.id ?? (create ? makeId('frame') : undefined), 'frame id'),
    title: string(frame.title, 'frame title', 200, 'Untitled frame'), description: string(frame.description, 'frame description', 2000, ''),
    x: number(frame.x, 'frame x'), y: number(frame.y, 'frame y'), width: number(frame.width, 'frame width', 1), height: number(frame.height, 'frame height', 1),
  };
}
function normalizeReaction(input) {
  const reaction = record(input, 'reaction');
  if (!REACTION_EMOJI.includes(reaction.emoji)) fail('Unsupported reaction emoji.');
  return { emoji: reaction.emoji, author: string(reaction.author, 'reaction author', 100), createdAt: timestamp(reaction.createdAt, 'reaction createdAt') };
}

function normalizeObject(input, create = false) {
  const source = record(input, 'object');
  if (!TYPES.has(source.type)) fail('Unsupported object type.');
  const type = source.type;
  const card = type === 'note' || type === 'bubble';
  const object = {
    id: identifier(source.id ?? (create ? makeId() : undefined)), type,
    x: number(source.x ?? 0, 'x'), y: number(source.y ?? 0, 'y'),
    width: number(source.width ?? (card ? 220 : 0), 'width', type === 'line' ? -LIMITS.coordinate : (card ? 1 : 0)),
    height: number(source.height ?? (card ? 140 : 0), 'height', type === 'line' ? -LIMITS.coordinate : (card ? 1 : 0)),
    stroke: color(source.stroke, 'stroke', '#1f2937'),
    fill: color(source.fill, 'fill', 'transparent'),
    strokeWidth: number(source.strokeWidth ?? 3, 'strokeWidth', 0, 256),
    rotation: angle(source.rotation ?? 0),
  };
  if (type === 'path') {
    if (!Array.isArray(source.points) || source.points.length < 1 || source.points.length > LIMITS.points) fail(`Paths need 1–${LIMITS.points} points.`);
    object.points = source.points.map((point) => {
      if (!Array.isArray(point) || point.length !== 2) fail('Path points must be [x, y] coordinate pairs.');
      return [number(point[0], 'point x'), number(point[1], 'point y')];
    });
    object.x = 0; object.y = 0;
    const bounds = pointBounds(object.points);
    object.width = bounds.width; object.height = bounds.height;
    if (object.width > LIMITS.coordinate || object.height > LIMITS.coordinate) fail('Path dimensions exceed the coordinate limit.');
  }
  if (type === 'text' || card) {
    object.text = string(source.text, 'text', 10000, '');
    object.fontSize = number(source.fontSize ?? 24, 'fontSize', 1, 512);
  }
  return object;
}

function pointBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Axis-aligned selection bounds, including rotation; path points are absolute. */
export function objectBounds(object) {
  let bounds = object.type === 'path' ? pointBounds(object.points) : {
    x: Math.min(object.x, object.x + object.width), y: Math.min(object.y, object.y + object.height),
    width: Math.abs(object.width), height: Math.abs(object.height),
  };
  if (object.type === 'text') {
    const lines = object.text.split('\n');
    bounds.width ||= Math.max(1, ...lines.map((line) => line.length)) * object.fontSize * 0.65;
    bounds.height ||= lines.length * object.fontSize * 1.25;
  }
  if (object.rotation) {
    const radians = object.rotation * Math.PI / 180;
    const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
    bounds = pointBounds([[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y], [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]].map(([x, y]) => [cx + (x - cx) * Math.cos(radians) - (y - cy) * Math.sin(radians), cy + (x - cx) * Math.sin(radians) + (y - cy) * Math.cos(radians)]));
  }
  return bounds;
}

/** Snapshot fragments are bundled as documents, never recursively inside URLs. */
export function compactSourceURL(value = '') {
  const source = string(value, 'sourceURL', 4 * LIMITS.bytes, '');
  if (!source) return '';
  let url;
  try { url = new URL(source); } catch { fail('Source URL must be an absolute HTTP(S) URL.'); }
  if (!['https:', 'http:'].includes(url.protocol)) fail('Source URL must use HTTP or HTTPS.');
  if (url.username || url.password) fail('Source URLs cannot contain credentials.');
  // The full source is bundled. Query strings and fragments are not source identity.
  url.search = '';
  url.hash = '';
  if (url.href.length > 2048) fail('Source URL is too long.');
  return url.href;
}

function normalizeDocument(input, allowSnapshots) {
  const source = record(input, 'document');
  if (source.schema !== 'grimpan/1') fail('Unsupported board format. Expected grimpan/1.');
  if (!Array.isArray(source.objects) || source.objects.length > LIMITS.objects) fail(`Boards support at most ${LIMITS.objects} objects.`);
  const objects = source.objects.map((object) => normalizeObject(object));
  if (new Set(objects.map((object) => object.id)).size !== objects.length) fail('Object IDs must be unique.');
  if (objects.reduce((sum, object) => sum + (object.points?.length || 0), 0) > LIMITS.points) fail(`Boards support at most ${LIMITS.points} total path points.`);
  const agent = record(source.agent, 'agent');
  const provenance = source.provenance ?? [];
  if (!Array.isArray(provenance) || provenance.length > LIMITS.provenance) fail(`At most ${LIMITS.provenance} source snapshots can be quoted.`);
  const result = {
    schema: 'grimpan/1', id: identifier(source.id, 'document id'),
    title: string(source.title, 'title', 200), author: string(source.author, 'author', 100),
    revision: number(source.revision, 'revision', 0, Number.MAX_SAFE_INTEGER),
    createdAt: timestamp(source.createdAt, 'createdAt'), updatedAt: timestamp(source.updatedAt, 'updatedAt'),
    objects,
    reactions: boundedArray(source.reactions, 'Reactions', LIMITS.reactions).map(normalizeReaction),
    frames: uniqueIds(boundedArray(source.frames, 'Frames', LIMITS.frames).map((frame) => normalizeFrame(frame)), 'Frame'),
    agent: { x: number(agent.x, 'agent x'), y: number(agent.y, 'agent y'), heading: angle(agent.heading), penDown: boolean(agent.penDown, 'penDown'), color: color(agent.color, 'agent color', '#2563eb'), width: number(agent.width, 'agent width', 0.1, 256) },
    provenance: provenance.map((entry) => {
      record(entry, 'source');
      if (typeof entry.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sourceHash)) fail('Source hashes must be SHA-256 content identifiers.');
      const item = { sourceHash: entry.sourceHash, title: string(entry.title, 'source title', 200), author: string(entry.author, 'source author', 100), createdAt: timestamp(entry.createdAt, 'source createdAt'), sourceURL: compactSourceURL(entry.sourceURL) };
      if (entry.snapshot !== undefined) {
        if (!allowSnapshots) fail('Source snapshots must be flattened; nested source payloads are not allowed.');
        item.snapshot = normalizeDocument(entry.snapshot, false);
      }
      return item;
    }),
  };
  if (!Number.isSafeInteger(result.revision)) fail('Revision must be a safe integer.');
  if (new Set(result.reactions.map((reaction) => `${reaction.emoji}\0${reaction.author}`)).size !== result.reactions.length) fail('Each author can use each reaction only once.');
  if (new Set(result.provenance.map((entry) => entry.sourceHash)).size !== result.provenance.length) fail('Source hashes must be unique.');
  if (encoder.encode(JSON.stringify(result)).byteLength > LIMITS.bytes) fail('This board and its quoted sources exceed the 3 MiB portable snapshot limit.', 'SNAPSHOT_TOO_LARGE');
  return result;
}

export function validateDocument(input) { return normalizeDocument(input, true); }

export function createDocument({ title = 'Untitled board', author = 'Anonymous' } = {}) {
  const time = now();
  return validateDocument({ schema: 'grimpan/1', id: makeId('board'), title, author, revision: 0, createdAt: time, updatedAt: time, objects: [], agent: { x: 160, y: 160, heading: 0, penDown: false, color: '#2563eb', width: 4 }, provenance: [] });
}

export function createEngine(initial = createDocument()) {
  let document = validateDocument(initial), revisionClock = document.revision, readOnly = false;
  let past = [], future = [];
  const listeners = new Set();
  const historyLimit = 40, historyBytes = 16 * 1024 * 1024;

  function emit(type, actor, extra = {}) {
    const event = { type, actor, document: copy(document), canUndo: !readOnly && past.length > 0, canRedo: !readOnly && future.length > 0, ...extra };
    for (const listener of listeners) { try { listener(event); } catch (error) { console.error('Board subscriber failed:', error); } }
  }
  const rejection = (error) => ({ ok: false, revision: document.revision, error: { code: error.code || 'INVALID_INPUT', message: error.message || String(error) } });
  function writable() { if (readOnly) fail('This is an immutable source. Fork it to make changes.', 'READ_ONLY'); }
  function trimHistory() {
    let size = past.reduce((sum, item) => sum + item.bytes, 0);
    while (past.length > historyLimit || (size > historyBytes && past.length > 1)) size -= past.shift().bytes;
  }
  function bump(next) {
    if (revisionClock >= Number.MAX_SAFE_INTEGER) fail('Revision limit reached. Fork this board to continue.');
    next.revision = ++revisionClock; next.updatedAt = now(); return next;
  }
  function execute(command, { actor = 'human' } = {}) {
    try {
      writable();
      actor = string(actor, 'actor', 100);
      const draft = copy(document), createdIds = [], createdFrameIds = [], changed = new Set();
      let commandCount = 0;
      let totalPoints = draft.objects.reduce((sum, object) => sum + (object.points?.length || 0), 0);
      const indexFor = (ids) => {
        if (!Array.isArray(ids) || !ids.length || ids.length > LIMITS.objects) fail('ids must be a non-empty array of object IDs.');
        return [...new Set(ids.map((id) => identifier(id)))].map((id) => { const index = draft.objects.findIndex((object) => object.id === id); if (index < 0) fail(`Object ${id} was not found.`, 'NOT_FOUND'); return index; });
      };
      function add(input) {
        if (draft.objects.length >= LIMITS.objects) fail(`Boards support at most ${LIMITS.objects} objects.`);
        const object = normalizeObject(input, true);
        if (draft.objects.some((existing) => existing.id === object.id)) fail('An object with that ID already exists.');
        totalPoints += object.points?.length || 0;
        if (totalPoints > LIMITS.points) fail(`Boards support at most ${LIMITS.points} total path points.`);
        draft.objects.push(object); createdIds.push(object.id); changed.add(object.id);
      }
      function entryIndex(entries, id, label) {
        identifier(id, `${label} id`);
        const index = entries.findIndex((entry) => entry.id === id);
        if (index < 0) fail(`${label} ${id} was not found.`, 'NOT_FOUND');
        return index;
      }
      function addFrame(input) {
        if (draft.frames.length >= LIMITS.frames) fail(`Frames supports at most ${LIMITS.frames} entries.`);
        const frame = normalizeFrame(input, true);
        if (draft.frames.some((existing) => existing.id === frame.id)) fail('A frame with that ID already exists.');
        draft.frames.push(frame); createdFrameIds.push(frame.id); changed.add(frame.id);
      }
      function run(input, depth = 0) {
        record(input, 'command');
        if (++commandCount > 2000 || depth > 5) fail('Batch command limit exceeded.');
        switch (input.type) {
          case 'create': add(input.object); break;
          case 'update': {
            const updates = record(input.changes, 'changes');
            if ('id' in updates || 'type' in updates) fail('Object ID and type cannot be updated.');
            const allowed = new Set(['x', 'y', 'width', 'height', 'points', 'stroke', 'fill', 'strokeWidth', 'text', 'fontSize', 'rotation']);
            for (const key of Object.keys(updates)) if (!allowed.has(key)) fail(`Unsupported object property: ${key}`);
            for (const index of indexFor(input.ids)) {
              const previous = draft.objects[index];
              if (previous.type === 'path' && ((updates.x ?? 0) !== 0 || (updates.y ?? 0) !== 0)) fail('Path points use absolute coordinates. Use move to translate a path.');
              const next = normalizeObject({ ...previous, ...updates });
              totalPoints += (next.points?.length || 0) - (previous.points?.length || 0);
              if (totalPoints > LIMITS.points) fail(`Boards support at most ${LIMITS.points} total path points.`);
              draft.objects[index] = next; changed.add(next.id);
            }
            break;
          }
          case 'delete': {
            const indices = new Set(indexFor(input.ids));
            draft.objects = draft.objects.filter((object, index) => { if (!indices.has(index)) return true; totalPoints -= object.points?.length || 0; changed.add(object.id); return false; });
            break;
          }
          case 'move': {
            const dx = number(input.dx, 'dx'), dy = number(input.dy, 'dy');
            for (const index of indexFor(input.ids)) {
              const object = draft.objects[index];
              if (object.type === 'path') object.points = object.points.map(([x, y]) => [number(x + dx, 'point x'), number(y + dy, 'point y')]);
              else { object.x = number(object.x + dx, 'x'); object.y = number(object.y + dy, 'y'); }
              changed.add(object.id);
            }
            break;
          }
          case 'agent_move': {
            const absolute = input.x !== undefined || input.y !== undefined;
            const relative = input.dx !== undefined || input.dy !== undefined;
            if (absolute === relative) fail('Supply either x/y or dx/dy to move the agent.');
            const previous = { ...draft.agent };
            const x = number(absolute ? (input.x ?? previous.x) : previous.x + number(input.dx ?? 0, 'dx'), 'agent x');
            const y = number(absolute ? (input.y ?? previous.y) : previous.y + number(input.dy ?? 0, 'dy'), 'agent y');
            if (x !== previous.x || y !== previous.y) {
              if (previous.penDown) add({ type: 'path', points: [[previous.x, previous.y], [x, y]], stroke: previous.color, strokeWidth: previous.width });
              draft.agent.heading = angle(Math.atan2(y - previous.y, x - previous.x) * 180 / Math.PI);
            }
            draft.agent.x = x; draft.agent.y = y;
            break;
          }
          case 'agent_turn': draft.agent.heading = angle(input.angle); break;
          case 'agent_pen':
            draft.agent.penDown = boolean(input.down, 'down');
            if (input.color !== undefined) draft.agent.color = color(input.color, 'color');
            if (input.width !== undefined) draft.agent.width = number(input.width, 'width', 0.1, 256);
            break;
          case 'batch':
            if (!Array.isArray(input.commands) || input.commands.length > 2000) fail('commands must be an array of at most 2000 commands.');
            for (const item of input.commands) run(item, depth + 1);
            break;
          case 'reaction_toggle': {
            if (!REACTION_EMOJI.includes(input.emoji)) fail('Unsupported reaction emoji.');
            const author = string(input.author ?? draft.author, 'reaction author', 100);
            const index = draft.reactions.findIndex((reaction) => reaction.emoji === input.emoji && reaction.author === author);
            if (index >= 0) draft.reactions.splice(index, 1);
            else {
              if (draft.reactions.length >= LIMITS.reactions) fail(`Reactions supports at most ${LIMITS.reactions} entries.`);
              draft.reactions.push(normalizeReaction({ emoji: input.emoji, author, createdAt: now() }));
            }
            break;
          }
          case 'frame_add': addFrame(input.frame); break;
          case 'frame_update': {
            const index = entryIndex(draft.frames, input.id, 'Frame');
            const changes = record(input.changes, 'frame changes');
            const allowed = new Set(['title', 'description', 'x', 'y', 'width', 'height']);
            for (const key of Object.keys(changes)) if (!allowed.has(key)) fail(`Unsupported frame property: ${key}`);
            draft.frames[index] = normalizeFrame({ ...draft.frames[index], ...changes }); changed.add(input.id); break;
          }
          case 'frame_delete': {
            const index = entryIndex(draft.frames, input.id, 'Frame');
            changed.add(draft.frames[index].id); draft.frames.splice(index, 1); break;
          }
          case 'quote': {
            const incoming = normalizeDocument({ ...draft, objects: [], reactions: [], frames: [], provenance: input.provenance }, true).provenance;
            if (!incoming.length || incoming.some((entry) => !entry.snapshot)) fail('A quotation must include its portable source snapshots.');
            const merged = new Map(draft.provenance.map((entry) => [entry.sourceHash, entry]));
            for (const entry of incoming) {
              const existing = merged.get(entry.sourceHash);
              if (existing && (existing.title !== entry.title || existing.author !== entry.author || existing.createdAt !== entry.createdAt || JSON.stringify(existing.snapshot) !== JSON.stringify(entry.snapshot))) fail('Conflicting content was supplied for an existing quoted source.', 'SOURCE_HASH_MISMATCH');
              if (!existing) merged.set(entry.sourceHash, entry);
            }
            if (merged.size > LIMITS.provenance) fail(`At most ${LIMITS.provenance} source snapshots can be quoted.`);
            for (const entry of merged.values()) for (const ancestor of entry.snapshot?.provenance ?? []) if (!merged.get(ancestor.sourceHash)?.snapshot) fail('A quoted ancestor is missing its portable snapshot.', 'SOURCE_NOT_FOUND');
            draft.provenance = [...merged.values()];
            for (const object of boundedArray(input.objects, 'Quoted objects', LIMITS.objects)) add(object);
            for (const frame of boundedArray(input.frames, 'Quoted frames', LIMITS.frames)) addFrame(frame);
            break;
          }
          case 'metadata':
            if (input.title !== undefined) draft.title = string(input.title, 'title', 200);
            if (input.author !== undefined) draft.author = string(input.author, 'author', 100);
            break;
          case 'clear':
            for (const object of draft.objects) changed.add(object.id);
            draft.objects = []; totalPoints = 0; break;
          default: fail(`Unsupported command: ${String(input.type)}`);
        }
      }
      run(command);
      const next = validateDocument(draft);
      if (JSON.stringify(next) === JSON.stringify(document)) return { ok: true, revision: document.revision, createdIds: [], changedIds: [], unchanged: true };
      const before = document;
      document = bump(next);
      past.push({ before, after: document, actor, type: command.type, time: document.updatedAt, bytes: encoder.encode(JSON.stringify(before)).byteLength + encoder.encode(JSON.stringify(document)).byteLength });
      future = []; trimHistory();
      const result = { ok: true, revision: document.revision, createdIds, createdFrameIds, changedIds: [...changed] };
      if (createdFrameIds.length === 1) result.frameId = createdFrameIds[0];
      emit(command.type, actor, result);
      return result;
    } catch (error) { return rejection(error); }
  }
  function restore(direction, options = {}) {
    try {
      writable();
      const from = direction === 'undo' ? past : future, to = direction === 'undo' ? future : past;
      if (!from.length) return { ok: true, revision: document.revision, unchanged: true };
      const item = from.at(-1);
      const next = bump(copy(direction === 'undo' ? item.before : item.after));
      from.pop(); to.push(item); document = next;
      if (direction === 'redo') trimHistory();
      emit(direction, options.actor || 'human', { originalActor: item.actor, originalType: item.type });
      return { ok: true, revision: document.revision, originalActor: item.actor, originalType: item.type };
    } catch (error) { return rejection(error); }
  }
  return {
    getDocument: () => copy(document), execute,
    subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('Listener must be a function.'); listeners.add(listener); return () => listeners.delete(listener); },
    undo: (options) => restore('undo', options), redo: (options) => restore('redo', options),
    canUndo: () => !readOnly && past.length > 0, canRedo: () => !readOnly && future.length > 0,
    isReadOnly: () => readOnly,
    getHistory: () => past.map(({ actor, type, time, after }) => ({ actor, type, time, revision: after.revision })),
    load(input, { readOnly: nextReadOnly = false } = {}) {
      try {
        const next = validateDocument(input);
        document = next; revisionClock = Math.max(revisionClock, next.revision); readOnly = Boolean(nextReadOnly); past = []; future = [];
        emit('load', 'system'); return { ok: true, revision: document.revision };
      } catch (error) { return rejection(error); }
    },
  };
}
