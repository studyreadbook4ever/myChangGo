import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Compile only the pure Workers modules; no cloudflare binding or cloud requests
// are used. The D1 adapter below executes the generated production SQL in SQLite.
const folder=mkdtempSync(new URL('../.test-kiosk-',import.meta.url).pathname);
for(const name of ['receiver','kiosk-types','kiosk-menu','kiosk-store','kiosk-outbox','kiosk-translations','kiosk-history','kiosk-api','kiosk-operations']) {
  const source=readFileSync(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/from (['"])\.\/([^'"]+)\1/g,(_all,quote,file)=>`from ${quote}./${file}.mjs${quote}`);
  writeFileSync(`${folder}/${name}.mjs`,code);
}
after(()=>rmSync(folder,{recursive:true,force:true}));
const {handleKiosk}=await import(pathToFileURL(`${folder}/kiosk-api.mjs`));
const {receiveWebhook,receiverData}=await import(pathToFileURL(`${folder}/receiver.mjs`));
const {flushKioskOutbox}=await import(pathToFileURL(`${folder}/kiosk-outbox.mjs`));
const {changeOperation,operationsData}=await import(pathToFileURL(`${folder}/kiosk-operations.mjs`));
const {flushKioskTranslations}=await import(pathToFileURL(`${folder}/kiosk-translations.mjs`));

function fixture(t,providerOverrides={}) {
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  const journal=JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json',import.meta.url),'utf8'));
  for(const entry of journal.entries)sql.exec(readFileSync(new URL(`../drizzle/${entry.tag}.sql`,import.meta.url),'utf8'));
  const db={
    prepare(query) {
      let values=[];return {bind(...v){values=v;return this;},async first(){return sql.prepare(query).all(...values)[0]??null;},async all(){return {results:sql.prepare(query).all(...values),success:true,meta:{}};},async run(){const r=sql.prepare(query).run(...values);return {results:[],success:true,meta:{changes:Number(r.changes)}};}};
    },
    async batch(statements){sql.exec('BEGIN IMMEDIATE');try{const r=[];for(const statement of statements)r.push(await statement.all());sql.exec('COMMIT');return r;}catch(error){sql.exec('ROLLBACK');throw error;}},
  };
  const calls=[];
  const providers={
    providerStatus:()=>({mode:'live',ready:true,voice:{available:false}}),
    async transcribe(){calls.push('speech');return '  Water, please.\nNo ice.  ';},
    async translate({text,source,target}){calls.push(`translate:${source}:${target}`);return `translated(${text})`;},
    async chat(input){calls.push('chat');return {replyKo:'추가했습니다.',operations:[{itemId:'bibimbap',quantity:1,action:'add'}]};},
    ...providerOverrides,
  };
  const env={DB:db,DAMDA_GATEWAY_SECRET:'gateway-secret-over-thirty-two-characters-long',WEBHOOK_SECRET:'webhook-secret-over-thirty-two-characters-long',KITCHEN_WEBHOOK_URL:'https://receiver.example/api/webhooks/orders',ROBOT_WEBHOOK_URL:'https://receiver.example/api/webhooks/orders',KITCHEN_WEBHOOK_SITES_TOKEN:'test-sites-token',ROBOT_WEBHOOK_SITES_TOKEN:'test-sites-token'};
  const client='a'.repeat(64);
  async function api(path,body,options={}) {
    const headers={'x-damda-gateway':env.DAMDA_GATEWAY_SECRET,'x-damda-client':options.client||client,...options.headers};
    if(body!==undefined&&!(body instanceof FormData))headers['content-type']='application/json';
    const request=new Request(`https://private.example/api/kiosk/${path}`,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)})});
    const response=await handleKiosk(request,env,providers,options.transport||(async()=>{throw new Error('Fixture receiver unavailable');}));
    return {status:response.status,...await response.json()};
  }
  const session=async(language='ko',options)=>api('sessions',{language,table:'07'},options);
  async function prepared(){const s=await session();await api(`sessions/${s.id}/cart`,{itemId:'bibimbap',delta:2});const p=await api(`sessions/${s.id}/prepare`,{});return {s,p};}
  return {sql,db,env,api,providers,calls,session,prepared,client};
}
const approve=p=>({token:p.confirmation.token,version:p.confirmation.version,approved:true});

