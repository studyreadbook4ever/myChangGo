import type {
  DurableObjectNamespaceLike,
  WorkerRouterOptions,
} from "./types.js";

const DEFAULT_ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;

function normalizePrefix(prefix: string): string {
  const withLeadingSlash = prefix.startsWith("/") ? prefix : `/${prefix}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

function roomIdFromPath(pathname: string, routePrefix: string): string | undefined {
  const prefix = `${routePrefix}/`;
  if (!pathname.startsWith(prefix) || !pathname.endsWith("/ws")) {
    return undefined;
  }
  const encoded = pathname.slice(prefix.length, -"/ws".length);
  if (encoded.length === 0 || encoded.includes("/")) {
    return undefined;
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

function namespaceFromEnvironment(
  environment: object,
  binding: string,
): DurableObjectNamespaceLike | undefined {
  const value = (environment as Record<string, unknown>)[binding];
  if (
    value === null ||
    typeof value !== "object" ||
    !("getByName" in value) ||
    typeof value.getByName !== "function"
  ) {
    return undefined;
  }
  return value as DurableObjectNamespaceLike;
}

/** Creates the thin Worker router in front of one Durable Object per room ID. */
export function createWorker<Env extends object>(options: WorkerRouterOptions = {}) {
  const binding = options.binding ?? "ROOMS";
  const routePrefix = normalizePrefix(options.routePrefix ?? "/rooms");
  const healthPath = options.healthPath ?? "/health";
  const roomIdPattern = options.roomIdPattern ?? DEFAULT_ROOM_ID_PATTERN;
  const allowedOrigins =
    options.allowedOrigins === undefined ? undefined : new Set(options.allowedOrigins);

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === healthPath) {
        return Response.json({ ok: true, service: "relayplay" });
      }
      const roomId = roomIdFromPath(url.pathname, routePrefix);
      if (roomId === undefined) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      roomIdPattern.lastIndex = 0;
      if (!roomIdPattern.test(roomId)) {
        return Response.json({ error: "invalid_room_id" }, { status: 400 });
      }
      if (request.method !== "GET") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET" } },
        );
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return Response.json(
          { error: "websocket_upgrade_required" },
          { status: 426, headers: { Upgrade: "websocket" } },
        );
      }
      const origin = request.headers.get("Origin");
      if (allowedOrigins !== undefined && (origin === null || !allowedOrigins.has(origin))) {
        return Response.json({ error: "origin_not_allowed" }, { status: 403 });
      }

      const namespace = namespaceFromEnvironment(env, binding);
      if (namespace === undefined) {
        return Response.json({ error: "durable_object_binding_missing" }, { status: 500 });
      }
      const forwardedUrl = new URL("https://relayplay.internal/websocket");
      for (const [key, value] of url.searchParams) {
        forwardedUrl.searchParams.append(key, value);
      }
      forwardedUrl.searchParams.set("roomId", roomId);
      return namespace.getByName(roomId).fetch(new Request(forwardedUrl, request));
    },
  };
}
