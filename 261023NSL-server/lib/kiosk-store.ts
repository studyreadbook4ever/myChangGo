import { KioskError } from './kiosk-types';
import type { KioskEnv, MenuItem, Operation, Session } from './kiosk-types';
import { initialMenu } from './kiosk-menu';

export async function menu(db:D1Database):Promise<MenuItem[]> {
  let rows=await db.prepare('SELECT payload FROM kiosk_menu ORDER BY sort_order').all<{payload:string}>();
  if (!rows.results.length) {
    await db.batch(initialMenu.map((item,index)=>db.prepare('INSERT OR IGNORE INTO kiosk_menu (id,payload,sort_order) VALUES (?,?,?)').bind(item.id,JSON.stringify(item),index)));
    rows=await db.prepare('SELECT payload FROM kiosk_menu ORDER BY sort_order').all<{payload:string}>();
  }
  return rows.results.map(row=>JSON.parse(row.payload));
}
export async function getSession(db:D1Database,id:string,client:string):Promise<Session> {
  const row=await db.prepare('SELECT payload,expires_at FROM kiosk_sessions WHERE id=? AND client_hash=?').bind(id,client).first<{payload:string;expires_at:number}>();
  if (!row) throw new KioskError(404,'SESSION_NOT_FOUND','This session was not found. Please start again.');
  if (row.expires_at<Date.now()) throw new KioskError(410,'SESSION_EXPIRED','This session expired. Please start again.');
  return JSON.parse(row.payload);
}
export async function withSession<T>(db:D1Database,id:string,client:string,work:(session:Session,lock:string)=>Promise<T>):Promise<T> {
  await getSession(db,id,client);
  const owner=crypto.randomUUID(),now=Date.now();
  const row=await db.prepare(`UPDATE kiosk_sessions SET lock_owner=?,lock_until=? WHERE id=? AND client_hash=? AND lock_until<=? RETURNING payload`)
    .bind(owner,now+180000,id,client,now).first<{payload:string}>();
  if (!row) throw new KioskError(409,'SESSION_BUSY','This session is still processing. Retry the same request shortly.');
  try { return await work(JSON.parse(row.payload),owner); }
  finally { await db.prepare('UPDATE kiosk_sessions SET lock_owner=NULL,lock_until=0 WHERE id=? AND lock_owner=?').bind(id,owner).run(); }
}
export function saveStatement(db:D1Database,session:Session,lock:string):D1PreparedStatement {
  session.updatedAt=new Date().toISOString();session.messages=session.messages.slice(-24);
  return db.prepare('UPDATE kiosk_sessions SET payload=?,expires_at=? WHERE id=? AND lock_owner=? RETURNING id')
    .bind(JSON.stringify(session),Date.now()+86400000,session.id,lock);
}
export async function commit(db:D1Database,session:Session,lock:string,statements:D1PreparedStatement[]=[]) {
  const result=await db.batch([...statements,saveStatement(db,session,lock)]);
  if (!result.at(-1)?.results.length) throw new KioskError(409,'SESSION_BUSY','The request took too long. Reload this session before retrying.');
}
export function changed(session:Session) { session.version++;session.confirmationToken=null; }
export function applyOperations(session:Session,operations:Operation[],catalog:MenuItem[]) {
  const ids=new Set(catalog.map(item=>item.id)),cart=new Map(session.cart.map(item=>[item.itemId,item.quantity]));
  for (const op of operations) {
    if (!ids.has(op.itemId)) throw new KioskError(422,'UNKNOWN_MENU_ITEM','A requested menu item is unavailable.');
    const old=cart.get(op.itemId)||0,quantity=op.action==='set'?op.quantity:op.action==='remove'?old-op.quantity:old+op.quantity;
    if (quantity>99) throw new KioskError(400,'QUANTITY_LIMIT','A menu item can have at most 99 portions.');
    if (quantity<=0) cart.delete(op.itemId);else cart.set(op.itemId,quantity);
  }
  const next=[...cart].map(([itemId,quantity])=>({itemId,quantity}));
  if (JSON.stringify(next)!==JSON.stringify(session.cart)) {session.cart=next;changed(session);}
}
export function snapshot(session:Session,catalog:MenuItem[]) {
  return session.cart.map(({itemId,quantity})=>{
    const item=catalog.find(entry=>entry.id===itemId);
    if (!item) throw new KioskError(409,'MENU_CHANGED','The menu changed. Please update your cart.');
    return {itemId,name:item.name.ko,quantity,unitPrice:item.price,lineTotal:item.price*quantity};
  });
}
export async function quota(env:KioskEnv,client:string,expensive=true) {
  const now=Date.now(),minute=Math.floor(now/60000),hour=Math.floor(now/3600000),day=Math.floor(now/86400000);
  const number=(raw:string|undefined,fallback:number,max:number)=>Number.isSafeInteger(Number(raw))&&Number(raw)>0?Math.min(Number(raw),max):fallback;
  const limits=expensive?[
    {key:`ai:c:${client}:${minute}`,limit:10,expires:(minute+2)*60000},
    {key:`ai:cd:${client}:${day}`,limit:number(env.KIOSK_CLIENT_DAILY_LIMIT,50,200),expires:(day+2)*86400000},
    {key:`ai:gh:${hour}`,limit:60,expires:(hour+2)*3600000},
    {key:`ai:gd:${day}`,limit:number(env.KIOSK_GLOBAL_DAILY_LIMIT,300,2000),expires:(day+2)*86400000},
  ]:[{key:`new:c:${client}:${hour}`,limit:20,expires:(hour+2)*3600000},{key:`new:g:${day}`,limit:500,expires:(day+2)*86400000}];
  await env.DB.prepare('DELETE FROM kiosk_quotas WHERE expires_at<?').bind(now).run();
  // Charge the bounded global counters first. Once exhausted, new client hashes
  // cannot grow this table by creating unlimited per-client quota rows.
  for(const group of [limits.filter(q=>q.key.startsWith('ai:g')||q.key.startsWith('new:g')),limits.filter(q=>!(q.key.startsWith('ai:g')||q.key.startsWith('new:g')))]) {
    const result=await env.DB.batch(group.map(q=>env.DB.prepare(`INSERT INTO kiosk_quotas (key,used,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET used=used+1 RETURNING used`).bind(q.key,q.expires)));
    if(result.some((row,index)=>Number((row.results[0] as {used:number}).used)>group[index].limit))throw new KioskError(429,'RATE_LIMITED','The request limit has been reached. Please use the menu buttons or try later.');
  }
}
