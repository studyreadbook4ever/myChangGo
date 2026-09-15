/** Portable snapshot links. No upload, server account, imported code, or storage API. */
import { createDocument, validateDocument, compactSourceURL, objectBounds, LIMITS } from './engine.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const clone = (value) => structuredClone(value);
const error = (message, code = 'INVALID_SNAPSHOT') => { const e = new Error(message); e.code = code; return e; };

function toBase64URL(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function fromBase64URL(token) {
  if (!token || token.length > Math.ceil(LIMITS.bytes * 4 / 3) + 8 || !/^[a-zA-Z0-9_-]+$/.test(token) || token.length % 4 === 1) throw error('The snapshot link is malformed or exceeds the 3 MiB limit.');
  let binary;
  try { binary = atob(token.replaceAll('-', '+').replaceAll('_', '/')); } catch { throw error('The snapshot link has invalid encoding.'); }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length > LIMITS.bytes) throw error('The snapshot link is too large.', 'SNAPSHOT_TOO_LARGE');
  return bytes;
}
async function readBounded(stream, limit = LIMITS.bytes) {
  const reader = stream.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel().catch(() => {}); throw error('The expanded board exceeds the 3 MiB snapshot limit.', 'SNAPSHOT_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
function metadataOnly(entry) {
  const { snapshot: ignored, ...metadata } = entry;
  return { ...metadata, sourceURL: compactSourceURL(metadata.sourceURL) };
}
function withoutPayloads(document) {
  return { ...document, provenance: document.provenance.map(metadataOnly) };
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export async function snapshotHash(input) {
  if (!globalThis.crypto?.subtle) throw error('Content hashing needs a secure browser context (HTTPS or localhost).', 'SECURE_CONTEXT_REQUIRED');
  const document = withoutPayloads(validateDocument(input));
  // These optional collections were added to grimpan/1 after its first release.
  // Their empty state must not invalidate already-shared source content hashes.
  for (const key of ['reactions', 'frames']) if (!document[key].length) delete document[key];
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical(document))));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Reconstruct a quoted source with all of its own flattened source attachments. */
export function resolveSource(input, sourceHash) {
  const document = validateDocument(input);
  const index = new Map(document.provenance.map((entry) => [entry.sourceHash, entry]));
  const entry = index.get(sourceHash);
  if (!entry?.snapshot) throw error('The quoted source is not bundled in this board.', 'SOURCE_NOT_FOUND');
  const source = clone(entry.snapshot);
  source.provenance = source.provenance.map((metadata) => {
    const payload = index.get(metadata.sourceHash)?.snapshot;
    if (!payload) throw error('A quoted ancestor is missing from this snapshot.', 'SOURCE_NOT_FOUND');
    return { ...metadata, snapshot: clone(payload) };
  });
  return validateDocument(source);
}

async function verifySources(document) {
  const index = new Map(document.provenance.map((entry) => [entry.sourceHash, entry]));
  for (const entry of document.provenance) {
    if (!entry.snapshot) throw error('A quoted source is missing its portable snapshot.', 'SOURCE_NOT_FOUND');
    if (await snapshotHash(entry.snapshot) !== entry.sourceHash) throw error('A quoted source does not match its content hash.', 'SOURCE_HASH_MISMATCH');
    if (entry.title !== entry.snapshot.title || entry.author !== entry.snapshot.author || entry.createdAt !== entry.snapshot.createdAt) throw error('Quoted source metadata does not match the source.', 'SOURCE_HASH_MISMATCH');
    for (const ancestor of entry.snapshot.provenance) {
      if (!index.get(ancestor.sourceHash)?.snapshot) throw error('A quoted ancestor is missing its portable snapshot.', 'SOURCE_NOT_FOUND');
    }
  }
}

export async function encodeSnapshot(input) {
  const document = validateDocument(input);
  await verifySources(document);
  const bytes = encoder.encode(JSON.stringify(document));
  if (bytes.byteLength > LIMITS.bytes) throw error('This board and its sources exceed the 3 MiB snapshot limit.', 'SNAPSHOT_TOO_LARGE');
  if (typeof CompressionStream === 'function' && typeof DecompressionStream === 'function') {
    try {
      const compressed = await readBounded(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')));
      if (compressed.length < bytes.length) return `g1.${toBase64URL(compressed)}`;
    } catch (cause) { if (cause.code === 'SNAPSHOT_TOO_LARGE') throw cause; }
  }
  return `j1.${toBase64URL(bytes)}`;
}

export async function decodeSnapshot(token) {
  if (typeof token !== 'string' || token.length > Math.ceil(LIMITS.bytes * 4 / 3) + 12) throw error('The snapshot link is too large.', 'SNAPSHOT_TOO_LARGE');
  const match = /^(g1|j1)\.([a-zA-Z0-9_-]+)$/.exec(token);
  if (!match) throw error('Unsupported snapshot link format.');
  let bytes = fromBase64URL(match[2]);
  if (match[1] === 'g1') {
    if (typeof DecompressionStream !== 'function') throw error('This browser cannot open compressed links. Use a current browser or an uncompressed snapshot.', 'COMPRESSION_UNAVAILABLE');
    try { bytes = await readBounded(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))); }
    catch (cause) { if (cause.code === 'SNAPSHOT_TOO_LARGE') throw cause; throw error('The compressed snapshot is damaged.'); }
  }
  let input;
  try { input = JSON.parse(decoder.decode(bytes)); } catch { throw error('The snapshot does not contain valid UTF-8 board data.'); }
  const document = validateDocument(input);
  await verifySources(document);
  return document;
}

