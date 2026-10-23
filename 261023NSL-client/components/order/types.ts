export type Language = "ko" | "en" | "ja" | "zh";
export type Localized = Record<Language, string>;
export type MenuItem = {
  id: string;
  name: Localized;
  description: Localized;
  price: number;
  category: string;
  image?: string;
  spicy?: boolean;
  vegetarian?: boolean;
  allergens: string[];
};
export type Session = {
  id: string;
  language: Language;
  table: string;
  version: number;
  cart: { itemId: string; quantity: number }[];
  messages: { role: string; text: string; kind?: string; at?: string }[];
  confirmationToken: string | null;
};
export type Health = {
  mode: string;
  audioOutputEnabled?: boolean;
  providers: { voice?: { available: boolean }; [key: string]: unknown };
  demoOperatorToken?: string;
};
export type Trace = { stage: string; status: string; durationMs?: number };
export type OrderItem = {
  itemId: string;
  name: string | Localized;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};
export type Confirmation = {
  token: string;
  version: number;
  summary: OrderItem[];
  total: number;
  expiresAt: string;
};
export type Order = {
  id: string;
  eventId?: string;
  table: string;
  language: Language;
  items: OrderItem[];
  total: number;
  currency: string;
  createdAt: string;
  customerApproved: boolean;
};
export type Delivery = {
  id?: string;
  orderId?: string;
  sourceId?: string;
  target?: string;
  destination?: string;
  status: string;
  attempts?: number;
  lastError?: string;
  [key: string]: unknown;
};
export type ServiceRequest = {
  id: string;
  sessionId: string;
  table: string;
  language: Language;
  naturalLanguage: string;
  koreanText?: string;
  status: string;
  createdAt: string;
};
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    path.includes("/turn") || path.includes("/prepare") ? 120000 : 30000,
  );
  try {
    const response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        ...init?.headers,
      },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    } & T;
    if (!response.ok) {
      const error = new Error(
        body.error || `Request failed (${response.status})`,
      );
      Object.assign(error, {
        code: body.code || "NETWORK_ERROR",
        status: response.status,
      });
      throw error;
    }
    return body as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
export const json = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});
export const money = (amount: number) => `₩${amount.toLocaleString("ko-KR")}`;
export const itemName = (value: string | Localized, lang: Language = "ko") =>
  typeof value === "string" ? value : value?.[lang] || value?.ko || "";
