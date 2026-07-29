export interface SequencedEvent {
  readonly eventId: string;
  readonly sequence: number;
}

export type SequenceIngestResult<Event extends SequencedEvent> =
  | {
      readonly status: "duplicate";
      readonly event: Event;
      readonly lastSequence: number;
    }
  | {
      readonly status: "gap";
      readonly event: Event;
      readonly expectedSequence: number;
      readonly receivedSequence: number;
      readonly lastSequence: number;
    }
  | {
      readonly status: "accepted";
      readonly events: readonly Event[];
      readonly lastSequence: number;
    };

export interface CanonicalSequenceBufferOptions {
  readonly initialSequence?: number;
  readonly maxBufferedEvents?: number;
  readonly rememberedEventIds?: number;
}

/** Makes an out-of-order transport look like one contiguous canonical log. */
export class CanonicalSequenceBuffer<Event extends SequencedEvent> {
  readonly #buffered = new Map<number, Event>();
  readonly #bufferedIds = new Map<string, number>();
  readonly #seenIds = new Map<string, number>();
  readonly #seenSequences = new Map<number, string>();
  readonly #seenQueue: Array<{ readonly eventId: string; readonly sequence: number }> = [];
  readonly #maxBufferedEvents: number;
  readonly #rememberedEventIds: number;
  #lastSequence: number;

  constructor(options: CanonicalSequenceBufferOptions = {}) {
    const initialSequence = options.initialSequence ?? 0;
    if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) {
      throw new RangeError("initialSequence must be a non-negative safe integer.");
    }
    const maxBufferedEvents = options.maxBufferedEvents ?? 64;
    if (!Number.isSafeInteger(maxBufferedEvents) || maxBufferedEvents <= 0) {
      throw new RangeError("maxBufferedEvents must be a positive safe integer.");
    }
    const rememberedEventIds = options.rememberedEventIds ?? 1_024;
    if (!Number.isSafeInteger(rememberedEventIds) || rememberedEventIds <= 0) {
      throw new RangeError("rememberedEventIds must be a positive safe integer.");
    }

    this.#lastSequence = initialSequence;
    this.#maxBufferedEvents = maxBufferedEvents;
    this.#rememberedEventIds = rememberedEventIds;
  }

  get lastSequence(): number {
    return this.#lastSequence;
  }

  get bufferedCount(): number {
    return this.#buffered.size;
  }

  /** Lowest received sequence still waiting behind a gap, if any. */
  get firstBufferedSequence(): number | undefined {
    if (this.#buffered.size === 0) {
      return undefined;
    }
    return Math.min(...this.#buffered.keys());
  }

  ingest(event: Event): SequenceIngestResult<Event> {
    if (
      !Number.isSafeInteger(event.sequence) ||
      event.sequence <= 0 ||
      event.eventId.length === 0
    ) {
      throw new TypeError("Canonical events require a positive sequence and eventId.");
    }

    const rememberedSequence = this.#seenIds.get(event.eventId);
    if (rememberedSequence !== undefined && rememberedSequence !== event.sequence) {
      throw new Error(
        `Canonical event ID ${event.eventId} changed sequence from ${rememberedSequence} to ${event.sequence}.`,
      );
    }
    const rememberedEventId = this.#seenSequences.get(event.sequence);
    if (rememberedEventId !== undefined && rememberedEventId !== event.eventId) {
      throw new Error(
        `Canonical sequence ${event.sequence} changed event ID from ${rememberedEventId} to ${event.eventId}.`,
      );
    }
    const bufferedSequence = this.#bufferedIds.get(event.eventId);
    if (bufferedSequence !== undefined && bufferedSequence !== event.sequence) {
      throw new Error(
        `Buffered canonical event ID ${event.eventId} has conflicting sequences.`,
      );
    }
    const bufferedEvent = this.#buffered.get(event.sequence);
    if (bufferedEvent !== undefined && bufferedEvent.eventId !== event.eventId) {
      throw new Error(
        `Buffered canonical sequence ${event.sequence} has conflicting event IDs.`,
      );
    }

    if (
      event.sequence <= this.#lastSequence ||
      rememberedSequence !== undefined ||
      bufferedEvent !== undefined
    ) {
      return {
        status: "duplicate",
        event,
        lastSequence: this.#lastSequence,
      };
    }

    const expectedSequence = this.#lastSequence + 1;
    if (event.sequence !== expectedSequence) {
      if (this.#buffered.size >= this.#maxBufferedEvents) {
        const furthestSequence = Math.max(...this.#buffered.keys());
        if (event.sequence >= furthestSequence) {
          return {
            status: "gap",
            event,
            expectedSequence,
            receivedSequence: event.sequence,
            lastSequence: this.#lastSequence,
          };
        }
        const discarded = this.#buffered.get(furthestSequence);
        this.#buffered.delete(furthestSequence);
        if (discarded !== undefined) {
          this.#bufferedIds.delete(discarded.eventId);
        }
      }
      this.#buffered.set(event.sequence, event);
      this.#bufferedIds.set(event.eventId, event.sequence);
      return {
        status: "gap",
        event,
        expectedSequence,
        receivedSequence: event.sequence,
        lastSequence: this.#lastSequence,
      };
    }

    const accepted: Event[] = [event];
    this.#accept(event);
    let next = this.#buffered.get(this.#lastSequence + 1);
    while (next !== undefined) {
      this.#buffered.delete(next.sequence);
      this.#bufferedIds.delete(next.eventId);
      accepted.push(next);
      this.#accept(next);
      next = this.#buffered.get(this.#lastSequence + 1);
    }
    return {
      status: "accepted",
      events: accepted,
      lastSequence: this.#lastSequence,
    };
  }

  reset(lastSequence = 0): void {
    if (!Number.isSafeInteger(lastSequence) || lastSequence < 0) {
      throw new RangeError("lastSequence must be a non-negative safe integer.");
    }
    this.#lastSequence = lastSequence;
    this.#buffered.clear();
    this.#bufferedIds.clear();
    this.#seenIds.clear();
    this.#seenSequences.clear();
    this.#seenQueue.length = 0;
  }

  #accept(event: Event): void {
    this.#lastSequence = event.sequence;
    this.#seenIds.set(event.eventId, event.sequence);
    this.#seenSequences.set(event.sequence, event.eventId);
    this.#seenQueue.push({ eventId: event.eventId, sequence: event.sequence });
    while (this.#seenQueue.length > this.#rememberedEventIds) {
      const discarded = this.#seenQueue.shift();
      if (discarded !== undefined) {
        this.#seenIds.delete(discarded.eventId);
        this.#seenSequences.delete(discarded.sequence);
      }
    }
  }
}