test('gateway authentication and persistent client binding protect every session',async t=>{
  const f=fixture(t),s=await f.session();
  assert.equal((await f.api('health',undefined,{headers:{'x-damda-gateway':'wrong'}})).status,401);
  assert.equal((await f.api(`sessions/${s.id}`,undefined,{client:'b'.repeat(64)})).status,404);
  assert.equal((await f.api(`sessions/${s.id}/cart`,{itemId:'bibimbap',delta:1},{client:'b'.repeat(64)})).status,404);
  const health=await f.api('health');assert.equal(health.audioOutputEnabled,false);assert.equal(health.mode,'live');
  assert.equal((await f.api('tts',{text:'hello',language:'en'})).code,'AUDIO_OUTPUT_DISABLED');
});

test('only explicit approval creates one server-priced order; unavailable immediate delivery stays durable and duplicate approval survives expiry',async t=>{
  const f=fixture(t),{s,p}=await f.prepared();
  assert.equal(p.confirmation.total,22000);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM kiosk_outbox').get().n,0);
  assert.equal((await f.api(`sessions/${s.id}/confirm`,{...approve(p),approved:false})).status,400);
  const first=await f.api(`sessions/${s.id}/confirm`,{...approve(p),total:1,unitPrice:1});
  assert.equal(first.status,201);assert.equal(first.order.total,22000);assert.equal(first.order.customerApproved,true);
  assert.deepEqual(first.deliveries.map(d=>d.status),['retrying','retrying']);
  assert.ok(first.deliveries.every(d=>d.attempts===1));
  f.sql.prepare('UPDATE kiosk_confirmations SET expires_at=0').run();
  await f.api(`sessions/${s.id}/cart`,{itemId:'mandu',delta:1});
  const again=await f.api(`sessions/${s.id}/confirm`,approve(p));
  assert.equal(again.status,200);assert.equal(again.duplicate,true);assert.equal(again.order.id,first.order.id);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM kiosk_orders').get().n,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM kiosk_outbox').get().n,2);
  assert.deepEqual((await f.api(`sessions/${s.id}`)).cart,[{itemId:'mandu',quantity:1}]);
});

test('stale cart, changed prices, expired and cross-session approvals never dispatch',async t=>{
  const f=fixture(t),{s,p}=await f.prepared(),other=await f.session();
  assert.equal((await f.api(`sessions/${other.id}/confirm`,approve(p))).code,'STALE_CONFIRMATION');
  await f.api(`sessions/${s.id}/cart`,{itemId:'mandu',delta:1});
  assert.equal((await f.api(`sessions/${s.id}/confirm`,approve(p))).code,'STALE_CONFIRMATION');
  const next=await f.api(`sessions/${s.id}/prepare`,{});
  f.sql.prepare('UPDATE kiosk_confirmations SET expires_at=0 WHERE token=?').run(next.confirmation.token);
  assert.equal((await f.api(`sessions/${s.id}/confirm`,approve(next))).code,'CONFIRMATION_EXPIRED');
  const fresh=await f.api(`sessions/${s.id}/prepare`,{});
  const item=JSON.parse(f.sql.prepare("SELECT payload FROM kiosk_menu WHERE id='bibimbap'").get().payload);item.price=12000;
  f.sql.prepare("UPDATE kiosk_menu SET payload=? WHERE id='bibimbap'").run(JSON.stringify(item));
  assert.equal((await f.api(`sessions/${s.id}/confirm`,approve(fresh))).code,'PRICE_CHANGED');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM kiosk_outbox').get().n,0);
});

