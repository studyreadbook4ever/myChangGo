declare namespace Cloudflare {
  interface Env {
    DAMDA_BACKEND_URL?: string;
    DAMDA_BACKEND_TOKEN?: string;
    DAMDA_GATEWAY_SECRET?: string;
    DAMDA_COOKIE_SECRET?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
