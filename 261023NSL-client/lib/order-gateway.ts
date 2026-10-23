/** Public customer boundary. Runtime credentials never leave this module. */
export interface GatewayEnv {
  DAMDA_BACKEND_URL?: string;
  DAMDA_BACKEND_TOKEN?: string;
  DAMDA_GATEWAY_SECRET?: string;
  DAMDA_COOKIE_SECRET?: string;
}
const encoder = new TextEncoder();
const deviceName = '__Host-damda-device';
const sessionName = '__Host-damda-session';
const maxBody = 2_200_000;
const maxResponse = 1_000_000;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const allowed: [string, RegExp][] = [
  ['GET', /^\/(health|menu|orders)$/],
  ['POST', /^\/sessions$/],
  ['GET', new RegExp(`^/sessions/${uuid}$`)],
  ['POST', new RegExp(`^/sessions/${uuid}/(cart|turn|prepare|confirm)$`)],
  ['GET', new RegExp(`^/sessions/${uuid}/orders/ord_${uuid}$`)],
  ['GET', new RegExp(`^/sessions/${uuid}/service-requests/svc_${uuid}$`)],
  ['POST', /^\/tts$/],
];
function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
}
function failure(code: string, status: number) {
  return json({ code, error: code === 'SESSION_REQUIRED' ? '주문 화면을 새로 열어 주세요.' : code === 'REQUEST_TOO_LARGE' ? '말씀을 조금 짧게 녹음해 주세요.' : '연결을 확인한 뒤 다시 시도해 주세요.' }, status);
}
function unavailable(reason: string, details: Record<string, unknown> = {}) {
  console.warn('damda_gateway_unavailable', { reason, ...details });
  return failure('SERVICE_UNAVAILABLE', 503);
}
function hex(bytes: ArrayBuffer) { return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join(''); }
async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
async function verify(secret: string, value: string, signature: string) {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, Uint8Array.from(signature.match(/../g)!, c => parseInt(c, 16)), encoder.encode(value));
}
function cookies(request: Request) {
  const result = new Map<string, string>();
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const split = part.indexOf('=');
    if (split > 0) result.set(part.slice(0, split).trim(), part.slice(split + 1).trim());
  }
  return result;
}
async function cookieValue(secret: string, kind: string, id: string, device: string, expires: number) {
  const value = `${id}.${expires}.${device}`;
  return `${value}.${await hmac(secret, kind + ':' + value)}`;
}
async function cookieId(secret: string, kind: string, value: string | undefined, now: number, device?: string) {
  if (!value || value.length > 300) return null;
  const parts = value.split('.');
  if (parts.length !== 4 || !new RegExp(`^${uuid}$`).test(parts[0]) || !/^\d{13}$/.test(parts[1]) || Number(parts[1]) <= now || (device !== undefined && parts[2] !== device)) return null;
  return await verify(secret, kind + ':' + parts.slice(0, 3).join('.'), parts[3]) ? parts[0] : null;
}
function setCookie(headers: Headers, name: string, value: string) {
  headers.append('set-cookie', `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
}
async function bounded(stream: ReadableStream<Uint8Array> | null, limit: number) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) { await reader.cancel(); throw new Error('too_large'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total); let position = 0;
  for (const chunk of chunks) { result.set(chunk, position); position += chunk.length; }
  return result;
}
export async function orderGateway(request: Request, config: GatewayEnv, transport: typeof fetch = fetch, now = Date.now()) {
  const url = new URL(request.url);
  const path = url.pathname.slice(4);
  if (!url.pathname.startsWith('/api/') || url.search || !allowed.some(([method, pattern]) => request.method === method && pattern.test(path))) return failure('NOT_FOUND', 404);
  if (request.method === 'POST' && request.headers.get('origin') !== url.origin) return failure('ORIGIN_REJECTED', 403);
  const secret = config.DAMDA_COOKIE_SECRET;
  if (!secret || secret.length < 32 || !config.DAMDA_GATEWAY_SECRET || config.DAMDA_GATEWAY_SECRET.length < 32 || !config.DAMDA_BACKEND_TOKEN) return unavailable('configuration');
  let target: URL;
  try {
    target = new URL(config.DAMDA_BACKEND_URL || '');
    if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || target.pathname !== '/') return unavailable('backend_url');
  } catch { return unavailable('backend_url'); }
  const jar = cookies(request);
  const verifiedDevice = await cookieId(secret, 'device', jar.get(deviceName), now);
  // Only the awaited bootstrap request may create a device. Concurrent menu or
  // history responses must never replace a new ordering session's ownership.
  if (!verifiedDevice && path !== '/health') return failure('DEVICE_REQUIRED', 401);
  const device = verifiedDevice || crypto.randomUUID();
  const session = await cookieId(secret, 'session', jar.get(sessionName), now, device);
  const requestedSession = path.split('/')[1] === 'sessions' ? path.split('/')[2] : undefined;
  if ((requestedSession && requestedSession !== session) || (path === '/tts' && !session)) return failure('SESSION_REQUIRED', 401);
  let body: Uint8Array | undefined;
  const type = request.headers.get('content-type') || '';
  if (request.method === 'POST') {
    if (!(type.startsWith('application/json') || (path.endsWith('/turn') && type.startsWith('multipart/form-data;')))) return failure('INVALID_CONTENT_TYPE', 415);
    if (Number(request.headers.get('content-length')) > maxBody) return failure('REQUEST_TOO_LARGE', 413);
    try { body = await bounded(request.body, maxBody); } catch { return failure('REQUEST_TOO_LARGE', 413); }
  }
  const headers = new Headers({
    'OAI-Sites-Authorization': `Bearer ${config.DAMDA_BACKEND_TOKEN}`,
    'X-Damda-Gateway': config.DAMDA_GATEWAY_SECRET,
    'X-Damda-Client': await hmac(secret, 'client:' + device),
    'accept': 'application/json',
  });
  if (body) headers.set('content-type', type);
  target.pathname = '/api/kiosk' + path;
  let upstream: Response;
  try {
    upstream = await transport(target.href, { method: request.method, headers, body: body as BodyInit | undefined, redirect: 'manual', signal: AbortSignal.timeout(115_000) });
  } catch (error) {
    let message = error instanceof Error ? error.message : 'unknown';
    for (const value of Object.values(config)) if (typeof value === 'string' && value) message = message.split(value).join('[redacted]');
    return unavailable('transport', { errorType: error instanceof Error ? error.name : 'unknown', message: message.slice(0, 240) });
  }
  if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); return unavailable('upstream_redirect'); }
  if (!(upstream.headers.get('content-type') || '').includes('application/json')) { await upstream.body?.cancel(); return unavailable('upstream_format', { status: upstream.status }); }
  let data: Record<string, unknown>;
  try { data = JSON.parse(new TextDecoder().decode(await bounded(upstream.body, maxResponse))); } catch { return unavailable('upstream_body'); }
  const result = json(data, upstream.status);
  setCookie(result.headers, deviceName, await cookieValue(secret, 'device', device, '', now + 86_400_000));
  if (path === '/sessions' && request.method === 'POST' && upstream.ok) {
    const created = (data.session as { id?: string } | undefined)?.id || data.id;
    if (typeof created !== 'string' || !new RegExp(`^${uuid}$`).test(created)) return failure('SERVICE_UNAVAILABLE', 503);
    setCookie(result.headers, sessionName, await cookieValue(secret, 'session', created, device, now + 86_400_000));
  }
  return result;
}
