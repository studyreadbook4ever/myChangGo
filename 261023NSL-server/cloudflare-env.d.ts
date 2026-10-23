declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    WEBHOOK_SECRET?: string;
    OPERATOR_TOKEN?: string;
    STAFF_OWNER_EMAIL?: string;
    DAMDA_GATEWAY_SECRET?: string;
    CLOVA_SPEECH_INVOKE_URL?: string;
    CLOVA_SPEECH_SECRET?: string;
    CLOVA_SPEECH_MENU_BOOSTING?: string;
    PAPAGO_CLIENT_ID?: string;
    PAPAGO_CLIENT_SECRET?: string;
    CLOVA_STUDIO_API_KEY?: string;
    CLOVA_STUDIO_MODEL?: string;
    KITCHEN_WEBHOOK_URL?: string;
    ROBOT_WEBHOOK_URL?: string;
    KITCHEN_WEBHOOK_SITES_TOKEN?: string;
    ROBOT_WEBHOOK_SITES_TOKEN?: string;
    KIOSK_CLIENT_DAILY_LIMIT?: string;
    KIOSK_GLOBAL_DAILY_LIMIT?: string;
  }
}