export async function shareURL(document, baseURL = globalThis.location?.href) {
  let url;
  try { url = new URL(baseURL); } catch { throw error('An absolute board URL is required.'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw error('Shared boards need an HTTP or HTTPS app URL.');
  if (url.username || url.password) throw error('Share URLs cannot contain credentials.');
  url.search = '';
  url.hash = `board=${await encodeSnapshot(document)}`;
  return url.href;
}

const freshId = (prefix) => `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;

function selectedContent(source, selectionIds) {
  if (selectionIds === undefined) return { objects: source.objects, frames: source.frames };
  if (!Array.isArray(selectionIds) || selectionIds.length > LIMITS.objects || selectionIds.some((id) => typeof id !== 'string')) throw error('selectionIds must contain object IDs.');
  const selection = new Set(selectionIds);
  if ([...selection].some((id) => !source.objects.some((object) => object.id === id))) throw error('An object selected for quotation was not found.');
  const objects = source.objects.filter((object) => selection.has(object.id));
  if (!objects.length) return { objects, frames: [] };
  const bounds = objects.map(objectBounds);
  const left = Math.min(...bounds.map((bound) => bound.x)), top = Math.min(...bounds.map((bound) => bound.y));
  const right = Math.max(...bounds.map((bound) => bound.x + bound.width)), bottom = Math.max(...bounds.map((bound) => bound.y + bound.height));
  const inside = (x, y) => x >= left && x <= right && y >= top && y <= bottom;
  return { objects, frames: source.frames.filter((frame) => inside(frame.x, frame.y) && inside(frame.x + frame.width, frame.y + frame.height)) };
}
function copyContent(content, dx = 0, dy = 0) {
  if (![dx, dy].every((value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= LIMITS.coordinate)) throw error('Quotation offsets must be finite document coordinates.');
  return {
    objects: content.objects.map((object) => {
      const result = { ...clone(object), id: freshId('o') };
      if (result.type === 'path') result.points = result.points.map(([x, y]) => [x + dx, y + dy]);
      else { result.x += dx; result.y += dy; }
      return result;
    }),
    frames: content.frames.map((frame) => ({ ...clone(frame), id: freshId('frame'), x: frame.x + dx, y: frame.y + dy })),
  };
}
async function sourceEntries(source, sourceURL) {
  const sourceHash = await snapshotHash(source);
  const direct = { sourceHash, title: source.title, author: source.author, createdAt: source.createdAt, sourceURL: compactSourceURL(sourceURL), snapshot: withoutPayloads(clone(source)) };
  return [direct, ...source.provenance.filter((entry) => entry.sourceHash !== sourceHash).map((entry) => clone(entry))];
}

export async function forkDocument(input, { author, title, selectionIds, sourceURL = '' } = {}) {
  const source = validateDocument(input);
  await verifySources(source);
  const fork = createDocument({ title: title ?? `${source.title.slice(0, 190)} · fork`, author: author ?? source.author });
  Object.assign(fork, copyContent(selectedContent(source, selectionIds)));
  fork.reactions = selectionIds === undefined ? clone(source.reactions) : [];
  fork.agent = clone(source.agent);
  fork.provenance = await sourceEntries(source, sourceURL);
  const result = validateDocument(fork);
  await verifySources(result);
  return result;
}

/** Prepare an additive quote; execute it on the current engine as one undoable action. */
export async function prepareQuoteCommand(targetInput, sourceInput, { selectionIds, dx = 0, dy = 0, sourceURL = '' } = {}) {
  const target = validateDocument(targetInput), source = validateDocument(sourceInput);
  await verifySources(target); await verifySources(source);
  const content = copyContent(selectedContent(source, selectionIds), dx, dy);
  const provenance = await sourceEntries(source, sourceURL);
  const merged = new Map(target.provenance.map((entry) => [entry.sourceHash, entry]));
  for (const entry of provenance) {
    const existing = merged.get(entry.sourceHash);
    if (existing && (existing.title !== entry.title || existing.author !== entry.author || existing.createdAt !== entry.createdAt || canonical(existing.snapshot) !== canonical(entry.snapshot))) throw error('Conflicting content was supplied for an existing source.', 'SOURCE_HASH_MISMATCH');
    if (!existing) merged.set(entry.sourceHash, entry);
  }
  validateDocument({ ...target, objects: [...target.objects, ...content.objects], frames: [...target.frames, ...content.frames], provenance: [...merged.values()] });
  return { type: 'quote', ...content, provenance };
}
