import { env } from "cloudflare:workers";
import { jsonResponse, receiveWebhook } from "@/lib/receiver";
import { getReceiverStore } from "@/lib/receiver-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    return await receiveWebhook(request, { secret: env.WEBHOOK_SECRET, store: getReceiverStore() });
  } catch {
    return jsonResponse({ error: "Receiver storage is not available.", code: "RECEIVER_UNAVAILABLE" }, 503);
  }
}
