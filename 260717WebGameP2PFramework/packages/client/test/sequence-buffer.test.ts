import { describe, expect, it } from "vitest";
import { CanonicalSequenceBuffer } from "../src/sequence-buffer.js";

interface TestEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly value: string;
}

describe("CanonicalSequenceBuffer", () => {
  it("buffers gaps and releases only a contiguous sequence", () => {
    const buffer = new CanonicalSequenceBuffer<TestEvent>();

    expect(buffer.ingest({ eventId: "e2", sequence: 2, value: "two" })).toMatchObject({
      status: "gap",
      expectedSequence: 1,
    });
    const result = buffer.ingest({ eventId: "e1", sequence: 1, value: "one" });
    expect(result).toEqual({
      status: "accepted",
      events: [
        { eventId: "e1", sequence: 1, value: "one" },
        { eventId: "e2", sequence: 2, value: "two" },
      ],
      lastSequence: 2,
    });
  });

  it("deduplicates by sequence and stable event id", () => {
    const buffer = new CanonicalSequenceBuffer<TestEvent>();
    buffer.ingest({ eventId: "same", sequence: 1, value: "first" });

    expect(
      buffer.ingest({ eventId: "same", sequence: 1, value: "retry" }).status,
    ).toBe("duplicate");
    expect(buffer.lastSequence).toBe(1);
  });

  it("rejects canonical identity conflicts instead of hiding them as duplicates", () => {
    const buffer = new CanonicalSequenceBuffer<TestEvent>();
    buffer.ingest({ eventId: "stable", sequence: 1, value: "first" });

    expect(() =>
      buffer.ingest({ eventId: "different", sequence: 1, value: "conflict" }),
    ).toThrow(/changed event ID/u);
    expect(() =>
      buffer.ingest({ eventId: "stable", sequence: 2, value: "conflict" }),
    ).toThrow(/changed sequence/u);
  });

  it("rejects conflicts while events are buffered across a gap", () => {
    const buffer = new CanonicalSequenceBuffer<TestEvent>();
    buffer.ingest({ eventId: "future", sequence: 2, value: "future" });

    expect(() =>
      buffer.ingest({ eventId: "other", sequence: 2, value: "conflict" }),
    ).toThrow(/conflicting event IDs/u);
    expect(() =>
      buffer.ingest({ eventId: "future", sequence: 3, value: "conflict" }),
    ).toThrow(/conflicting sequences/u);
  });
});
