import { z } from "zod";

const itemSchema = z.object({
  itemId: z.string().min(1).max(100), name: z.string().min(1).max(300),
  quantity: z.number().int().min(1).max(99), unitPrice: z.number().int().min(0), lineTotal: z.number().int().min(0),
});
const orderSchema = z.object({
  schemaVersion: z.literal("1.0"), id: z.string().min(1).max(100), eventId: z.string().min(1).max(100),
  sessionId: z.string().min(1).max(100), table: z.string().min(1).max(32), language: z.enum(["ko", "en", "ja", "zh"]),
  items: z.array(itemSchema).min(1).max(50), total: z.number().int().min(0), currency: z.literal("KRW"),
  customerApproved: z.literal(true), approvedAt: z.string().datetime(), createdAt: z.string().datetime(),
}).refine((order) => order.items.every((item) => item.lineTotal === item.unitPrice * item.quantity)
  && order.total === order.items.reduce((sum, item) => sum + item.lineTotal, 0), "Order totals do not match.");
const serviceSchema = z.object({
  id: z.string().min(1).max(100), sessionId: z.string().min(1).max(100), table: z.string().min(1).max(32),
  language: z.enum(["ko", "en", "ja", "zh"]), naturalLanguage: z.string().min(1).max(8000),
  koreanText: z.string().min(1).max(16000).optional(), status: z.literal("requested"), createdAt: z.string().datetime(),
  translationStatus: z.enum(['complete','pending','failed']).optional(),
});
const envelopeBase = z.object({
  schemaVersion: z.literal("1.0"), eventId: z.string().min(1).max(100), target: z.enum(["kitchen", "robot"]), timestamp: z.string().datetime(),
  staffApprovedAt: z.string().datetime().optional(),
});
export const webhookSchema = z.discriminatedUnion("type", [
  envelopeBase.extend({ type: z.literal("order.created"), data: orderSchema }),
  envelopeBase.extend({ type: z.literal("service.requested"), data: serviceSchema }),
]);

export type ReceiverEvent = z.infer<typeof webhookSchema>;
export type StoredEvent = {
  eventId: string;
  sourceId: string;
  type: ReceiverEvent["type"];
  target: ReceiverEvent["target"];
  payloadHash: string;
  payload: string;
  receivedAt: string;
};
export interface ReceiverStore {
  insertIfAbsent(event: StoredEvent): Promise<boolean>;
  get(eventId: string): Promise<StoredEvent | undefined>;
  list(): Promise<StoredEvent[]>;
}

const encoder = new TextEncoder();
const maximumBodyBytes = 256 * 1024;
const maximumEventAgeMs = 5 * 60 * 1000;

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: message, code }, status);
}
function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signPayload(body: string, secret: string): Promise<string> {
  return "sha256=" + hex(await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(body)));
}

export async function verifySignature(body: Uint8Array, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, (value) => parseInt(value, 16));
  return crypto.subtle.verify("HMAC", await signingKey(secret), bytes, new Uint8Array(body));
}

/** Use WebCrypto's HMAC verification for a constant-time secret comparison. */
async function equalSecret(actual: string, expected: string): Promise<boolean> {
  if (actual.length > 2048) return false;
  const key = await signingKey("DAMDA receiver authorization comparison v1");
  const expectedProof = await crypto.subtle.sign("HMAC", key, encoder.encode(expected));
  return crypto.subtle.verify("HMAC", key, expectedProof, encoder.encode(actual));
}

export async function authorizeOperator(authorization: string | null, operatorToken: string | undefined, signedInPrivateOwner: boolean): Promise<boolean> {
  // The Site's owner-private dispatch policy supplies and protects this identity.
  // Service access alone supplies no identity and still needs this bearer token.
  if (signedInPrivateOwner) return true;
  if (!operatorToken || operatorToken.length < 24 || !authorization) return false;
  return equalSecret(authorization, `Bearer ${operatorToken}`);
}

