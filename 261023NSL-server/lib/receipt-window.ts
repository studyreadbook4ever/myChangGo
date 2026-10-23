import { sql } from "drizzle-orm";

export const RECEIPT_SOURCE_LIMIT = 100;

// Select whole order/request groups first. Limiting individual events can hide
// a group's older robot or kitchen receipt and incorrectly report it as missing.
// Retain the latest receipt for each target, even when it arrived much earlier.
// Extra event IDs for the same source/target cannot make the response unbounded.
export const recentReceiptsQuery = sql`
  WITH recent_sources AS (
    SELECT source_id, MAX(received_at) AS latest_received_at
    FROM received_events
    GROUP BY source_id
    ORDER BY latest_received_at DESC, source_id DESC
    LIMIT ${RECEIPT_SOURCE_LIMIT}
  ), ranked_receipts AS (
    SELECT events.*, recent_sources.latest_received_at,
      ROW_NUMBER() OVER (
        PARTITION BY events.source_id, events.target
        ORDER BY events.received_at DESC, events.event_id DESC
      ) AS target_rank
    FROM received_events AS events
    INNER JOIN recent_sources ON recent_sources.source_id = events.source_id
    WHERE events.target IN ('kitchen', 'robot')
  )
  SELECT event_id AS "eventId", source_id AS "sourceId", type, target,
    payload_hash AS "payloadHash", payload, received_at AS "receivedAt"
  FROM ranked_receipts
  WHERE target_rank = 1
  ORDER BY latest_received_at DESC, source_id DESC, target ASC
  LIMIT ${RECEIPT_SOURCE_LIMIT * 2}
`;
