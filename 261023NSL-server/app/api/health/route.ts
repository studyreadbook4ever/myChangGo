import { env } from "cloudflare:workers";
import { jsonResponse } from "@/lib/receiver";

export const dynamic = "force-dynamic";

export async function GET() {
  const configured = {
    database: Boolean(env.DB), webhook: Boolean(env.WEBHOOK_SECRET && env.WEBHOOK_SECRET.length >= 32),
    operator: Boolean(env.OPERATOR_TOKEN && env.OPERATOR_TOKEN.length >= 24),
  };
  const ready = configured.database && configured.webhook && configured.operator;
  return jsonResponse({ ok: ready, mode: "live", role: "receiver", providers: {}, storage: "d1", configured }, ready ? 200 : 503);
}
