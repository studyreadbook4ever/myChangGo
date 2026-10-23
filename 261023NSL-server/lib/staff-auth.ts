import { authorizeOperator } from './receiver';

/** For this owner-private Site only. Sites dispatch supplies verified identity
 * headers; its service credential supplies no user identity. The pinned email
 * fallback supports a dispatch variant without a user ID, but never invents an
 * ID or grants per-user data access. Leave the pin unset to fail closed. */
export async function authorizePrivateStaff(
  requestHeaders: Headers,
  operatorToken: string | undefined,
  hasCompletePlatformIdentity: boolean,
  pinnedOwnerEmail: string | undefined,
): Promise<boolean> {
  // The public customer gateway is a separate permission boundary.
  if (requestHeaders.has('x-damda-gateway')) return false;
  if (await authorizeOperator(requestHeaders.get('authorization'), operatorToken, false)) return true;
  if (hasCompletePlatformIdentity) return true;
  const email = requestHeaders.get('oai-authenticated-user-email')?.trim().toLowerCase();
  const owner = pinnedOwnerEmail?.trim().toLowerCase();
  const valid = (value: string | undefined): value is string => Boolean(value && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  return valid(email) && valid(owner) && email === owner;
}
