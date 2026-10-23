import { z } from 'zod';
import { authorizeOperator, jsonResponse } from './receiver';
import { KioskError } from './kiosk-types';
import type { KioskEnv, Language, Providers, Session } from './kiosk-types';
import { applyOperations, changed, commit, getSession, menu, quota, snapshot, withSession } from './kiosk-store';
import { deliveryConfigured, enqueueStatements, flushKioskOutbox, listDeliveries } from './kiosk-outbox';
import { menuIllustration } from './kiosk-menu';
import { customerHistory,sourceStage } from './kiosk-history';
import { flushKioskTranslations } from './kiosk-translations';

const language=z.enum(['ko','en','ja','zh']);
const operations=z.array(z.object({itemId:z.string().min(1).max(100),quantity:z.number().int().min(0).max(99),action:z.enum(['add','remove','set'])})).max(50);
const turnSchema=z.object({text:z.string().max(8000).refine(s=>s.trim().length>0).optional(),kind:z.enum(['order','service']).default('order'),requestId:z.string().uuid().optional()});
const approvalInstruction:Record<Language,string>={
  ko:'메뉴, 수량, 금액을 확인하고 주문하기를 눌러 주세요.',
  en:'Check the items, quantities, and total, then tap Place order.',
  ja:'料理、数量、金額を確認して、「注文する」を押してください。',
  zh:'请核对菜品、数量和金额，然后点击“下单”。',
};
const serviceReply:Record<Language,string>={
  ko:'부탁하신 내용을 받았어요. 직원에게 전달할게요.',
  en:'We have your request. We’ll pass it on to the staff.',
  ja:'ご依頼を受け付けました。スタッフにお伝えします。',
  zh:'已收到您的请求，我们会转告工作人员。',
};
function parse<S extends z.ZodTypeAny>(schema:S,value:unknown):z.output<S> {
  const result=schema.safeParse(value);
  if (!result.success) throw new KioskError(400,'INVALID_INPUT','Please check the request fields.');
  return result.data;
}
async function boundedBytes(request:Request,maximum:number):Promise<Uint8Array> {
  const length=request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length)||Number(length)>maximum)) throw new KioskError(413,'PAYLOAD_TOO_LARGE','Request body is too large.');
  if (!request.body) return new Uint8Array();
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {
    while (true) {const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maximum){await reader.cancel();throw new KioskError(413,'PAYLOAD_TOO_LARGE','Request body is too large.');}chunks.push(value);}
  } finally {reader.releaseLock();}
  const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
async function jsonInput(request:Request):Promise<unknown> {
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json')throw new KioskError(415,'INVALID_CONTENT_TYPE','application/json is required.');
  const bytes=await boundedBytes(request,32768);
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new KioskError(400,'INVALID_JSON','Malformed JSON.');}
}
async function turnInput(request:Request) {
  if(!request.headers.get('content-type')?.startsWith('multipart/form-data'))return {input:parse(turnSchema,await jsonInput(request)),audio:undefined};
  const bytes=await boundedBytes(request,2*1024*1024+16384);
  let form:FormData;
  try{form=await new Request(request.url,{method:'POST',headers:{'content-type':request.headers.get('content-type')!},body:new Uint8Array(bytes)}).formData();}catch{throw new KioskError(400,'INVALID_AUDIO','Invalid recording upload.');}
  const keys=[...form.keys()];
  if(keys.length>4||new Set(keys).size!==keys.length||keys.some(key=>!['audio','kind','text','requestId'].includes(key)))throw new KioskError(400,'INVALID_INPUT','Invalid recording fields.');
  const file=form.get('audio');
  if(!file||typeof file==='string'||file.size===0||file.size>2*1024*1024)throw new KioskError(400,'INVALID_AUDIO','A WAV recording up to 2 MB is required.');
  if(!['audio/wav','audio/x-wav','audio/wave'].includes(file.type.split(';')[0]))throw new KioskError(415,'UNSUPPORTED_AUDIO','Please record PCM WAV audio.');
  return {input:parse(turnSchema,Object.fromEntries([...form.entries()].filter(([key])=>key!=='audio'))),audio:{buffer:new Uint8Array(await file.arrayBuffer()),mimeType:file.type}};
}
async function hash(data:Uint8Array|string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',typeof data==='string'?new TextEncoder().encode(data):new Uint8Array(data)))].map(v=>v.toString(16).padStart(2,'0')).join('');
}
function mustDeliver(env:KioskEnv) {if(!deliveryConfigured(env))throw new KioskError(503,'DELIVERY_NOT_CONFIGURED','Order delivery is not configured. Please ask a staff member.');}
function validText(value:unknown,code='INVALID_ASSISTANT_RESPONSE'):asserts value is string {if(typeof value!=='string'||!value.trim()||value.length>8000)throw new KioskError(502,code,'The assistant could not prepare a response. Please try again.');}

