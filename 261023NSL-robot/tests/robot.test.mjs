import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';

const folder=mkdtempSync(new URL('../.test-robot-',import.meta.url).pathname);
for(const name of ['robot-types','robot-receiver','robot-auth','robot-store','robot-api']){
  const source=readFileSync(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/from (['"])\.\/([^'"]+)\1/g,(_all,quote,file)=>`from ${quote}./${file}.mjs${quote}`);
  writeFileSync(`${folder}/${name}.mjs`,code);
}
after(()=>rmSync(folder,{recursive:true,force:true}));
const {receiveWebhook,signPayload}=await import(pathToFileURL(`${folder}/robot-receiver.mjs`));
const {robotReceiverStore}=await import(pathToFileURL(`${folder}/robot-store.mjs`));
const {handleRobot}=await import(pathToFileURL(`${folder}/robot-api.mjs`));

function fixture(t,overrides={}){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  const journal=JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json',import.meta.url)));
  for(const entry of journal.entries)sql.exec(readFileSync(new URL(`../drizzle/${entry.tag}.sql`,import.meta.url),'utf8'));
  const db={prepare(query){let values=[];return {bind(...next){values=next;return this;},async first(){return sql.prepare(query).all(...values)[0]??null;},async all(){return {results:sql.prepare(query).all(...values)};},async run(){return {success:true,meta:sql.prepare(query).run(...values)};}};},async batch(statements){sql.exec('BEGIN');try{const rows=[];for(const item of statements)rows.push(await item.all());sql.exec('COMMIT');return rows;}catch(error){sql.exec('ROLLBACK');throw error;}}};
  const env={DB:db,WEBHOOK_SECRET:'robot-webhook-fixture-secret-over-32-characters',OPERATOR_TOKEN:'robot-operator-fixture-secret-over-32-characters',STAFF_OWNER_EMAIL:'owner@example.test'};
  const calls=[];
  const providers={status:()=>({speech:true,translation:true,chat:true,tts:false}),async transcribe(input){calls.push(['speech',input.language]);return '  More water, please.\nNo ice.  ';},async translate(input){calls.push(['translate',input.source,input.target,input.text]);return input.target==='ko'?`한국어: ${input.text}`:`Localized ${input.target}: ${input.text}`;},async respond(input){calls.push(['respond',input]);return {commentNeeded:true,replyKo:'요청 내용을 확인했어요. 직원에게 필요한 도움을 말씀해 주세요.',needsStaff:false};},async synthesize(){calls.push(['tts']);return new Uint8Array([73,68,51]);},...overrides};
  async function api(path='',body,options={}){
    const headers={authorization:`Bearer ${env.OPERATOR_TOKEN}`,...options.headers};if(body!==undefined&&!(body instanceof FormData))headers['content-type']='application/json';
    const request=new Request(`https://robot.example/api/${path||'robot'}`,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)})});
    const response=await handleRobot(request,env,providers,options.identity===true);
    return {status:response.status,headers:response.headers,...(response.headers.get('content-type')==='audio/mpeg'?{audio:new Uint8Array(await response.arrayBuffer())}:await response.json())};
  }
  function event(language='en',kind='service'){
    const now=new Date().toISOString(),common={id:`src_${crypto.randomUUID()}`,sessionId:crypto.randomUUID(),table:'98',language,createdAt:now};
    const data=kind==='service'?{...common,naturalLanguage:'  Water, please.\nNo ice.  ',koreanText:'물을 주세요. 얼음은 빼 주세요.',translationStatus:'complete',status:'requested'}:{...common,schemaVersion:'1.0',eventId:`evt_${crypto.randomUUID()}`,items:[{itemId:'udon',name:'우동',quantity:2,unitPrice:9000,lineTotal:18000}],total:18000,currency:'KRW',customerApproved:true,approvedAt:now};
    return {schemaVersion:'1.0',eventId:`evt_${crypto.randomUUID()}`,timestamp:now,target:'robot',type:kind==='service'?'service.requested':'order.created',data,...(kind==='service'?{staffApprovedAt:now}:{})};
  }
  async function webhook(wire,options={}){
    const body=JSON.stringify(wire),signature=await signPayload(body,env.WEBHOOK_SECRET);
    const response=await receiveWebhook(new Request('https://robot.example/api/webhooks/orders',{method:'POST',headers:{'content-type':'application/json','x-kiosk-signature':options.tamper?'sha256='+'0'.repeat(64):signature},body}),{secret:env.WEBHOOK_SECRET,store:robotReceiverStore(db)});
    return {status:response.status,...await response.json()};
  }
  return {sql,db,env,providers,calls,api,event,webhook};
}