test('service preserves exact raw text and pending confirmation; requestId replay cannot duplicate calls',async t=>{
  const f=fixture(t),{s,p}=await f.prepared(),text='  Water, please.\nNo ice.  ',requestId=crypto.randomUUID();
  const sent=[];const transport=async(_url,init)=>{
    assert.equal(f.sql.prepare('SELECT lock_owner FROM kiosk_sessions WHERE id=?').get(s.id).lock_owner,null);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM kiosk_services').get().n,1);
    const event=JSON.parse(init.body);sent.push(event);return Response.json({accepted:true,eventId:event.eventId});
  };
  const first=await f.api(`sessions/${s.id}/turn`,{text,kind:'service',requestId},{transport});
  assert.equal(first.status,200);assert.equal(first.serviceRequest.naturalLanguage,text);assert.equal(first.transcript,text);
  assert.equal(first.session.version,p.session.version);assert.equal(first.session.confirmationToken,p.confirmation.token);
  assert.deepEqual(f.calls,[]);
  assert.deepEqual(sent.map(event=>event.target),['kitchen']);
  assert.deepEqual(first.deliveries.map(d=>[d.target,d.status,d.attempts]),[['kitchen','delivered',1],['robot','awaiting_staff',0]]);
  assert.ok(sent.every(event=>event.data.naturalLanguage===text));
  const again=await f.api(`sessions/${s.id}/turn`,{text,kind:'service',requestId},{transport});
  assert.equal(again.duplicate,true);assert.equal(again.serviceRequest.id,first.serviceRequest.id);
  assert.equal((await f.api(`sessions/${s.id}/turn`,{text:'Different',kind:'service',requestId})).code,'REQUEST_ID_CONFLICT');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM kiosk_services').get().n,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM kiosk_outbox').get().n,2);
  assert.equal(sent.length,1,'Service replay must neither resend kitchen nor authorize robot');
});

test('multilingual order uses the real provider contract in sequence and invalidates review without approving',async t=>{
  let original;const f=fixture(t,{async chat(input){original=input.originalTranscript;f.calls.push('chat');return {replyKo:'추가',operations:[{itemId:'bibimbap',quantity:2,action:'add'}]};}});
  const s=await f.session('en');await f.api(`sessions/${s.id}/cart`,{itemId:'mandu',delta:1});const p=await f.api(`sessions/${s.id}/prepare`,{});f.calls.length=0;
  const text='  Two bibimbap please.  ',requestId=crypto.randomUUID();
  const response=await f.api(`sessions/${s.id}/turn`,{text,kind:'order',requestId});
  assert.equal(response.status,200);assert.equal(original,text);assert.equal(response.transcript,text);assert.equal(response.session.confirmationToken,null);
  assert.deepEqual(f.calls,['translate:en:ko','chat','translate:ko:en']);
  assert.equal((await f.api(`sessions/${s.id}/confirm`,approve(p))).code,'STALE_CONFIRMATION');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM kiosk_orders').get().n,0);
});

test('transaction failure rolls back order, both deliveries and cart; retry is safe',async t=>{
  const f=fixture(t),{s,p}=await f.prepared();
  f.sql.exec("CREATE TRIGGER simulate_failure BEFORE INSERT ON kiosk_outbox WHEN NEW.target='robot' BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END;");
  assert.equal((await f.api(`sessions/${s.id}/confirm`,approve(p))).status,503);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM kiosk_orders').get().n,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM kiosk_outbox').get().n,0);
  assert.equal((await f.api(`sessions/${s.id}`)).confirmationToken,p.confirmation.token);
  f.sql.exec('DROP TRIGGER simulate_failure');
  assert.equal((await f.api(`sessions/${s.id}/confirm`,approve(p))).status,201);
});

test('concurrent mutations are serialized across isolates by persisted lease',async t=>{
  let release,entered;const started=new Promise(r=>entered=r),waiting=new Promise(r=>release=r);
  const f=fixture(t,{async chat(){entered();await waiting;return {replyKo:'추가',operations:[{itemId:'bibimbap',quantity:1,action:'add'}]};}}),s=await f.session();
  const ongoing=f.api(`sessions/${s.id}/turn`,{text:'비빔밥',requestId:crypto.randomUUID()});await started;
  assert.equal((await f.api(`sessions/${s.id}/cart`,{itemId:'mandu',delta:1})).code,'SESSION_BUSY');
  release();assert.equal((await ongoing).status,200);
  assert.deepEqual((await f.api(`sessions/${s.id}`)).cart,[{itemId:'bibimbap',quantity:1}]);
});

