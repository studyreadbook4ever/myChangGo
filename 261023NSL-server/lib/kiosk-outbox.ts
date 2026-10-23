import { signPayload } from './receiver';
import type { KioskEnv } from './kiosk-types';

type OutboxRow = { id:string; event_id:string; source_id:string; target:'kitchen'|'robot'; url:string; payload:string; status:string; attempts:number; next_attempt_at:number; last_error:string|null; delivered_at:string|null; created_at:string };
// Older queued service events are also held: only the protected staff action
// writes this envelope marker. Food-order delivery does not need this marker.
export const staffRobotAllowedSql="(target!='robot' OR json_extract(payload,'$.type')!='service.requested' OR json_extract(payload,'$.staffApprovedAt') IS NOT NULL)";
export const deliveryStatusSql=`CASE WHEN status!='delivered' AND NOT ${staffRobotAllowedSql} THEN 'awaiting_staff' ELSE status END`;
export function targets(env:KioskEnv) {
  return [
    { name:'kitchen', url:env.KITCHEN_WEBHOOK_URL, token:env.KITCHEN_WEBHOOK_SITES_TOKEN },
    { name:'robot', url:env.ROBOT_WEBHOOK_URL, token:env.ROBOT_WEBHOOK_SITES_TOKEN },
  ];
}
export function deliveryConfigured(env:KioskEnv):boolean {
  return Boolean(env.WEBHOOK_SECRET && env.WEBHOOK_SECRET.length>=32 && targets(env).every(t=>{
    try { const u=new URL(t.url || ''); return u.protocol==='https:' && !u.username && !u.password && u.pathname==='/api/webhooks/orders' && Boolean(t.token); } catch { return false; }
  }));
}
export function enqueueStatements(env:KioskEnv, type:'order.created'|'service.requested', data:{id:string}, sessionId:string, lock:string, status='queued'):D1PreparedStatement[] {
  const now=new Date().toISOString();
  return targets(env).map(target=>{
    const id=`del_${crypto.randomUUID()}`, eventId=`evt_${crypto.randomUUID()}`;
    const event={schemaVersion:'1.0',eventId,type,target:target.name,timestamp:now,data};
    return env.DB.prepare(`INSERT INTO kiosk_outbox (id,event_id,source_id,target,url,payload,status,next_attempt_at,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM kiosk_sessions WHERE id=? AND lock_owner=?)`)
      .bind(id,eventId,data.id,target.name,target.url || '',JSON.stringify(event),type==='service.requested'&&target.name==='robot'?'awaiting_staff':status,Date.now(),now,sessionId,lock);
  });
}
export async function listDeliveries(db:D1Database, sourceId:string) {
  const rows=await db.prepare(`SELECT id,event_id,source_id,target,${deliveryStatusSql} AS status,attempts,last_error,delivered_at,created_at FROM kiosk_outbox WHERE source_id=? ORDER BY target`).bind(sourceId).all<OutboxRow>();
  return rows.results.map(row=>({id:row.id,eventId:row.event_id,sourceId:row.source_id,target:row.target,status:row.status,attempts:row.attempts,lastError:row.last_error,deliveredAt:row.delivered_at,createdAt:row.created_at}));
}

/** Poll-driven durable retries. Claims are persisted so concurrent isolates cannot
 * send the same attempt; stable event IDs make a lost HTTP acknowledgement safe. */
export async function flushKioskOutbox(env:KioskEnv, fetchImpl:typeof fetch=fetch, sourceId?:string, client?:string) {
  if (!deliveryConfigured(env)) return;
  const now=Date.now();
  const values:(string|number)[]=[now,now];if(sourceId)values.push(sourceId);if(client)values.push(client,client);
  const rows=await env.DB.prepare(`SELECT * FROM kiosk_outbox d WHERE status IN ('queued','retrying') AND next_attempt_at<=? AND lease_until<=? AND ${staffRobotAllowedSql}
    ${sourceId?'AND source_id=?':''}
    ${client?`AND (EXISTS(SELECT 1 FROM kiosk_orders o JOIN kiosk_sessions s ON s.id=o.session_id WHERE o.id=d.source_id AND s.client_hash=?)
      OR EXISTS(SELECT 1 FROM kiosk_services o JOIN kiosk_sessions s ON s.id=o.session_id WHERE o.id=d.source_id AND s.client_hash=?))`:''}
    ORDER BY next_attempt_at LIMIT 4`).bind(...values).all<OutboxRow>();
  await Promise.all(rows.results.map(async row=>{
    const owner=crypto.randomUUID();
    const claim=await env.DB.prepare(`UPDATE kiosk_outbox SET lease_owner=?,lease_until=? WHERE id=? AND lease_until<=? AND status IN ('queued','retrying') AND ${staffRobotAllowedSql} RETURNING id`).bind(owner,now+30000,row.id,now).first();
    if (!claim) return;
    const attempts=row.attempts+1;
    let error='Receiver could not be reached.';
    try {
      const target=targets(env).find(t=>t.name===row.target && t.url===row.url);
      if (!target) throw new Error('Destination changed.');
      const body=JSON.stringify({...JSON.parse(row.payload),timestamp:new Date().toISOString()});
      const response=await fetchImpl(row.url,{method:'POST',body,redirect:'manual',signal:AbortSignal.timeout(8000),headers:{
        'content-type':'application/json','x-kiosk-signature':await signPayload(body,env.WEBHOOK_SECRET!),
        'OAI-Sites-Authorization':`Bearer ${target.token}`,
      }});
      error=`Receiver did not acknowledge event (HTTP ${response.status}).`;
      // Workers supports manual/follow only. Never follow a redirect carrying
      // the Sites credential or signed customer payload to another address.
      if (response.status>=300 && response.status<400) {
        error=`Receiver redirect was blocked (HTTP ${response.status}).`;
        await response.body?.cancel().catch(()=>{});
        throw new Error('Redirect blocked.');
      }
      // A status code alone is never a delivery receipt.
      const receipt=await response.json().catch(()=>null) as {accepted?:boolean;eventId?:string}|null;
      if (!response.ok || receipt?.accepted!==true || receipt.eventId!==row.event_id) throw new Error('No receipt.');
      await env.DB.prepare(`UPDATE kiosk_outbox SET status='delivered',attempts=?,delivered_at=?,last_error=NULL,payload=?,lease_owner=NULL,lease_until=0 WHERE id=? AND lease_owner=?`)
        .bind(attempts,new Date().toISOString(),body,row.id,owner).run();
    } catch {
      await env.DB.prepare(`UPDATE kiosk_outbox SET status=?,attempts=?,last_error=?,next_attempt_at=?,lease_owner=NULL,lease_until=0 WHERE id=? AND lease_owner=?`)
        .bind(attempts>=8?'failed':'retrying',attempts,error,Date.now()+Math.min(300000,2000*2**(attempts-1)),row.id,owner).run();
    }
  }));
}
