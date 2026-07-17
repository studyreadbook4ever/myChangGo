# @relayplay/core

Shared, runtime-safe primitives for RelayPlay: nested configuration, game and
platform presets, protocol envelopes, strict validators, clock estimation,
fixed-tick conversion, and capability policy. It has no runtime dependency.

```ts
import {
  createPresetConfig,
  safeDecodeClientMessage,
} from "@relayplay/core";

const config = createPresetConfig("falling-block-battle", "universal", {
  progress: { intervalMs: 1_000 },
  platform: { crossPlay: { rankedPool: "same-input-preferred" } },
});

const decoded = safeDecodeClientMessage(frame, {
  maxMessageBytes: config.security.maxMessageBytes,
  maxPayloadBytes: config.security.maxPayloadBytes,
});
```

Configuration input is deep-partial, but normalization returns a complete
immutable-shape value or throws `ConfigValidationError`. Every protocol type has
a corresponding runtime parser; never cast network JSON directly.

See the repository's `docs/configuration.md` and `docs/protocol.md`.
