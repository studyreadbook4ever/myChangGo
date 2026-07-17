export interface ClientIdGenerator {
  next(prefix: "ping" | "interaction" | "ready" | "evidence"): string;
}

let fallbackSequence = 0;

export const browserClientIdGenerator: ClientIdGenerator = {
  next: (prefix) => {
    const randomUuid = globalThis.crypto?.randomUUID;
    if (typeof randomUuid === "function") {
      return `${prefix}_${randomUuid.call(globalThis.crypto)}`;
    }
    fallbackSequence += 1;
    return `${prefix}_${Date.now().toString(36)}_${fallbackSequence.toString(36)}`;
  },
};
