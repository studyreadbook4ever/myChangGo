import type { KioskEnv,Providers } from './kiosk-types';
import { flushKioskOutbox,deliveryStatusSql } from './kiosk-outbox';
import { flushKioskTranslations } from './kiosk-translations';

export async function sourceStage(env:KioskEnv,sourceId:string) {
  return (await env.DB.prepare('SELECT stage FROM kiosk_operation_states WHERE source_id=?').bind(sourceId).first<{stage:string}>())?.stage||'new';
}
export async function customerHistory(env:KioskEnv,client:string,providers:Providers,fetchImpl:typeof fetch) {
  // Drain the customer's oldest due work, including earlier additional orders.
  // Polling this history cannot cause work for another customer.
  await flushKioskTranslations(env,providers,undefined,client);
  await flushKioskOutbox(env,fetchImpl,undefined,client);
  const orders=await env.DB.prepare('SELECT o.id,o.payload,COALESCE(s.stage,\'new\') AS stage FROM kiosk_orders o JOIN kiosk_sessions c ON c.id=o.session_id LEFT JOIN kiosk_operation_states s ON s.source_id=o.id WHERE c.client_hash=? ORDER BY o.created_at DESC LIMIT 100').bind(client).all<{id:string;payload:string;stage:string}>();
  const rows=(await env.DB.prepare(`WITH recent_orders AS (SELECT o.id FROM kiosk_orders o JOIN kiosk_sessions c ON c.id=o.session_id WHERE c.client_hash=? ORDER BY o.created_at DESC LIMIT 100),
    recent_services AS (SELECT o.id FROM kiosk_services o JOIN kiosk_sessions c ON c.id=o.session_id WHERE c.client_hash=? ORDER BY o.created_at DESC LIMIT 20)
    SELECT id,event_id,source_id,target,${deliveryStatusSql} AS status,attempts,last_error,delivered_at,created_at FROM kiosk_outbox WHERE source_id IN (SELECT id FROM recent_orders UNION ALL SELECT id FROM recent_services)`)
    .bind(client,client).all<{id:string;event_id:string;source_id:string;target:string;status:string;attempts:number;last_error:string|null;delivered_at:string|null;created_at:string}>()).results;
  const deliveries=(id:string)=>rows.filter(row=>row.source_id===id).map(row=>({id:row.id,eventId:row.event_id,sourceId:row.source_id,target:row.target,status:row.status,attempts:row.attempts,lastError:row.last_error,deliveredAt:row.delivered_at,createdAt:row.created_at}));
  // Refresh service payloads after a pending translation was processed.
  const refreshed=await env.DB.prepare('SELECT o.id,o.payload,COALESCE(s.stage,\'new\') AS stage FROM kiosk_services o JOIN kiosk_sessions c ON c.id=o.session_id LEFT JOIN kiosk_operation_states s ON s.source_id=o.id WHERE c.client_hash=? ORDER BY o.created_at DESC LIMIT 20').bind(client).all<{id:string;payload:string;stage:string}>();
  const requests=refreshed.results.map(row=>{
    const request=JSON.parse(row.payload);delete request.koreanText;
    return {...request,stage:row.stage,deliveries:deliveries(row.id)};
  });
  return {orders:orders.results.map(row=>({...JSON.parse(row.payload),stage:row.stage,deliveries:deliveries(row.id)})),serviceRequests:requests,paymentPolicy:'pay-at-counter',limits:{orders:100,serviceRequests:20}};
}