test('persistent expensive-call quota counts clients and global use; replay does not spend quota again',async t=>{
  const f=fixture(t);f.env.KIOSK_CLIENT_DAILY_LIMIT='1';f.env.KIOSK_GLOBAL_DAILY_LIMIT='1';
  const s=await f.session(),requestId=crypto.randomUUID(),body={text:'비빔밥',requestId};
  assert.equal((await f.api(`sessions/${s.id}/turn`,body)).status,200);
  assert.equal((await f.api(`sessions/${s.id}/turn`,body)).duplicate,true);
  assert.equal((await f.api(`sessions/${s.id}/turn`,{...body,requestId:crypto.randomUUID()})).code,'RATE_LIMITED');
  const client='b'.repeat(64),s2=await f.session('ko',{client});
  assert.equal((await f.api(`sessions/${s2.id}/turn`,{text:'비빔밥',requestId:crypto.randomUUID()},{client})).code,'RATE_LIMITED');
  assert.deepEqual(f.calls,['chat']);
});

test('approval POST immediately sends both targets after unlocking; same-token POST retries only failed target without a history GET',async t=>{
  const f=fixture(t),{s,p}=await f.prepared();
  const received=new Map(),store={async insertIfAbsent(event){if(received.has(event.eventId))return false;received.set(event.eventId,event);return true;},async get(id){return received.get(id);},async list(){return [...received.values()];}};
  let fail=true;const wires=[];
  const fetchImpl=async(url,init)=>{
    assert.equal(f.sql.prepare('SELECT lock_owner FROM kiosk_sessions WHERE id=?').get(s.id).lock_owner,null);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM kiosk_orders').get().n,1);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM kiosk_outbox').get().n,2);
    assert.equal(url,'https://receiver.example/api/webhooks/orders');assert.equal(init.redirect,'manual');assert.equal(init.headers['OAI-Sites-Authorization'],'Bearer test-sites-token');
    const event=JSON.parse(init.body);wires.push(event);
    if(fail&&event.target==='robot')return new Response('{}',{status:503});
    return receiveWebhook(new Request(url,init),{secret:f.env.WEBHOOK_SECRET,store});
  };
  const approval=await f.api(`sessions/${s.id}/confirm`,approve(p),{transport:fetchImpl});
  assert.equal(approval.status,201);assert.equal(wires.length,2);
  assert.deepEqual(approval.deliveries.map(d=>[d.target,d.status]),[['kitchen','delivered'],['robot','retrying']]);
  assert.deepEqual(f.sql.prepare('SELECT target,status FROM kiosk_outbox ORDER BY target').all().map(r=>[r.target,r.status]),[['kitchen','delivered'],['robot','retrying']]);
  fail=false;f.sql.prepare('UPDATE kiosk_outbox SET next_attempt_at=0').run();
  const recovered=await f.api(`sessions/${s.id}/confirm`,approve(p),{transport:fetchImpl});
  assert.equal(recovered.status,200);assert.equal(recovered.duplicate,true);assert.equal(recovered.order.id,approval.order.id);
  assert.ok(recovered.deliveries.every(d=>d.status==='delivered'));
  assert.equal(received.size,2);
  const robotAttempts=wires.filter(event=>event.target==='robot');
  assert.equal(robotAttempts.length,2);assert.equal(robotAttempts[0].eventId,robotAttempts[1].eventId);
  const board=receiverData(await store.list());assert.equal(board.orders.length,1);assert.equal(board.deliveries.length,2);
  const other=await f.session();assert.equal((await f.api(`sessions/${other.id}/orders/${approval.order.id}`)).status,404);
});

test('receiver redirects are never followed or accepted as delivery receipts',async t=>{
  const f=fixture(t),{s,p}=await f.prepared(),approval=await f.api(`sessions/${s.id}/confirm`,approve(p));
  for (const status of [300,301,302,303,304,307,308,399]) {
    f.sql.prepare("UPDATE kiosk_outbox SET status='queued',attempts=0,next_attempt_at=0").run();
    const requested=[];let canceled=0;
    await flushKioskOutbox(f.env,async(url,init)=>{
      requested.push(url);assert.equal(init.redirect,'manual');
      const body=status===304?null:new ReadableStream({cancel(){canceled++;}});
      return new Response(body,{status,headers:{location:`https://untrusted.example/collect?token=${f.env.KITCHEN_WEBHOOK_SITES_TOKEN}`}});
    },approval.order.id);
    assert.deepEqual(requested,['https://receiver.example/api/webhooks/orders','https://receiver.example/api/webhooks/orders']);
    const rows=f.sql.prepare('SELECT status,attempts,last_error,delivered_at FROM kiosk_outbox').all();
    assert.ok(rows.every(row=>row.status==='retrying'&&row.attempts===1&&row.delivered_at===null));
    assert.ok(rows.every(row=>row.last_error===`Receiver redirect was blocked (HTTP ${status}).`));
    assert.ok(!JSON.stringify(rows).includes('untrusted.example'));
    assert.ok(!JSON.stringify(rows).includes(f.env.KITCHEN_WEBHOOK_SITES_TOKEN));
    assert.equal(canceled,status===304?0:2,'Redirect response bodies must release both connections');
  }
});