test('signed receiver ACK persists a raw job without AI; duplicate event is atomic and tampered payload is refused',async t=>{
  const f=fixture(t),wire=f.event();
  assert.equal((await f.webhook(wire,{tamper:true})).status,401);
  const results=await Promise.all([f.webhook(wire),f.webhook(wire)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,202]);assert.ok(results.every(r=>r.accepted&&r.eventId===wire.eventId));
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM robot_jobs').get().n,1);assert.deepEqual(f.calls,[]);
  const board=await f.api();assert.equal(board.jobs[0].originalText,wire.data.naturalLanguage);assert.equal(board.jobs[0].koreanText,wire.data.koreanText);assert.equal(board.jobs[0].stage,'queued');
  assert.equal((await f.webhook({...wire,data:{...wire.data,naturalLanguage:'different'}})).status,409);
});

test('robot receiver rejects wrong targets, unapproved service, untranslated foreign requests, and stale signatures',async t=>{
  const f=fixture(t),wire=f.event();
  assert.equal((await f.webhook({...wire,target:'kitchen'})).code,'WRONG_TARGET');
  const missing={...wire};delete missing.staffApprovedAt;
  assert.equal((await f.webhook(missing)).code,'STAFF_APPROVAL_REQUIRED');
  assert.equal((await f.webhook({...wire,data:{...wire.data,koreanText:undefined,translationStatus:'pending'}})).code,'KOREAN_TRANSLATION_REQUIRED');
  assert.equal((await f.webhook({...wire,timestamp:'2000-01-01T00:00:00.000Z'})).code,'EXPIRED_EVENT');
  assert.equal((await f.webhook(f.event('ko','order'))).status,202);
});

test('all interactive routes deny anonymous and customer-gateway access; owner and operator access remain separate',async t=>{
  const f=fixture(t),wire=f.event();await f.webhook(wire);
  for(const [path,body] of [['robot',undefined],['health',undefined],['robot',{action:'prepare',jobId:wire.eventId}],['robot/turn',{jobId:wire.eventId,requestId:crypto.randomUUID(),text:'hello'}],['robot/speak',{jobId:wire.eventId,messageId:crypto.randomUUID()}]]){
    assert.equal((await f.api(path,body,{headers:{authorization:''}})).status,401);
    assert.equal((await f.api(path,body,{headers:{'x-damda-gateway':'customer-gateway'}})).status,401);
  }
  assert.equal((await f.api('',undefined,{headers:{authorization:'','oai-authenticated-user-email':'owner@example.test'}})).status,200);
  assert.equal((await f.api('',undefined,{headers:{authorization:'','oai-authenticated-user-email':'other@example.test'}})).status,401);
  assert.equal((await f.api('robot',{action:'prepare',jobId:wire.eventId},{headers:{origin:'https://other.example'}})).status,403);
  assert.deepEqual(f.calls,[]);
});

