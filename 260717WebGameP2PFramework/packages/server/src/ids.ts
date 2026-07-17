import type { IdGenerator } from "./types.js";

function randomIdentifier(prefix: string): string {
  const random = new Uint8Array(16);
  globalThis.crypto.getRandomValues(random);
  const encoded = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${encoded}`;
}

export const systemIds: IdGenerator = {
  eventId: () => randomIdentifier("evt"),
  sessionId: () => randomIdentifier("ses"),
};

export const systemClock = {
  now: (): number => Date.now(),
};