test('operations persist valid stages and notes, reject stale or skipped transitions, and include pending delivery failures',async t=>{
  const f=fixture(t),{s,p}=await f.prepared(),approval=await f.api(`sessions/${s.id}/confirm`,approve(p)),sourceId=approval.order.id;
  const accepted=await changeOperation(f.env,{action:'stage',sourceId,stage:'accepted',version:0});assert.equal(accepted.state.version,1);
  await assert.rejects(changeOperation(f.env,{action:'stage',sourceId,stage:'cooking',version:0}),e=>e.code==='OPERATION_CHANGED');
  await assert.rejects(changeOperation(f.env,{action:'stage',sourceId,stage:'served',version:1}),e=>e.code==='INVALID_STAGE_TRANSITION');
  const note=await changeOperation(f.env,{action:'note',sourceId,note:'고객에게 맵기 확인 필요',version:1});assert.equal(note.state.supportNote,'고객에게 맵기 확인 필요');
  await assert.rejects(changeOperation(f.env,{action:'note',sourceId:'missing',note:'x',version:0}),e=>e.code==='SOURCE_NOT_FOUND');
  f.sql.prepare("UPDATE kiosk_outbox SET status='failed',attempts=8,last_error='Receiver could not be reached.'").run();
  f.sql.prepare('UPDATE kiosk_operation_states SET updated_at=? WHERE source_id=?').run('2000-01-01T00:00:00.000Z',sourceId);
  for(let i=0;i<510;i++)f.sql.prepare('INSERT INTO kiosk_operation_states(source_id,stage,support_note,version,updated_at) VALUES (?,?,?,?,?)').run(`unrelated-${i}`,'closed','',1,new Date().toISOString());
  const data=await operationsData(f.env,{orders:[],serviceRequests:[],deliveries:[],events:[]});
  assert.equal(data.orders[0].id,sourceId);assert.equal(data.states[0].version,2);assert.equal(data.deliveries[0].status,'failed');assert.equal(data.paymentPolicy,'pay-at-counter');
  assert.equal((await changeOperation(f.env,{action:'retry',deliveryId:approval.deliveries[0].id})).queued,true);
});

test('history polling drains older customer orders while never delivering another client’s queued work',async t=>{
  const f=fixture(t),{s,p}=await f.prepared(),first=await f.api(`sessions/${s.id}/confirm`,approve(p));
  await f.api(`sessions/${s.id}/cart`,{itemId:'mandu',delta:1});
  const next=await f.api(`sessions/${s.id}/prepare`,{}),second=await f.api(`sessions/${s.id}/confirm`,approve(next));
  const client='b'.repeat(64),other=await f.session('ko',{client});
  await f.api(`sessions/${other.id}/cart`,{itemId:'udon',delta:1},{client});
  const otherReview=await f.api(`sessions/${other.id}/prepare`,{},{client});
  const otherOrder=await f.api(`sessions/${other.id}/confirm`,approve(otherReview),{client});
  const sent=[];const transport=async(_url,init)=>{const event=JSON.parse(init.body);sent.push(event);return new Response(JSON.stringify({accepted:true,eventId:event.eventId}),{headers:{'content-type':'application/json'}});};
  f.sql.prepare('UPDATE kiosk_outbox SET next_attempt_at=0').run();
  const result=await f.api('orders',undefined,{transport});
  assert.equal(result.status,200);assert.equal(sent.length,4);
  assert.deepEqual(new Set(sent.map(event=>event.data.id)),new Set([first.order.id,second.order.id]));
  assert.ok(f.sql.prepare('SELECT status,attempts FROM kiosk_outbox WHERE source_id=?').all(otherOrder.order.id).every(row=>row.status==='retrying'&&row.attempts===1));
  assert.ok(result.orders.every(order=>order.deliveries.every(delivery=>delivery.status==='delivered')));
});

