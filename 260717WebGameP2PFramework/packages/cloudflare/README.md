# RelayPlay Cloudflare adapter

Create an application entrypoint and keep production authentication explicit:

```ts
import {
  createRelayPlayDurableObject,
  createWorker,
  type RelayPlayCloudflareEnv,
} from "@relayplay/cloudflare";

export interface Env extends RelayPlayCloudflareEnv {
  readonly AUTH_ISSUER: string;
}

export class GameRoom extends createRelayPlayDurableObject<Env>({
  authenticate: async (request, env) => {
    // Verify the signed join token against env.AUTH_ISSUER here. Never trust
    // playerId/sessionId query parameters as identity by themselves.
    const claims = await verifyJoinCredential(request.credential, env.AUTH_ISSUER);
    return { playerId: claims.playerId, sessionId: claims.sessionId };
  },
}) {}

export default createWorker<Env>({
  binding: "ROOMS",
  allowedOrigins: ["https://game.example"],
});
```

Copy `wrangler.example.jsonc` to the application, keep the
`new_sqlite_classes` migration, then generate binding types with
`npx wrangler types`. Connect to
`/rooms/<opaque-room-id>/ws?token=<short-lived-join-token>`. Prefer an
HttpOnly bootstrap flow that exchanges a cookie for a single-use token so
credentials do not remain in URLs or logs.

The adapter uses hibernatable WebSockets and a SQLite-backed Durable Object.
Canonical events, idempotency records, session resume state, and token-bucket
rate limits survive object eviction. The exported `RelayPlayDurableObject`
convenience class accepts `RELAYPLAY_INSECURE_DEV_TOKEN` and is deliberately
local-development only; production should always export the authenticated
factory result shown above.
