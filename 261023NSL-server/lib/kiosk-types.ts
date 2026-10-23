export type Language = 'ko' | 'en' | 'ja' | 'zh';
export type MenuItem = { id: string; name: Record<Language,string>; description: Record<Language,string>; price: number; category: string; image?: string; spicy?: boolean; vegetarian?: boolean; allergens: string[] };
export type Session = { id: string; language: Language; table: string; version: number; cart: { itemId:string; quantity:number }[]; messages: { role:string; text:string; kind?:string; at?:string }[]; confirmationToken:string|null; createdAt:string; updatedAt:string };
export type Operation = { itemId:string; quantity:number; action:'add'|'remove'|'set' };
export type Providers = {
  providerStatus: () => unknown | Promise<unknown>;
  transcribe: (input: { buffer: Uint8Array; mimeType:string; language:Language; kind:'order'|'service'; menu?:MenuItem[] }) => Promise<string>;
  translate: (input: { text:string; source:Language; target:Language }) => Promise<string>;
  chat: (input: { text:string; language:Language; originalTranscript:string; originalLanguage:Language; menu:MenuItem[]; cart:Session['cart']; history:Session['messages']; kind:'order'|'service' }) => Promise<{ replyKo:string; operations:Operation[] }>;
};
export type KioskEnv = {
  DB: D1Database;
  DAMDA_GATEWAY_SECRET?:string;
  WEBHOOK_SECRET?:string;
  KITCHEN_WEBHOOK_URL?:string;
  ROBOT_WEBHOOK_URL?:string;
  KITCHEN_WEBHOOK_SITES_TOKEN?:string;
  ROBOT_WEBHOOK_SITES_TOKEN?:string;
  KIOSK_CLIENT_DAILY_LIMIT?:string;
  KIOSK_GLOBAL_DAILY_LIMIT?:string;
  CLOVA_SPEECH_INVOKE_URL?:string;
  CLOVA_SPEECH_SECRET?:string;
  PAPAGO_CLIENT_ID?:string;
  PAPAGO_CLIENT_SECRET?:string;
  CLOVA_STUDIO_API_KEY?:string;
  CLOVA_STUDIO_MODEL?:string;
  CLOVA_SPEECH_MENU_BOOSTING?:string;
};
export class KioskError extends Error {
  status:number; code:string;
  constructor(status:number, code:string, message:string) { super(message); this.status=status; this.code=code; }
}