test('foreign staff requests preserve raw text, wait visibly on translation failure, then queue kitchen while robot awaits staff',async t=>{
  let fail=true;const f=fixture(t,{async translate({text}){if(fail)throw new Error('Translation unavailable');return '물 주세요. 얼음은 빼 주세요.';}}),s=await f.session('en');
  const text='  Water, please.\nNo ice.  ';
  let sent=0;const response=await f.api(`sessions/${s.id}/turn`,{text,kind:'service',requestId:crypto.randomUUID()},{transport:async()=>{sent++;throw new Error('Must wait for translation');}});
  assert.equal(response.status,200);assert.equal(response.serviceRequest.naturalLanguage,text);assert.equal(response.serviceRequest.translationStatus,'pending');assert.equal(response.serviceRequest.koreanText,undefined);
  assert.deepEqual(response.deliveries.map(d=>d.status),['translation_pending','awaiting_staff']);
  assert.equal(sent,0);
  await assert.rejects(changeOperation(f.env,{action:'send-robot',sourceId:response.serviceRequest.id}),e=>e.code==='TRANSLATION_REQUIRED');
  fail=false;f.sql.prepare('UPDATE kiosk_translation_jobs SET next_attempt_at=0').run();
  await flushKioskTranslations(f.env,f.providers,response.serviceRequest.id);
  const service=JSON.parse(f.sql.prepare('SELECT payload FROM kiosk_services').get().payload);
  assert.equal(service.naturalLanguage,text);assert.equal(service.koreanText,'물 주세요. 얼음은 빼 주세요.');assert.equal(service.translationStatus,'complete');
  const payloads=f.sql.prepare('SELECT target,payload,status FROM kiosk_outbox').all();
  assert.ok(payloads.every(row=>JSON.parse(row.payload).data.naturalLanguage===text));
  assert.equal(payloads.find(row=>row.target==='kitchen').status,'queued');
  assert.equal(JSON.parse(payloads.find(row=>row.target==='kitchen').payload).data.koreanText,service.koreanText);
  assert.equal(payloads.find(row=>row.target==='robot').status,'awaiting_staff');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM kiosk_translation_jobs').get().n,0);
});

test('staff click alone authorizes a service robot event; raw and Korean text survive, concurrent duplicate clicks are idempotent',async t=>{
  const f=fixture(t),s=await f.session('en'),raw='  Water, please.\nNo ice.  ',received=new Map(),wires=[];
  const store={async insertIfAbsent(event){if(received.has(event.eventId))return false;received.set(event.eventId,event);return true;},async get(id){return received.get(id);},async list(){return [...received.values()];}};
  const transport=async(url,init)=>{const event=JSON.parse(init.body);wires.push(event);return receiveWebhook(new Request(url,init),{secret:f.env.WEBHOOK_SECRET,store});};
  const request=await f.api(`sessions/${s.id}/turn`,{text:raw,kind:'service',requestId:crypto.randomUUID()},{transport}),sourceId=request.serviceRequest.id;
  assert.equal(request.status,200);assert.deepEqual(wires.map(event=>event.target),['kitchen']);
  assert.equal(request.deliveries.find(d=>d.target==='robot').attempts,0);
  const robotEventId=request.deliveries.find(d=>d.target==='robot').eventId;
  // Old queued rows from before the policy change must also wait for staff.
  f.sql.prepare("UPDATE kiosk_outbox SET status='queued',next_attempt_at=0 WHERE source_id=? AND target='robot'").run(sourceId);
  const history=await f.api('orders',undefined,{transport});
  const board=await operationsData(f.env,{orders:[],serviceRequests:[],deliveries:[],events:[]},transport);
  assert.equal(board.serviceRequests[0].robotActionAvailable,true);
  assert.equal(history.serviceRequests[0].deliveries.find(d=>d.target==='robot').status,'awaiting_staff');
  assert.equal(wires.length,1,'Customer and staff polling must not authorize a robot');
  assert.equal((await f.api('operations',{action:'send-robot',sourceId},{transport})).status,404,'Public gateway prefix cannot access staff actions');
  const results=await Promise.all([changeOperation(f.env,{action:'send-robot',sourceId},transport),changeOperation(f.env,{action:'send-robot',sourceId},transport)]);
  assert.equal(wires.filter(event=>event.target==='robot').length,1);
  assert.equal(received.size,2);assert.ok(results.some(result=>result.duplicate));
  const robot=wires.find(event=>event.target==='robot');
  assert.equal(robot.eventId,robotEventId);assert.equal(robot.data.naturalLanguage,raw);assert.equal(robot.data.koreanText,request.serviceRequest.koreanText);
  assert.ok(robot.staffApprovedAt);
  const replay=await changeOperation(f.env,{action:'send-robot',sourceId},transport);
  assert.equal(replay.duplicate,true);assert.ok(replay.deliveries.every(d=>d.status==='delivered'));
  assert.equal(wires.length,2);assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM kiosk_outbox').get().n,2);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM kiosk_orders').get().n,0);
});

