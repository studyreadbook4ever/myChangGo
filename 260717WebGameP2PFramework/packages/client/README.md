# @relayplay/client

Browser SDK for RelayPlay rooms. It sends periodic progress, synchronizes server
time, delivers ordered canonical interactions, and resumes by room epoch and
sequence. It never opens a browser-to-browser connection.

```ts
import { RelayPlayClient } from "@relayplay/client";

const client = new RelayPlayClient({
  url: "wss://game.example/rooms/{roomId}/ws",
  roomId: "opaque-room-01",
  token: () => getOneUseJoinTicket(),
  playerId: "opaque-player-01",
});

client.startProgress(() => ({ score, normalizedProgress }));
client.on("interaction", scheduleCanonicalInteraction);
await client.connect();
client.setReady(true);
```

The local game loop remains the application's responsibility and must not await
SDK methods per frame. Use `client.clock.toLocalTime()` for canonical
server-time schedules, or map tick/beat/boundary schedules into the game.

See the repository example at `examples/live-race`.