/** Only the trusted public gateway can enter this prefix. The existing owner
 * dashboard and signed receiver endpoints have independent authentication. */
export async function handleKiosk(request:Request,env:KioskEnv,providers:Providers,fetchImpl:typeof fetch=fetch):Promise<Response> {
  try {
    if(!env.DAMDA_GATEWAY_SECRET||env.DAMDA_GATEWAY_SECRET.length<32)throw new KioskError(503,'GATEWAY_NOT_CONFIGURED','The ordering service is not configured.');
    if(!await authorizeOperator(`Bearer ${request.headers.get('x-damda-gateway')||''}`,env.DAMDA_GATEWAY_SECRET,false))throw new KioskError(401,'GATEWAY_AUTH_REQUIRED','Gateway authentication is required.');
    const client=request.headers.get('x-damda-client')||'';
    if(!/^[a-f0-9]{32,128}$/.test(client))throw new KioskError(401,'CLIENT_BINDING_REQUIRED','Client binding is required.');
    if(!env.DB)throw new KioskError(503,'DATABASE_UNAVAILABLE','The ordering database is unavailable.');
    const path=new URL(request.url).pathname.replace(/^\/api\/kiosk\/?/,'').split('/').filter(Boolean),method=request.method;
    if(path.length===1&&path[0]==='health'&&method==='GET')return jsonResponse({ok:true,mode:'live',role:'kiosk',audioOutputEnabled:false,providers:await providers.providerStatus(),deliveryConfigured:deliveryConfigured(env)});
    if(path[0]==='menu'&&method==='GET') {
      const catalog=await menu(env.DB);
      if(path.length===1)return jsonResponse({items:catalog});
      if(path.length===3&&path[2]==='illustration.svg') {
        const item=catalog.find(item=>item.id===path[1]);
        if(item)return new Response(menuIllustration(item),{headers:{'content-type':'image/svg+xml','cache-control':'public,max-age=3600'}});
      }
    }
    if(path.length===1&&path[0]==='tts'&&method==='POST')throw new KioskError(409,'AUDIO_OUTPUT_DISABLED','Audio output remains disabled. CLOVA Voice is not enabled.');
    if(path.length===1&&path[0]==='orders'&&method==='GET')return jsonResponse(await customerHistory(env,client,providers,fetchImpl));
    if(path.length===1&&path[0]==='sessions'&&method==='POST') {
      const input=parse(z.object({language,table:z.string().trim().min(1).max(32).regex(/^[\p{L}\p{N} _-]+$/u).default('07')}),await jsonInput(request));
      await quota(env,client,false);
      const now=new Date().toISOString(),session:Session={id:crypto.randomUUID(),...input,version:0,cart:[],messages:[],confirmationToken:null,createdAt:now,updatedAt:now};
      await env.DB.prepare('INSERT INTO kiosk_sessions (id,client_hash,payload,expires_at) VALUES (?,?,?,?)').bind(session.id,client,JSON.stringify(session),Date.now()+86400000).run();
      return jsonResponse(session,201);
    }
    if(path[0]!=='sessions'||!z.string().uuid().safeParse(path[1]).success)throw new KioskError(404,'NOT_FOUND','API endpoint was not found.');
    const sessionId=path[1];
    if(path.length===2&&method==='GET')return jsonResponse(await getSession(env.DB,sessionId,client));
    if(path.length===4&&method==='GET'&&['orders','service-requests'].includes(path[2])) {
      await getSession(env.DB,sessionId,client);
      const isOrder=path[2]==='orders';
      let row=await env.DB.prepare(`SELECT payload FROM ${isOrder?'kiosk_orders':'kiosk_services'} WHERE id=? AND session_id=?`).bind(path[3],sessionId).first<{payload:string}>();
      if(!row)throw new KioskError(404,isOrder?'ORDER_NOT_FOUND':'REQUEST_NOT_FOUND','The requested record was not found.');
      if(!isOrder){await flushKioskTranslations(env,providers,path[3]);row=await env.DB.prepare('SELECT payload FROM kiosk_services WHERE id=?').bind(path[3]).first<{payload:string}>();}
      await flushKioskOutbox(env,fetchImpl,path[3]);
      return jsonResponse({[isOrder?'order':'serviceRequest']:JSON.parse(row!.payload),stage:await sourceStage(env,path[3]),deliveries:await listDeliveries(env.DB,path[3])});
    }
    if(path.length!==3||method!=='POST')throw new KioskError(404,'NOT_FOUND','API endpoint was not found.');
    if(path[2]==='cart') {
      const input=parse(z.object({itemId:z.string().min(1).max(100),delta:z.number().int().min(-99).max(99).refine(n=>n!==0)}),await jsonInput(request));
      return jsonResponse(await withSession(env.DB,sessionId,client,async(session,lock)=>{
        applyOperations(session,[{itemId:input.itemId,quantity:Math.abs(input.delta),action:input.delta>0?'add':'remove'}],await menu(env.DB));
        await commit(env.DB,session,lock);return session;
      }));
    }
    if(path[2]==='turn') {
      const {input,audio}=await turnInput(request);
      if((!audio&&!input.text)||(audio&&input.text))throw new KioskError(400,'INVALID_INPUT','Provide either a recording or text.');
      const requestId=input.requestId||crypto.randomUUID();
      const inputHash=await hash(JSON.stringify({kind:input.kind,text:input.text,audio:audio?await hash(audio.buffer):null}));
      const result=await withSession(env.DB,sessionId,client,async(session,lock)=>{
        const key=`${sessionId}:${requestId}`;
        const old=await env.DB.prepare('SELECT input_hash,response FROM kiosk_turns WHERE key=?').bind(key).first<{input_hash:string;response:string}>();
        if(old) {
          if(old.input_hash!==inputHash)throw new KioskError(409,'REQUEST_ID_CONFLICT','This request ID belongs to different input.');
          const response=JSON.parse(old.response);
          const latest=response.serviceRequest?await env.DB.prepare('SELECT payload FROM kiosk_services WHERE id=?').bind(response.serviceRequest.id).first<{payload:string}>():null;
          return {...response,session,duplicate:true,...(response.serviceRequest?{serviceRequest:latest?JSON.parse(latest.payload):response.serviceRequest,deliveries:await listDeliveries(env.DB,response.serviceRequest.id)}:{})};
        }
        if(input.kind==='service')mustDeliver(env);
        await quota(env,client);
        const catalog=await menu(env.DB),trace:{stage:string;status:string;durationMs:number}[]=[];
        const step=async<T>(stage:string,fn:()=>Promise<T>):Promise<T>=>{const started=Date.now(),value=await fn();trace.push({stage,status:'ok',durationMs:Date.now()-started});return value;};
        const transcript=audio?await step('clova-speech',()=>providers.transcribe({...audio,language:session.language,kind:input.kind,menu:catalog})):input.text!;
        validText(transcript,'EMPTY_TRANSCRIPT');
        if(!audio)trace.push({stage:'text-input',status:'ok',durationMs:0});
        let koreanText:string|undefined=transcript,reply:string;
        let serviceRequest:undefined|{id:string;sessionId:string;table:string;language:Language;naturalLanguage:string;koreanText?:string;translationStatus:'complete'|'pending';status:'requested';createdAt:string};
        const statements:D1PreparedStatement[]=[];
        if(input.kind==='service') {
          koreanText=session.language==='ko'?transcript:undefined;reply=serviceReply[session.language];
          if(session.language!=='ko') {
            try {koreanText=await step('papago-to-korean',()=>providers.translate({text:transcript,source:session.language,target:'ko'}));validText(koreanText,'INVALID_TRANSLATION');}
            catch {koreanText=undefined;trace.push({stage:'papago-to-korean',status:'pending',durationMs:0});}
          }
          const pending=koreanText===undefined;
          if(pending)reply={ko:'요청을 받았어요. 직원이 확인할 수 있도록 한국어로 옮기고 있어요.',en:'We have your request. We’re translating it into Korean so the staff can read it.',ja:'ご依頼を受け付けました。スタッフが確認できるよう、韓国語に訳しています。',zh:'已收到您的请求，正在翻译成韩语，方便工作人员查看。'}[session.language];
          serviceRequest={id:`svc_${crypto.randomUUID()}`,sessionId,table:session.table,language:session.language,naturalLanguage:transcript,...(koreanText===undefined?{}:{koreanText}),translationStatus:pending?'pending':'complete',status:'requested',createdAt:new Date().toISOString()};
          statements.push(env.DB.prepare(`INSERT INTO kiosk_services (id,session_id,payload,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM kiosk_sessions WHERE id=? AND lock_owner=?)`).bind(serviceRequest.id,sessionId,JSON.stringify(serviceRequest),serviceRequest.createdAt,sessionId,lock),...enqueueStatements(env,'service.requested',serviceRequest,sessionId,lock,pending?'translation_pending':'queued'));
          if(pending)statements.push(env.DB.prepare(`INSERT INTO kiosk_translation_jobs (source_id,client_hash,next_attempt_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM kiosk_sessions WHERE id=? AND lock_owner=?)`).bind(serviceRequest.id,client,Date.now()+30000,sessionId,lock));
          trace.push({stage:'original-request',status:'ok',durationMs:0});
        } else {
          if(session.language!=='ko')koreanText=await step('papago-to-korean',()=>providers.translate({text:transcript,source:session.language,target:'ko'}));
          const answer=await step('clova-studio',()=>providers.chat({text:koreanText!,language:'ko',originalTranscript:transcript,originalLanguage:session.language,menu:catalog,cart:session.cart,history:session.messages.slice(-12),kind:'order'}));
          validText(answer.replyKo);
          const ops=operations.safeParse(answer.operations);
          if(!ops.success)throw new KioskError(502,'INVALID_ASSISTANT_OPERATIONS','The assistant returned an invalid menu change.');
          reply=session.language==='ko'?answer.replyKo:await step('papago-to-customer',()=>providers.translate({text:answer.replyKo,source:'ko',target:session.language}));
          validText(reply);applyOperations(session,ops.data,catalog);
        }
        const at=new Date().toISOString();session.messages.push({role:'user',text:transcript,kind:input.kind,at},{role:'assistant',text:reply,kind:input.kind,at});
        const response={requestId,session,transcript,...(koreanText===undefined?{}:{koreanText}),reply,trace,audioAvailable:false,...(serviceRequest?{receiptCode:'SERVICE_REQUEST_ACCEPTED',serviceRequest}:{})};
        statements.push(env.DB.prepare(`INSERT INTO kiosk_turns (key,session_id,input_hash,response,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM kiosk_sessions WHERE id=? AND lock_owner=?)`).bind(key,sessionId,inputHash,JSON.stringify(response),Date.now(),sessionId,lock));
        await commit(env.DB,session,lock,statements);
        return {...response,...(serviceRequest?{deliveries:await listDeliveries(env.DB,serviceRequest.id)}:{})};
      });
      if(result.serviceRequest) {
        // Commit and release the session lock before network I/O. A customer
        // need not open history for the first attempt; pending translations
        // remain ineligible for delivery until their Korean text is ready.
        await flushKioskOutbox(env,fetchImpl,result.serviceRequest.id);
        result.deliveries=await listDeliveries(env.DB,result.serviceRequest.id);
      }
      return jsonResponse(result);
    }
    if(path[2]==='prepare') {
      await boundedBytes(request,32768);
      return jsonResponse(await withSession(env.DB,sessionId,client,async(session,lock)=>{
        if(!session.cart.length)throw new KioskError(409,'EMPTY_CART','Please add a menu item before reviewing your order.');
        const summary=snapshot(session,await menu(env.DB)),total=summary.reduce((sum,item)=>sum+item.lineTotal,0);
        const summaryKo=`장바구니에 담긴 메뉴는 ${summary.map(item=>`${item.name} ${item.quantity}개`).join(', ')}입니다. 총 ${total.toLocaleString('ko-KR')}원입니다.`;
        let translated=summaryKo;
        if(session.language!=='ko'){await quota(env,client);translated=await providers.translate({text:summaryKo,source:'ko',target:session.language});}
        validText(translated,'INVALID_CONFIRMATION_REPLY');
        if(JSON.stringify(summary)!==JSON.stringify(snapshot(session,await menu(env.DB))))throw new KioskError(409,'MENU_CHANGED','The menu changed. Please review again.');
        const token=crypto.randomUUID(),expires=Date.now()+300000;session.confirmationToken=token;
        await commit(env.DB,session,lock,[
          env.DB.prepare('DELETE FROM kiosk_confirmations WHERE session_id=? AND EXISTS(SELECT 1 FROM kiosk_sessions WHERE id=? AND lock_owner=?)').bind(sessionId,sessionId,lock),
          env.DB.prepare('INSERT INTO kiosk_confirmations (token,session_id,version,snapshot,expires_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM kiosk_sessions WHERE id=? AND lock_owner=?)').bind(token,sessionId,session.version,JSON.stringify(summary),expires,sessionId,lock),
        ]);
        return {session,confirmation:{token,version:session.version,summary,total,expiresAt:new Date(expires).toISOString()},reply:`${translated} ${approvalInstruction[session.language]}`,replyKo:`${summaryKo} ${approvalInstruction.ko}`};
      }));
    }
    if(path[2]==='confirm') {
      const input=parse(z.object({token:z.string().uuid(),version:z.number().int().min(0),approved:z.literal(true)}),await jsonInput(request));
      const result=await withSession(env.DB,sessionId,client,async(session,lock)=>{
        const existing=await env.DB.prepare('SELECT payload FROM kiosk_orders WHERE session_id=? AND confirmation_token=?').bind(sessionId,input.token).first<{payload:string}>();
        if(existing){const order=JSON.parse(existing.payload);return {order,deliveries:await listDeliveries(env.DB,order.id),duplicate:true};}
        const confirmation=await env.DB.prepare('SELECT version,snapshot,expires_at FROM kiosk_confirmations WHERE token=? AND session_id=?').bind(input.token,sessionId).first<{version:number;snapshot:string;expires_at:number}>();
        if(!confirmation||session.confirmationToken!==input.token||session.version!==input.version||confirmation.version!==input.version)throw new KioskError(409,'STALE_CONFIRMATION','Your cart changed. Review it again before approving.');
        if(confirmation.expires_at<Date.now())throw new KioskError(409,'CONFIRMATION_EXPIRED','Your review expired. Please review the order again.');
        if(confirmation.snapshot!==JSON.stringify(snapshot(session,await menu(env.DB))))throw new KioskError(409,'PRICE_CHANGED','The menu or price changed. Please review again.');
        mustDeliver(env);
        const items=JSON.parse(confirmation.snapshot) as ReturnType<typeof snapshot>,now=new Date().toISOString();
        const order={schemaVersion:'1.0',id:`ord_${crypto.randomUUID()}`,eventId:`evt_${crypto.randomUUID()}`,sessionId,table:session.table,language:session.language,items,total:items.reduce((sum,item)=>sum+item.lineTotal,0),currency:'KRW',customerApproved:true,approvedAt:now,createdAt:now};
        session.cart=[];changed(session);
        await commit(env.DB,session,lock,[
          env.DB.prepare('INSERT INTO kiosk_orders (id,session_id,confirmation_token,payload,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM kiosk_sessions WHERE id=? AND lock_owner=?)').bind(order.id,sessionId,input.token,JSON.stringify(order),now,sessionId,lock),
          ...enqueueStatements(env,'order.created',order,sessionId,lock),
        ]);
        return {order,deliveries:await listDeliveries(env.DB,order.id),duplicate:false};
      });
      // This also retries due deliveries on same-token recovery, while the
      // durable outbox keeps the original order/event IDs after a lost ACK.
      await flushKioskOutbox(env,fetchImpl,result.order.id);
      result.deliveries=await listDeliveries(env.DB,result.order.id);
      return jsonResponse(result,result.duplicate?200:201);
    }
    throw new KioskError(404,'NOT_FOUND','API endpoint was not found.');
  } catch(error) {
    if(error instanceof KioskError)return jsonResponse({error:error.message,code:error.code},error.status);
    if(error instanceof Error&&error.name==='ProviderError') {
      const e=error as Error&{code?:string;status?:number;stage?:string;retryable?:boolean};
      return jsonResponse({error:e.message,code:e.code||'PROVIDER_ERROR',stage:e.stage,provider:e.stage,retryable:e.retryable===true},e.status&&e.status>=400&&e.status<=599?e.status:502);
    }
    return jsonResponse({error:'The request could not be completed. Retry the same request.',code:'INTERNAL_ERROR'},503);
  }
}
