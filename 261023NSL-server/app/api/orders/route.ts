import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { jsonResponse, receiverData } from "@/lib/receiver";
import { authorizePrivateStaff } from "@/lib/staff-auth";
import { getReceiverStore } from "@/lib/receiver-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await getChatGPTUser();
  if (!await authorizePrivateStaff(request.headers, env.OPERATOR_TOKEN, identity !== null, env.STAFF_OWNER_EMAIL)) {
    return jsonResponse({ error: "Operator authentication is required.", code: "OPERATOR_AUTH_REQUIRED" }, 401);
  }
  try {
    return jsonResponse(receiverData(await getReceiverStore().list()));
  } catch {
    return jsonResponse({ error: "Receiver records are temporarily unavailable.", code: "RECEIVER_UNAVAILABLE" }, 503);
  }
}
