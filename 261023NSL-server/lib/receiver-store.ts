import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { receivedEvents } from "@/db/schema";
import type { ReceiverStore, StoredEvent } from "@/lib/receiver";
import { recentReceiptsQuery } from "@/lib/receipt-window";

export function getReceiverStore(): ReceiverStore {
  const db = getDb();
  return {
    async insertIfAbsent(event) {
      const inserted = await db.insert(receivedEvents).values(event)
        .onConflictDoNothing({ target: receivedEvents.eventId })
        .returning({ eventId: receivedEvents.eventId });
      return inserted.length > 0;
    },
    async get(eventId) {
      return db.select().from(receivedEvents).where(eq(receivedEvents.eventId, eventId)).get();
    },
    async list() {
      return db.all<StoredEvent>(recentReceiptsQuery);
    },
  };
}