test('prepare is lease serialized, language aware, and idempotent after saved completion',async t=>{
  let entered,release;const started=new Promise(r=>entered=r),waiting=new Promise(r=>release=r);
  const f=fixture(t,{async respond(input){f.calls.push(['respond',input]);entered();await waiting;return {commentNeeded:true,replyKo:'요청 내용을 확인했어요.',needsStaff:false};}}),wire=f.event('ja');await f.webhook(wire);
  const first=f.api('robot',{action:'prepare',jobId:wire.eventId});await started;
  assert.equal((await f.api('robot',{action:'prepare',jobId:wire.eventId})).code,'JOB_BUSY');release();
  const ready=await first;assert.equal(ready.job.stage,'ready');assert.equal(ready.job.version,1);assert.equal(ready.job.messages[0].text,'Localized ja: 요청 내용을 확인했어요.');
  const again=await f.api('robot',{action:'prepare',jobId:wire.eventId});assert.equal(again.duplicate,true);assert.equal(f.calls.filter(c=>c[0]==='respond').length,1);
});

test('only explicit versioned staff stages advance travel; injected stage output is rejected and failure remains retryable',async t=>{
  let inject=true;const f=fixture(t,{async respond(){return inject?{commentNeeded:true,replyKo:'이미 전달했어요.',needsStaff:false,stage:'completed'}:{commentNeeded:false,replyKo:'',needsStaff:false};}}),wire=f.event('ko');await f.webhook(wire);
  assert.equal((await f.api('robot',{action:'prepare',jobId:wire.eventId})).code,'INVALID_ROBOT_RESPONSE');
  const failed=(await f.api()).jobs[0];assert.equal(failed.stage,'queued');assert.equal(failed.preparationStatus,'failed');
  inject=false;let job=(await f.api('robot',{action:'prepare',jobId:wire.eventId})).job;
  assert.equal(job.messages.length,0);assert.equal(job.stage,'ready');
  assert.equal((await f.api('robot',{action:'stage',jobId:job.id,version:job.version,stage:'completed'})).code,'INVALID_STAGE_TRANSITION');
  const originalVersion=job.version;
  job=(await f.api('robot',{action:'stage',jobId:job.id,version:job.version,stage:'en_route'})).job;
  assert.equal((await f.api('robot',{action:'stage',jobId:job.id,version:originalVersion,stage:'arrived'})).code,'JOB_CHANGED');
  for(const stage of ['arrived','completed']){job=(await f.api('robot',{action:'stage',jobId:job.id,version:job.version,stage})).job;assert.equal(job.stage,stage);}
});

test('prepare save failures recover consistently whether the write committed or not',async t=>{
  for(const committed of [false,true]){
    const f=fixture(t),wire=f.event('ko');await f.webhook(wire);
    const batch=f.db.batch.bind(f.db);let fail=true;
    f.db.batch=async statements=>{if(fail){fail=false;if(committed)await batch(statements);throw new Error('simulated D1 response failure');}return batch(statements);};
    assert.equal((await f.api('robot',{action:'prepare',jobId:wire.eventId})).status,503);
    const saved=(await f.api()).jobs[0];assert.equal(saved.prepared,committed);assert.equal(saved.preparationStatus,committed?'ready':'pending');
    const recovered=await f.api('robot',{action:'prepare',jobId:wire.eventId});assert.equal(recovered.status,200);assert.equal(recovered.job.prepared,true);assert.equal(recovered.job.preparationStatus,'ready');assert.equal(recovered.duplicate,committed);
    assert.equal(f.calls.filter(c=>c[0]==='respond').length,committed?1:2);
  }
});

