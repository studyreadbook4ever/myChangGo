export interface GuestCookieOptions {
  readonly name?: string;
  readonly secure: boolean;
  readonly roomId: string;
  readonly credential: string;
  readonly expiresAt: number;
  readonly now: number;
}

export function guestCookieName(secure: boolean, configured?: string): string {
  return configured ?? (secure ? "__Secure-relayplay_guest" : "relayplay_guest");
}

export function serializeGuestCookie(options: GuestCookieOptions): string {
  const name = guestCookieName(options.secure, options.name);
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name)) {
    throw new TypeError("cookie name contains unsafe characters");
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(options.credential)) {
    throw new TypeError("credential is not cookie-safe");
  }
  const maxAge = Math.max(0, Math.floor((options.expiresAt - options.now) / 1_000));
  const fields = [
    `${name}=${options.credential}`,
    `Path=/rooms/${encodeURIComponent(options.roomId)}`,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${String(maxAge)}`,
  ];
  if (options.secure) fields.push("Secure");
  return fields.join("; ");
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header.length > 8_192) return undefined;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (found !== undefined && found !== value) return undefined;
    found = value;
  }
  return found;
}