async function boundedBody(request: Request): Promise<Uint8Array | Response> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maximumBodyBytes)) {
    return errorResponse(413, "PAYLOAD_TOO_LARGE", "Webhook body is too large (maximum256 KB).");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBodyBytes) {
        await reader.cancel();
        return errorResponse(413, "PAYLOAD_TOO_LARGE", "Webhook body is too large (maximum256 KB).");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export async function receiveWebhook(request: Request, dependencies: { secret?: string; store: ReceiverStore; now?: number }): Promise<Response> {
  if (!dependencies.secret || dependencies.secret.length < 32) return errorResponse(503, "WEBHOOK_NOT_CONFIGURED", "Receiver signing secret is not configured.");
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return errorResponse(415, "INVALID_CONTENT_TYPE", "application/json is required.");
  }
  try {
    const bytes = await boundedBody(request);
    if (bytes instanceof Response) return bytes;
    if (!await verifySignature(bytes, request.headers.get("x-kiosk-signature"), dependencies.secret)) {
      return errorResponse(401, "INVALID_SIGNATURE", "Webhook signature does not match.");
    }
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return errorResponse(400, "INVALID_JSON", "Malformed JSON."); }
    const parsed = webhookSchema.safeParse(raw);
    if (!parsed.success) return errorResponse(400, "INVALID_EVENT", "Webhook payload is not a valid kiosk event.");
    const event = parsed.data;
    const now = dependencies.now ?? Date.now();
    const age = now - Date.parse(event.timestamp);
    if (age > maximumEventAgeMs || age < -30000) return errorResponse(401, "EXPIRED_EVENT", "Webhook timestamp is expired or in the future.");
    if(event.target!=='robot')return errorResponse(400,'WRONG_TARGET','Only robot events are accepted.');
    if(event.type==='service.requested') {
      if(!event.staffApprovedAt||Date.parse(event.staffApprovedAt)>now+30000)return errorResponse(403,'STAFF_APPROVAL_REQUIRED','A signed staff approval is required for service requests.');
      if(event.data.language!=='ko'&&(!event.data.koreanText||event.data.translationStatus!=='complete'))return errorResponse(400,'KOREAN_TRANSLATION_REQUIRED','A Korean staff translation is required.');
    }
    // Timestamp changes on a retry. Hash only the immutable event content.
    const payloadHash = hex(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify({ type: event.type, target: event.target, data: event.data, staffApprovedAt:event.staffApprovedAt }))));
    const stored: StoredEvent = {
      eventId: event.eventId, sourceId: event.data.id, type: event.type, target: event.target,
      payloadHash, payload: JSON.stringify(event), receivedAt: new Date(now).toISOString(),
    };
    // A unique PK plus INSERT ... ON CONFLICT DO NOTHING makes simultaneous
    // retries idempotent; read-before-write alone would race across isolates.
    if (await dependencies.store.insertIfAbsent(stored)) return jsonResponse({ accepted: true, duplicate: false, eventId: event.eventId }, 202);
    const existing = await dependencies.store.get(event.eventId);
    if (!existing) return errorResponse(503, "RECEIPT_UNAVAILABLE", "Receipt could not be verified. Please retry the same event.");
    if (existing.payloadHash !== payloadHash || existing.type !== event.type || existing.target !== event.target) {
      return errorResponse(409, "EVENT_ID_CONFLICT", "Event ID already belongs to a different payload.");
    }
    return jsonResponse({ accepted: true, duplicate: true, eventId: event.eventId });
  } catch {
    // Do not log signatures, credentials, raw customer requests or upstream errors.
    return errorResponse(503, "RECEIVER_UNAVAILABLE", "Receiver storage is temporarily unavailable. Retry the same event.");
  }
}

export function receiverData(rows: StoredEvent[]) {
  const events = rows.map((row) => ({ ...JSON.parse(row.payload) as ReceiverEvent, receivedAt: row.receivedAt }));
  const orders = [...new Map(events.filter((event) => event.type === "order.created").map((event) => [event.data.id, event.data])).values()];
  const serviceRequests = [...new Map(events.filter((event) => event.type === "service.requested").map((event) => [event.data.id, event.data])).values()];
  return {
    orders, serviceRequests, events,
    deliveries: events.map((event) => ({
      id: event.eventId, eventId: event.eventId, sourceId: event.data.id, target: event.target,
      status: "delivered", attempts: 1, createdAt: event.timestamp, deliveredAt: event.receivedAt, lastError: null,
    })),
  };
}
