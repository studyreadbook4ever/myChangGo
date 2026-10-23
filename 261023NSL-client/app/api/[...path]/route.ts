import { env } from 'cloudflare:workers';
import { orderGateway } from '@/lib/order-gateway';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => orderGateway(request, env);
export const POST = (request: Request) => orderGateway(request, env);
