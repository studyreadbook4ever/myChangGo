import {env} from 'cloudflare:workers';
import {receiveWebhook,jsonResponse} from '@/lib/robot-receiver';
import {robotReceiverStore} from '@/lib/robot-store';
export const dynamic='force-dynamic';
export async function POST(request:Request){
  if(!env.DB)return jsonResponse({code:'DATABASE_UNAVAILABLE',error:'Robot storage is not configured.'},503);
  return receiveWebhook(request,{secret:env.WEBHOOK_SECRET,store:robotReceiverStore(env.DB)});
}
