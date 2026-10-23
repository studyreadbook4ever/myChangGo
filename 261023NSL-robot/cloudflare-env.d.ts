declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    WEBHOOK_SECRET?: string;
    OPERATOR_TOKEN?: string;
    STAFF_OWNER_EMAIL?: string;
    CLOVA_SPEECH_INVOKE_URL?: string;
    CLOVA_SPEECH_SECRET?: string;
    PAPAGO_CLIENT_ID?: string;
    PAPAGO_CLIENT_SECRET?: string;
    CLOVA_STUDIO_API_KEY?: string;
    CLOVA_STUDIO_MODEL?: string;
    CLOVA_VOICE_CLIENT_ID?: string;
    CLOVA_VOICE_CLIENT_SECRET?: string;
    ROBOT_DAILY_AI_LIMIT?: string;
  }
}
