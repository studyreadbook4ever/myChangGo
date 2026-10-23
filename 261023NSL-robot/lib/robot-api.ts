import {z} from 'zod';
import {authorizePrivateStaff} from './robot-auth';
import {jsonResponse} from './robot-receiver';
import {getRobotJob,listRobotJobs,robotQuota,saveRobotJob,withRobotJob} from './robot-store';
import {RobotError,type RobotEnv,type RobotJob,type RobotProviders,type RobotStage} from './robot-types';

const id=z.string().min(1).max(100),requestId=z.string().uuid();
const actionSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('prepare'),jobId:id}).strict(),
  z.object({action:z.literal('stage'),jobId:id,stage:z.enum(['queued','ready','en_route','arrived','completed','needs_staff']),version:z.number().int().min(0)}).strict(),
]);
function parse<T extends z.ZodTypeAny>(schema:T,input:unknown):z.output<T>{const parsed=schema.safeParse(input);if(!parsed.success)throw new RobotError(400,'INVALID_INPUT','요청 내용을 확인해 주세요.');return parsed.data;}
async function bytes(request:Request,maximum:number){
  const length=request.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>maximum))throw new RobotError(413,'PAYLOAD_TOO_LARGE','요청이 너무 커요. 녹음을 짧게 해 주세요.');
  const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
  if(reader)try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>maximum){await reader.cancel();throw new RobotError(413,'PAYLOAD_TOO_LARGE','요청이 너무 커요.');}chunks.push(part.value);}}finally{reader.releaseLock();}
  const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
