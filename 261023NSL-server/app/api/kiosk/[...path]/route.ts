import { env } from 'cloudflare:workers';
import { handleKiosk } from '@/lib/kiosk-api';
import { createKioskProviders } from '@/lib/kiosk-providers';
import type { KioskEnv } from '@/lib/kiosk-types';

export const dynamic='force-dynamic';
async function dispatch(request:Request) {
  return handleKiosk(request,env as unknown as KioskEnv,createKioskProviders(env));
}
export const GET=dispatch;
export const POST=dispatch;
