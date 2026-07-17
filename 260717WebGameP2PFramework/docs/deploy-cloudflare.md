# Deploying the Cloudflare adapter

The production adapter maps one active room to one Durable Object instance. The
object serializes room messages, persists canonical events, and uses
hibernatable WebSockets so an idle room does not require a continuously running
game loop.

## Prerequisites

- a Cloudflare account with Workers and Durable Objects enabled;
- Wrangler authenticated for that account;
- an application endpoint that issues short-lived room credentials;
- explicit origin and room-lifecycle policy.

## Local deployment loop

```bash
npm install
npm run build
npm run dev:example
```

Use two browser tabs with distinct development player IDs. The development auth
adapter is intentionally unsuitable for a public deployment.

## Production checklist

1. Replace development auth with a credential verifier.
2. Configure allowed HTTPS origins and reject unexpected `Origin` values.
3. Store secrets with Wrangler secret bindings, never in `wrangler.toml`.
4. Select an event-log retention/resume window and room expiration policy.
5. Bind a Durable Object migration before first deployment.
6. Run `npm run verify` (including the local Durable Object WebSocket smoke).
7. Deploy the worker and smoke-test join, ready, start, interaction, forced
   reconnect, resume, and room expiry.
8. Monitor rejected messages, rate-limit events, reconnect rate, event-log
   growth, alarm errors, and WebSocket backpressure.

The repository's example Wrangler configuration is a development template.
Copy it for an application, change the Worker/object names, and add the
application's auth/environment bindings.

## Routing model

An HTTP route resolves the room ID, validates its syntax, obtains the Durable
Object stub with a deterministic room key, and forwards the upgrade request.
The object owns only that room. Static example assets can be served by the same
Worker in development or by any CDN in production.

Do not derive a Durable Object name from a secret token. Use an opaque room ID,
then authorize access independently.

## Failure behavior

- A failed canonical write must not broadcast an event.
- A restarted/hibernated object reconstructs engine state from storage and
  WebSocket attachment metadata.
- A reconnect supplies room epoch and last contiguous sequence.
- If the retained log cannot satisfy resume, return an explicit fresh-join or
  snapshot-required response.
- Room alarms may expire state and credentials; they must not simulate frames.