async function jsonInput(request:Request){
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new RobotError(415,'INVALID_CONTENT_TYPE','요청 형식을 확인해 주세요.');
  const value=await bytes(request,32768);try{return JSON.parse(new TextDecoder().decode(value));}catch{throw new RobotError(400,'INVALID_JSON','요청을 읽지 못했어요.');}
}
function validText(value:unknown,maximum=800):asserts value is string{if(typeof value!=='string'||!value.trim()||value.length>maximum)throw new RobotError(502,'INVALID_RESPONSE','응답을 준비하지 못했어요. 다시 시도해 주세요.');}
async function digest(value:string|Uint8Array){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');}
function errorInfo(error:unknown){
  if(error instanceof RobotError)return {status:error.status,code:error.code,error:error.message};
  const e=error as {status?:number;code?:string};
  const code=typeof e?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?e.code:'ROBOT_UNAVAILABLE';
  return {status:Number.isInteger(e?.status)&&e.status!>=400&&e.status!<=599?e.status!:503,code,error:code==='TTS_UNAVAILABLE'?'네이버 음성 출력이 아직 연결되지 않았어요.':'요청을 처리하지 못했어요. 잠시 후 같은 요청으로 다시 시도해 주세요.'};
}
async function answer(providers:RobotProviders,job:RobotJob,kind:'prepare'|'followup',originalText?:string,textKo?:string){
  const result=await providers.respond({kind,job:{type:job.type,table:job.table,language:job.language,stage:job.stage,data:job.data},originalText,textKo,history:job.messages.slice(-10)});
  const parsed=z.object({commentNeeded:z.boolean(),replyKo:z.string().max(800),needsStaff:z.boolean()}).strict().safeParse(result);
  if(!parsed.success)throw new RobotError(502,'INVALID_ROBOT_RESPONSE','안내 내용을 확인하지 못했어요. 다시 준비해 주세요.');
  const checked=parsed.data;
  if(!checked.commentNeeded)return {...checked,reply:''};
  validText(checked.replyKo);
  const reply=job.language==='ko'?checked.replyKo:await providers.translate({text:checked.replyKo,source:'ko',target:job.language});validText(reply);
  return {...checked,reply};
}

/** All interactive robot endpoints are private-owner/operator only. Webhook
 * entry has its separate signed, bounded handler and never calls providers. */
export async function handleRobot(request:Request,env:RobotEnv,providers:RobotProviders,completePlatformIdentity=false):Promise<Response>{
  try{
    if(!await authorizePrivateStaff(request.headers,env.OPERATOR_TOKEN,completePlatformIdentity,env.STAFF_OWNER_EMAIL))throw new RobotError(401,'OPERATOR_AUTH_REQUIRED','이 화면을 사용할 계정으로 로그인해 주세요.');
    if(!env.DB)throw new RobotError(503,'DATABASE_UNAVAILABLE','저장소를 준비하고 있어요.');
    const path=new URL(request.url).pathname,capabilities={...providers.status(),audioStored:false,physicalControl:false};
    if(request.method==='GET'&&path==='/api/health')return jsonResponse({ok:true,role:'robot',capabilities});
    if(request.method==='GET'&&path==='/api/robot')return jsonResponse({jobs:await listRobotJobs(env.DB),capabilities});
    if(request.method!=='POST')throw new RobotError(404,'NOT_FOUND','요청 경로를 찾을 수 없어요.');
    const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)throw new RobotError(403,'ORIGIN_REJECTED','이 화면에서 다시 요청해 주세요.');
    if(path==='/api/robot'){
      const input=parse(actionSchema,await jsonInput(request));
      const result=await withRobotJob(env.DB,input.jobId,async(job,owner)=>{
        if(input.action==='stage'){
          if(input.version!==job.version)throw new RobotError(409,'JOB_CHANGED','다른 화면에서 상태가 바뀌었어요. 새로고침해 주세요.');
          const transitions:Record<RobotStage,RobotStage[]>={queued:['needs_staff'],ready:['en_route','needs_staff'],en_route:['arrived','needs_staff'],arrived:['completed','needs_staff'],completed:[],needs_staff:job.prepared?['ready']:[]};
          if(!transitions[job.stage].includes(input.stage))throw new RobotError(409,'INVALID_STAGE_TRANSITION','현재 단계에서는 이 처리를 할 수 없어요.');
          job.stage=input.stage;if(input.stage==='needs_staff')job.needsStaff=true;else if(input.stage==='ready')job.needsStaff=false;
          await saveRobotJob(env.DB,job,owner);return {job};
        }
        if(job.prepared)return {job,duplicate:true};
        let preparedAnswer:Awaited<ReturnType<typeof answer>>;
        try{
          await robotQuota(env,job.id);
          preparedAnswer=await answer(providers,job,'prepare');
        }catch(error){job.preparationStatus='failed';job.latestError={code:errorInfo(error).code,message:'응답 준비가 멈췄어요. 다시 준비를 눌러 주세요.'};await saveRobotJob(env.DB,job,owner);throw error;}
        const result=preparedAnswer;
        if(result.commentNeeded)job.messages.push({id:crypto.randomUUID(),role:'assistant',text:result.reply,koText:result.replyKo,createdAt:new Date().toISOString(),origin:'prepare',commentNeeded:true,needsStaff:result.needsStaff});
        job.prepared=true;job.preparationStatus='ready';job.needsStaff=result.needsStaff||job.stage==='needs_staff';job.stage=job.needsStaff?'needs_staff':'ready';job.latestError=null;
        // A save failure must not persist a contradictory prepared+failed job.
        // A committed result remains idempotent; an uncommitted result can retry.
        await saveRobotJob(env.DB,job,owner);return {job,duplicate:false};
      });return jsonResponse(result);
    }
    if(path==='/api/robot/turn'){
      let input:{jobId:string;requestId:string;text?:string},audio:Uint8Array|undefined,mimeType='audio/wav';
      if(request.headers.get('content-type')?.startsWith('multipart/form-data;')){
        const body=await bytes(request,2*1024*1024+16384);let form:FormData;
        try{form=await new Request(request.url,{method:'POST',headers:{'content-type':request.headers.get('content-type')!},body:new Uint8Array(body)}).formData();}catch{throw new RobotError(400,'INVALID_AUDIO','녹음 파일을 읽지 못했어요.');}
        const keys=[...form.keys()];if(keys.length!==3||new Set(keys).size!==3||keys.some(k=>!['jobId','requestId','audio'].includes(k)))throw new RobotError(400,'INVALID_INPUT','녹음 요청을 확인해 주세요.');
        input=parse(z.object({jobId:id,requestId}),{jobId:form.get('jobId'),requestId:form.get('requestId')});
        const file=form.get('audio');if(!file||typeof file==='string'||!file.size||file.size>2*1024*1024)throw new RobotError(413,'INVALID_AUDIO_SIZE','2MB 이하의 녹음이 필요해요.');
        mimeType=file.type;if(!/^audio\/(wav|wave|x-wav)(;|$)/.test(mimeType))throw new RobotError(415,'INVALID_AUDIO_TYPE','PCM WAV 녹음이 필요해요.');audio=new Uint8Array(await file.arrayBuffer());
      }else input=parse(z.object({jobId:id,requestId,text:z.string().max(5000).refine(text=>text.trim().length>0)}).strict(),await jsonInput(request));
      const hash=await digest(JSON.stringify({text:input.text,audio:audio?await digest(audio):null,mimeType:audio?mimeType:null}));
      const result=await withRobotJob(env.DB,input.jobId,async(job,owner)=>{
        const key=`${job.id}:${input.requestId}`,old=await env.DB.prepare('SELECT input_hash,response FROM robot_turns WHERE key=?').bind(key).first<{input_hash:string;response:string}>();
        if(old){if(old.input_hash!==hash)throw new RobotError(409,'REQUEST_ID_CONFLICT','다른 내용에 사용된 요청 번호예요.');return {...JSON.parse(old.response),job,duplicate:true};}
        if(job.stage==='completed')throw new RobotError(409,'JOB_COMPLETED','완료된 요청이에요. 새 요청을 선택해 주세요.');
        if(!job.prepared)throw new RobotError(409,'JOB_NOT_READY','먼저 요청 내용을 준비해 주세요.');
        await robotQuota(env,job.id);
        const transcript=audio?await providers.transcribe({buffer:audio,mimeType,language:job.language}):input.text!;validText(transcript,5000);
        const koreanText=job.language==='ko'?transcript:await providers.translate({text:transcript,source:job.language,target:'ko'});validText(koreanText,8000);
        const result=await answer(providers,job,'followup',transcript,koreanText),at=new Date().toISOString();
        job.messages.push({id:crypto.randomUUID(),role:'user',text:transcript,koText:koreanText,createdAt:at,origin:'followup'});
        const messageId=result.commentNeeded?crypto.randomUUID():null;
        if(messageId)job.messages.push({id:messageId,role:'assistant',text:result.reply,koText:result.replyKo,createdAt:at,origin:'followup',commentNeeded:true,needsStaff:result.needsStaff});
        // Conversation may request staff attention, but never advances a
        // physical stage or creates a new food order.
        job.needsStaff=job.needsStaff||result.needsStaff;job.latestError=null;
        const response={transcript,koreanText,reply:result.reply,messageId,commentNeeded:result.commentNeeded,needsStaff:result.needsStaff};
        await saveRobotJob(env.DB,job,owner,[env.DB.prepare(`INSERT INTO robot_turns(key,job_id,input_hash,response,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM robot_jobs WHERE id=? AND lock_owner=?)`).bind(key,job.id,hash,JSON.stringify(response),at,job.id,owner)]);
        return {job,...response,duplicate:false};
      });return jsonResponse(result);
    }
    if(path==='/api/robot/speak'){
      const input=parse(z.object({jobId:id,messageId:z.string().uuid()}).strict(),await jsonInput(request));
      const job=await getRobotJob(env.DB,input.jobId),message=job.messages.find(m=>m.id===input.messageId&&m.role==='assistant'&&m.commentNeeded);
      if(!message)throw new RobotError(404,'MESSAGE_NOT_FOUND','음성으로 안내할 문장을 찾을 수 없어요.');
      if(!capabilities.tts)throw new RobotError(503,'TTS_UNAVAILABLE','네이버 음성 출력이 아직 연결되지 않았어요.');
      await robotQuota(env,job.id,'tts');const audio=await providers.synthesize({text:message.text,language:job.language});
      if(!audio.length||audio.length>4*1024*1024)throw new RobotError(502,'INVALID_TTS_AUDIO','음성 응답을 확인하지 못했어요.');
      return new Response(new Uint8Array(audio),{headers:{'content-type':'audio/mpeg','cache-control':'no-store','x-content-type-options':'nosniff'}});
    }
    throw new RobotError(404,'NOT_FOUND','요청 경로를 찾을 수 없어요.');
  }catch(error){const info=errorInfo(error);return jsonResponse({error:info.error,code:info.code},info.status);}
}
