import { z } from 'zod';
import { KioskError } from './kiosk-types';
import type { KioskEnv,Providers } from './kiosk-types';
import { flushKioskOutbox,deliveryConfigured,listDeliveries,deliveryStatusSql,staffRobotAllowedSql } from './kiosk-outbox';
import { flushKioskTranslations } from './kiosk-translations';
import type { receiverData } from './receiver';

type State={sourceId:string;stage:string;supportNote:string;version:number;updatedAt:string};
const stateColumns='source_id AS sourceId,stage,support_note AS supportNote,version,updated_at AS updatedAt';
const stage=z.enum(['new','accepted','cooking','ready','served','closed']);
const actionSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('stage'),sourceId:z.string().min(1).max(100),stage,version:z.number().int().min(0)}),
  z.object({action:z.literal('note'),sourceId:z.string().min(1).max(100),note:z.string().max(2000),version:z.number().int().min(0)}),
  z.object({action:z.literal('retry'),deliveryId:z.string().min(1).max(100)}),
  z.object({action:z.literal('translate'),sourceId:z.string().min(1).max(100)}),
  z.object({action:z.literal('send-robot'),sourceId:z.string().min(1).max(100)}),
]);
export async function operationsData(env:KioskEnv,receipts:ReturnType<typeof receiverData>,fetchImpl:typeof fetch=fetch,providers?:Providers) {
  if(providers)await flushKioskTranslations(env,providers);
  await flushKioskOutbox(env,fetchImpl);
  const [orders,services]=await Promise.all([
    env.DB.prepare("SELECT payload FROM kiosk_orders o ORDER BY CASE WHEN EXISTS(SELECT 1 FROM kiosk_outbox d WHERE d.source_id=o.id AND d.status!='delivered') THEN 0 ELSE 1 END,created_at DESC LIMIT 100").all<{payload:string}>(),
    env.DB.prepare(`SELECT payload FROM kiosk_services o ORDER BY CASE WHEN EXISTS(SELECT 1 FROM kiosk_outbox d WHERE d.source_id=o.id AND d.status NOT IN('delivered','awaiting_staff') AND ${staffRobotAllowedSql}) THEN 0 ELSE 1 END,created_at DESC LIMIT 100`).all<{payload:string}>(),
  ]);
  const merge=(recorded:{id:string;createdAt:string}[],local:{payload:string}[])=>[...new Map([...recorded,...local.map(row=>JSON.parse(row.payload))].map(item=>[item.id,item])).values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const allOrders=merge(receipts.orders,orders.results),localServiceIds=new Set(services.results.map(row=>JSON.parse(row.payload).id));
  const allServices=merge(receipts.serviceRequests,services.results).map(service=>({...service,robotActionAvailable:localServiceIds.has(service.id)}));
  const ids=JSON.stringify([...allOrders,...allServices].map(entry=>entry.id));
  // Fetch whole source groups so an older failed target or operation state is
  // never mislabeled merely because unrelated newer rows filled a row window.
  const [deliveries,states]=await Promise.all([
    env.DB.prepare(`SELECT id,event_id AS eventId,source_id AS sourceId,target,${deliveryStatusSql} AS status,attempts,last_error AS lastError,delivered_at AS deliveredAt,created_at AS createdAt FROM kiosk_outbox WHERE source_id IN(SELECT value FROM json_each(?)) ORDER BY created_at DESC`).bind(ids).all(),
    env.DB.prepare(`SELECT ${stateColumns} FROM kiosk_operation_states WHERE source_id IN(SELECT value FROM json_each(?))`).bind(ids).all<State>(),
  ]);
  const combined=new Map<string,unknown>();
  // A signed receipt is authoritative even if its sender lost the HTTP reply.
  for(const d of deliveries.results)combined.set(String(d.id),d);
  for(const receipt of receipts.deliveries) {
    const local=deliveries.results.find(d=>d.eventId===receipt.eventId);
    combined.set(String(local?.id||receipt.id),{...receipt,...(local?{id:local.id,attempts:local.attempts}:{}),status:'delivered'});
  }
  return {...receipts,orders:allOrders,serviceRequests:allServices,deliveries:[...combined.values()],states:states.results,paymentPolicy:'pay-at-counter'};
}
export async function changeOperation(env:KioskEnv,input:unknown,fetchImpl:typeof fetch=fetch) {
  const parsed=actionSchema.safeParse(input);
  if(!parsed.success)throw new KioskError(400,'INVALID_INPUT','Please check the requested operation.');
  const action=parsed.data;
  if(action.action==='send-robot') {
    const service=await env.DB.prepare('SELECT payload FROM kiosk_services WHERE id=?').bind(action.sourceId).first<{payload:string}>();
    if(!service)throw new KioskError(404,'SERVICE_REQUEST_NOT_FOUND','This staff request was not found.');
    const row=await env.DB.prepare("SELECT id,status,payload FROM kiosk_outbox WHERE source_id=? AND target='robot' ORDER BY created_at LIMIT 1").bind(action.sourceId).first<{id:string;status:string;payload:string}>();
    if(!row)throw new KioskError(404,'DELIVERY_NOT_FOUND','The robot delivery was not found.');
    const event=JSON.parse(row.payload);let duplicate=row.status==='delivered'||Boolean(event.staffApprovedAt);
    if(!duplicate) {
      const data=JSON.parse(service.payload);
      if(data.translationStatus!=='complete'&&data.language!=='ko')throw new KioskError(409,'TRANSLATION_REQUIRED','Please wait for the Korean translation before sending this request.');
      if(data.language!=='ko'&&(!data.koreanText||!data.koreanText.trim()))throw new KioskError(409,'TRANSLATION_REQUIRED','A Korean translation is required.');
      if(!deliveryConfigured(env))throw new KioskError(503,'DELIVERY_NOT_CONFIGURED','Robot delivery is not configured.');
      const closed=await env.DB.prepare("SELECT source_id FROM kiosk_operation_states WHERE source_id=? AND stage='closed'").bind(action.sourceId).first();
      if(closed)throw new KioskError(409,'REQUEST_CLOSED','This request is already closed.');
      const now=Date.now();
      // One atomic update authorizes the existing event. Concurrent clicks
      // cannot allocate another event or refresh an already authorized payload.
      const written=await env.DB.prepare(`UPDATE kiosk_outbox SET payload=json_set(payload,'$.data',json(?),'$.staffApprovedAt',?),status='queued',next_attempt_at=?,last_error=NULL
        WHERE id=? AND status!='delivered' AND json_extract(payload,'$.staffApprovedAt') IS NULL AND lease_until<=?
        AND NOT EXISTS(SELECT 1 FROM kiosk_operation_states WHERE source_id=? AND stage='closed') RETURNING id`)
        .bind(service.payload,new Date(now).toISOString(),now,row.id,now,action.sourceId).first();
      if(!written) {
        const current=await env.DB.prepare('SELECT payload,status FROM kiosk_outbox WHERE id=?').bind(row.id).first<{payload:string;status:string}>();
        if(!current||(!JSON.parse(current.payload).staffApprovedAt&&current.status!=='delivered'))throw new KioskError(409,'ROBOT_DELIVERY_BUSY','Refresh this request before sending it.');
        duplicate=true;
      }
    }
    await flushKioskOutbox(env,fetchImpl,action.sourceId);
    return {sourceId:action.sourceId,duplicate,deliveries:await listDeliveries(env.DB,action.sourceId)};
  }
  if(action.action==='translate') {
    const job=await env.DB.prepare("UPDATE kiosk_translation_jobs SET status='pending',attempts=0,next_attempt_at=? WHERE source_id=? AND status='failed' AND lease_until<=? RETURNING source_id").bind(Date.now(),action.sourceId,Date.now()).first();
    if(!job)throw new KioskError(409,'TRANSLATION_ALREADY_SCHEDULED','Translation is already pending or complete.');
    const row=await env.DB.prepare('SELECT payload FROM kiosk_services WHERE id=?').bind(action.sourceId).first<{payload:string}>();
    if(row)await env.DB.prepare('UPDATE kiosk_services SET payload=? WHERE id=?').bind(JSON.stringify({...JSON.parse(row.payload),translationStatus:'pending'}),action.sourceId).run();
    return {queued:true,sourceId:action.sourceId};
  }
  if(action.action==='retry') {
    const row=await env.DB.prepare('SELECT status FROM kiosk_outbox WHERE id=?').bind(action.deliveryId).first<{status:string}>();
    if(!row)throw new KioskError(404,'DELIVERY_NOT_FOUND','The delivery was not found.');
    if(row.status==='delivered')throw new KioskError(409,'ALREADY_DELIVERED','This event was already delivered.');
    const changed=await env.DB.prepare(`UPDATE kiosk_outbox SET status='queued',attempts=0,next_attempt_at=?,last_error=NULL WHERE id=? AND status='failed' AND lease_until<=? RETURNING id`).bind(Date.now(),action.deliveryId,Date.now()).first();
    if(!changed)throw new KioskError(409,'RETRY_ALREADY_SCHEDULED','This delivery is already queued or retrying.');
    return {queued:true,deliveryId:action.deliveryId};
  }
  const source=await env.DB.prepare(`SELECT 'order.created' AS type FROM kiosk_orders WHERE id=? UNION ALL SELECT 'service.requested' AS type FROM kiosk_services WHERE id=? UNION ALL SELECT type FROM received_events WHERE source_id=? LIMIT 1`)
    .bind(action.sourceId,action.sourceId,action.sourceId).first<{type:string}>();
  if(!source)throw new KioskError(404,'SOURCE_NOT_FOUND','The order or request was not found.');
  const old=await env.DB.prepare(`SELECT ${stateColumns} FROM kiosk_operation_states WHERE source_id=?`).bind(action.sourceId).first<State>();
  const current=old||{sourceId:action.sourceId,stage:'new',supportNote:'',version:0,updatedAt:new Date().toISOString()};
  if(current.version!==action.version)throw new KioskError(409,'OPERATION_CHANGED','Another staff member changed this record. Refresh and try again.');
  const next={...current,version:current.version+1,updatedAt:new Date().toISOString()};
  if(action.action==='stage') {
    const transitions:Record<string,string[]>=source.type==='service.requested'?{new:['accepted','closed'],accepted:['closed'],closed:[]}:{new:['accepted'],accepted:['cooking'],cooking:['ready'],ready:['served'],served:['closed'],closed:[]};
    if(!transitions[current.stage]?.includes(action.stage))throw new KioskError(409,'INVALID_STAGE_TRANSITION','This status change is not available. Refresh the order.');
    next.stage=action.stage;
  } else next.supportNote=action.note;
  const written=old?await env.DB.prepare(`UPDATE kiosk_operation_states SET stage=?,support_note=?,version=?,updated_at=? WHERE source_id=? AND version=? RETURNING ${stateColumns}`)
    .bind(next.stage,next.supportNote,next.version,next.updatedAt,next.sourceId,current.version).first<State>():
    await env.DB.prepare(`INSERT INTO kiosk_operation_states (source_id,stage,support_note,version,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(source_id) DO NOTHING RETURNING ${stateColumns}`)
      .bind(next.sourceId,next.stage,next.supportNote,next.version,next.updatedAt).first<State>();
  if(!written)throw new KioskError(409,'OPERATION_CHANGED','Another staff member changed this record. Refresh and try again.');
  return {state:written};
}