test('staff robot failure stays retryable with the same event; new dispatch of a closed request is refused',async t=>{
  const f=fixture(t),s=await f.session();let fail=true;const wires=[];
  const transport=async(_url,init)=>{const event=JSON.parse(init.body);wires.push(event);return fail&&event.target==='robot'?new Response('{}',{status:503}):Response.json({accepted:true,eventId:event.eventId});};
  const request=await f.api(`sessions/${s.id}/turn`,{text:'물 주세요.',kind:'service',requestId:crypto.randomUUID()},{transport}),sourceId=request.serviceRequest.id;
  const first=await changeOperation(f.env,{action:'send-robot',sourceId},transport);
  assert.equal(first.deliveries.find(d=>d.target==='robot').status,'retrying');
  fail=false;f.sql.prepare("UPDATE kiosk_outbox SET next_attempt_at=0 WHERE source_id=? AND target='robot'").run(sourceId);
  const recovered=await changeOperation(f.env,{action:'send-robot',sourceId},transport);
  assert.equal(recovered.duplicate,true);assert.equal(recovered.deliveries.find(d=>d.target==='robot').status,'delivered');
  const attempts=wires.filter(event=>event.target==='robot');assert.equal(attempts.length,2);assert.equal(attempts[0].eventId,attempts[1].eventId);
  const closed=await f.api(`sessions/${s.id}/turn`,{text:'앞접시 주세요.',kind:'service',requestId:crypto.randomUUID()},{transport});
  await changeOperation(f.env,{action:'stage',sourceId:closed.serviceRequest.id,stage:'closed',version:0});
  await assert.rejects(changeOperation(f.env,{action:'send-robot',sourceId:closed.serviceRequest.id},transport),e=>e.code==='REQUEST_CLOSED');
  assert.equal(wires.filter(event=>event.target==='robot').length,2);
});

test('customer history spans additional orders and sessions, carries progress, and excludes every other client',async t=>{
  const f=fixture(t),{s,p}=await f.prepared(),one=await f.api(`sessions/${s.id}/confirm`,approve(p));
  await f.api(`sessions/${s.id}/cart`,{itemId:'mandu',delta:1});
  const secondReview=await f.api(`sessions/${s.id}/prepare`,{}),two=await f.api(`sessions/${s.id}/confirm`,approve(secondReview));
  assert.notEqual(one.order.id,two.order.id);
  const secondSession=await f.session();await f.api(`sessions/${secondSession.id}/cart`,{itemId:'udon',delta:1});
  const thirdReview=await f.api(`sessions/${secondSession.id}/prepare`,{}),three=await f.api(`sessions/${secondSession.id}/confirm`,approve(thirdReview));
  await changeOperation(f.env,{action:'stage',sourceId:one.order.id,stage:'accepted',version:0});
  // Prevent background HTTP for this read-only ownership check.
  f.sql.prepare('UPDATE kiosk_outbox SET next_attempt_at=?').run(Date.now()+60000);
  const history=await f.api('orders');assert.equal(history.status,200);assert.equal(history.orders.length,3);
  assert.equal(history.orders.find(o=>o.id===one.order.id).stage,'accepted');assert.equal(history.orders.find(o=>o.id===three.order.id).deliveries.length,2);
  assert.equal((await f.api('orders',undefined,{client:'b'.repeat(64)})).orders.length,0);
  assert.equal((await f.api(`sessions/${s.id}/orders/${one.order.id}`)).stage,'accepted');
});