test('voice followup preserves raw STT and Korean, returns job language, and requestId replay never reruns providers',async t=>{
  const f=fixture(t),wire=f.event('en');await f.webhook(wire);const prepared=await f.api('robot',{action:'prepare',jobId:wire.eventId});f.calls.length=0;
  const requestId=crypto.randomUUID();const form=()=>{const data=new FormData();data.append('jobId',wire.eventId);data.append('requestId',requestId);data.append('audio',new Blob([new Uint8Array(50)],{type:'audio/wav'}),'request.wav');return data;};
  const first=await f.api('robot/turn',form());assert.equal(first.status,200);assert.equal(first.transcript,'  More water, please.\nNo ice.  ');assert.equal(first.koreanText,`한국어: ${first.transcript}`);
  assert.equal(first.job.messages.at(-2).text,first.transcript);assert.equal(first.job.stage,prepared.job.stage);assert.ok(first.reply.startsWith('Localized en:'));
  assert.deepEqual(f.calls.map(c=>c[0]),['speech','translate','respond','translate']);
  const duplicate=await f.api('robot/turn',form());assert.equal(duplicate.duplicate,true);assert.equal(duplicate.messageId,first.messageId);assert.equal(f.calls.length,4);
  assert.equal((await f.api('robot/turn',{jobId:wire.eventId,requestId,text:'Different input'})).code,'REQUEST_ID_CONFLICT');
  let job=duplicate.job;
  for(const stage of ['en_route','arrived','completed'])job=(await f.api('robot',{action:'stage',jobId:job.id,version:job.version,stage})).job;
  const recovered=await f.api('robot/turn',form());assert.equal(recovered.duplicate,true);assert.equal(recovered.job.stage,'completed');
  assert.equal((await f.api('robot/turn',{jobId:wire.eventId,requestId:crypto.randomUUID(),text:'New request after completion'})).code,'JOB_COMPLETED');
  assert.equal(f.calls.length,4);
});

test('speech output requires stored assistant message, never client text; missing Voice keys returns truthful503',async t=>{
  const f=fixture(t),wire=f.event();await f.webhook(wire);const ready=await f.api('robot',{action:'prepare',jobId:wire.eventId}),messageId=ready.job.messages[0].id;
  assert.equal((await f.api()).capabilities.tts,false);
  assert.equal((await f.api('robot/speak',{jobId:wire.eventId,messageId,text:'Injected arbitrary text'})).status,400);
  assert.equal((await f.api('robot/speak',{jobId:wire.eventId,messageId:crypto.randomUUID()})).status,404);
  const result=await f.api('robot/speak',{jobId:wire.eventId,messageId});assert.equal(result.status,503);assert.equal(result.code,'TTS_UNAVAILABLE');assert.ok(!f.calls.some(c=>c[0]==='tts'));
});

test('persistent quota limits AI turns while same-request recovery remains free',async t=>{
  const f=fixture(t),wire=f.event('ko');f.env.ROBOT_DAILY_AI_LIMIT='2';await f.webhook(wire);
  assert.equal((await f.api('robot',{action:'prepare',jobId:wire.eventId})).status,200);
  const input={jobId:wire.eventId,requestId:crypto.randomUUID(),text:'직원 확인 부탁해요.'};
  assert.equal((await f.api('robot/turn',input)).status,200);
  assert.equal((await f.api('robot/turn',input)).duplicate,true);
  assert.equal((await f.api('robot/turn',{...input,requestId:crypto.randomUUID()})).code,'RATE_LIMITED');
  assert.equal(f.calls.filter(call=>call[0]==='respond').length,2);
});

test('configured speech output uses only persisted assistant language/text and never caches audio',async t=>{
  const spoken=[];const f=fixture(t,{status:()=>({speech:true,translation:true,chat:true,tts:true}),async synthesize(input){spoken.push(input);return new Uint8Array([73,68,51,0]);}}),wire=f.event('zh');await f.webhook(wire);
  const ready=await f.api('robot',{action:'prepare',jobId:wire.eventId}),message=ready.job.messages[0];
  for(let i=0;i<2;i++){const response=await f.api('robot/speak',{jobId:wire.eventId,messageId:message.id});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual([...response.audio],[73,68,51,0]);}
  assert.deepEqual(spoken,[{text:message.text,language:'zh'},{text:message.text,language:'zh'}]);
  assert.equal(JSON.parse(f.sql.prepare('SELECT job_payload FROM robot_jobs').get().job_payload).messages.length,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM robot_turns').get().n,0);
});
