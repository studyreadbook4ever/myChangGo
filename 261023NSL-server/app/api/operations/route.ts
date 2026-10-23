import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { jsonResponse,receiverData } from '@/lib/receiver';
import { authorizePrivateStaff } from '@/lib/staff-auth';
import { getReceiverStore } from '@/lib/receiver-store';
import { changeOperation,operationsData } from '@/lib/kiosk-operations';
import { KioskError } from '@/lib/kiosk-types';
import type { KioskEnv } from '@/lib/kiosk-types';
import { createKioskProviders } from '@/lib/kiosk-providers';

export const dynamic='force-dynamic';
async function authorized(request:Request) {
  const identity=await getChatGPTUser();
  return authorizePrivateStaff(request.headers,env.OPERATOR_TOKEN,identity!==null,env.STAFF_OWNER_EMAIL);
}
function failure(error:unknown) {
  return error instanceof KioskError?jsonResponse({error:error.message,code:error.code},error.status):jsonResponse({error:'Operations are temporarily unavailable.',code:'OPERATIONS_UNAVAILABLE'},503);
}
export async function GET(request:Request) {
  if(!await authorized(request))return jsonResponse({error:'Operator authentication is required.',code:'OPERATOR_AUTH_REQUIRED'},401);
  try{return jsonResponse(await operationsData(env as unknown as KioskEnv,receiverData(await getReceiverStore().list()),fetch,createKioskProviders(env)));}catch(error){return failure(error);}
}
export async function POST(request:Request) {
  if(!await authorized(request))return jsonResponse({error:'Operator authentication is required.',code:'OPERATOR_AUTH_REQUIRED'},401);
  const origin=request.headers.get('origin');
  if(origin&&origin!==new URL(request.url).origin)return jsonResponse({error:'This origin is not allowed.',code:'ORIGIN_NOT_ALLOWED'},403);
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return jsonResponse({error:'application/json is required.',code:'INVALID_CONTENT_TYPE'},415);
  try {
    const reader=request.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
    if(reader){try{while(true){const{value,done}=await reader.read();if(done)break;size+=value.length;if(size>32768){await reader.cancel();throw new KioskError(413,'PAYLOAD_TOO_LARGE','Request body is too large.');}chunks.push(value);}}finally{reader.releaseLock();}}
    const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
    let input:unknown;try{input=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new KioskError(400,'INVALID_JSON','Malformed JSON.');}
    return jsonResponse(await changeOperation(env as unknown as KioskEnv,input));
  }catch(error){return failure(error);}
}
