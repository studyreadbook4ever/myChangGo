import type {ReceiverStore,StoredEvent,ReceiverEvent} from './robot-receiver';
import {RobotError,type RobotEnv,type RobotJob} from './robot-types';

export function robotReceiverStore(db:D1Database):ReceiverStore{
  return {
    async insertIfAbsent(event:StoredEvent){
      const wire=JSON.parse(event.payload) as ReceiverEvent,data=wire.data;
      const originalText=wire.type==='service.requested'?wire.data.naturalLanguage:wire.data.items.map(item=>`${item.name} ${item.quantity}개`).join(', ');
      const koreanText=wire.type==='service.requested'?(wire.data.koreanText||wire.data.naturalLanguage):originalText;
      const job:RobotJob={id:event.eventId,sourceId:event.sourceId,type:event.type,table:data.table,language:data.language,originalText,koreanText,data,
        stage:'queued',version:0,prepared:false,preparationStatus:'pending',messages:[],needsStaff:false,receivedAt:event.receivedAt,updatedAt:event.receivedAt,latestError:null};
      const row=await db.prepare(`INSERT INTO robot_jobs(id,source_id,event_type,payload_hash,event_payload,job_payload,received_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id`).bind(event.eventId,event.sourceId,event.type,event.payloadHash,event.payload,JSON.stringify(job),event.receivedAt,event.receivedAt).first();
      return Boolean(row);
    },
    async get(id){
      const row=await db.prepare('SELECT id,source_id,event_type,payload_hash,event_payload,received_at FROM robot_jobs WHERE id=?').bind(id).first<{id:string;source_id:string;event_type:StoredEvent['type'];payload_hash:string;event_payload:string;received_at:string}>();
      return row?{eventId:row.id,sourceId:row.source_id,type:row.event_type,target:'robot',payloadHash:row.payload_hash,payload:row.event_payload,receivedAt:row.received_at}:undefined;
    },
    async list(){return [];},
  };
}
export async function getRobotJob(db:D1Database,id:string):Promise<RobotJob>{
  const row=await db.prepare('SELECT job_payload FROM robot_jobs WHERE id=?').bind(id).first<{job_payload:string}>();
  if(!row)throw new RobotError(404,'JOB_NOT_FOUND','요청을 찾을 수 없어요. 새로고침해 주세요.');return JSON.parse(row.job_payload);
}
export async function listRobotJobs(db:D1Database):Promise<RobotJob[]>{
  const rows=await db.prepare("SELECT job_payload FROM robot_jobs ORDER BY CASE WHEN json_extract(job_payload,'$.stage')='completed' THEN 1 ELSE 0 END,received_at DESC LIMIT 100").all<{job_payload:string}>();
  return rows.results.map(row=>JSON.parse(row.job_payload));
}
export async function withRobotJob<T>(db:D1Database,id:string,run:(job:RobotJob,owner:string)=>Promise<T>):Promise<T>{
  await getRobotJob(db,id);const owner=crypto.randomUUID(),now=Date.now();
  const row=await db.prepare('UPDATE robot_jobs SET lock_owner=?,lock_until=? WHERE id=? AND lock_until<=? RETURNING job_payload').bind(owner,now+180000,id,now).first<{job_payload:string}>();
  if(!row)throw new RobotError(409,'JOB_BUSY','이 요청을 처리 중이에요. 잠시 후 다시 확인해 주세요.');
  try{return await run(JSON.parse(row.job_payload),owner);}finally{await db.prepare('UPDATE robot_jobs SET lock_owner=NULL,lock_until=0 WHERE id=? AND lock_owner=?').bind(id,owner).run();}
}
export async function saveRobotJob(db:D1Database,job:RobotJob,owner:string,extra:D1PreparedStatement[]=[]){
  job.updatedAt=new Date().toISOString();job.version++;job.messages=job.messages.slice(-30);
  const statements=[...extra,db.prepare('UPDATE robot_jobs SET job_payload=?,version=?,updated_at=? WHERE id=? AND lock_owner=? RETURNING id').bind(JSON.stringify(job),job.version,job.updatedAt,job.id,owner)];
  const result=await db.batch(statements);if(!result.at(-1)?.results.length)throw new RobotError(409,'JOB_BUSY','처리 시간이 길어졌어요. 같은 요청으로 다시 확인해 주세요.');
}
export async function robotQuota(env:RobotEnv,jobId:string,kind:'ai'|'tts'='ai'){
  const now=Date.now(),minute=Math.floor(now/60000),day=Math.floor(now/86400000);
  const configured=Number(env.ROBOT_DAILY_AI_LIMIT),daily=Number.isSafeInteger(configured)&&configured>0?Math.min(configured,1000):200;
  await env.DB.prepare('DELETE FROM robot_quotas WHERE expires_at<?').bind(now).run();
  for(const [key,limit,expires] of [[`${kind}:global:${day}`,kind==='ai'?daily:300,(day+2)*86400000],[`${kind}:job:${jobId}:${minute}`,kind==='ai'?8:12,(minute+2)*60000]] as const){
    const used=await env.DB.prepare('INSERT INTO robot_quotas(key,used,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET used=used+1 RETURNING used').bind(key,expires).first<{used:number}>();
    if(!used||used.used>limit)throw new RobotError(429,'RATE_LIMITED','요청이 많아요. 잠시 후 다시 시도해 주세요.');
  }
}
