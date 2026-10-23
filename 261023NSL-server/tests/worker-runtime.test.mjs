import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Run production request builders inside workerd. Mock response payloads do not
// bypass workerd's native Request constructor (Node accepts unsupported options).
// The intercepted transport never performs a network request or plays audio.
const entry = `
import {createKioskProviders} from './lib/kiosk-providers.ts';
import {flushKioskOutbox} from './lib/kiosk-outbox.ts';
const credentials={CLOVA_SPEECH_INVOKE_URL:'https://clovaspeech-gw.ncloud.com/external/v1/1/test',CLOVA_SPEECH_SECRET:'fixture-speech',PAPAGO_CLIENT_ID:'fixture-papago-id',PAPAGO_CLIENT_SECRET:'fixture-papago-secret',CLOVA_STUDIO_API_KEY:'fixture-studio'};
function wav(){
  const bytes=new Uint8Array(32044),v=new DataView(bytes.buffer);
  const write=(at,value)=>bytes.set(new TextEncoder().encode(value),at);
  write(0,'RIFF');v.setUint32(4,bytes.length-8,true);write(8,'WAVEfmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
  v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);
  write(36,'data');v.setUint32(40,32000,true);return bytes;
}
export default {async fetch(request){
  const path=new URL(request.url).pathname,stage=path.split('/')[1],redirect=path.endsWith('/redirect'),observed=[];
  const transport=async(url,init)=>{
    const outbound=new Request(url,init);
    observed.push({host:new URL(outbound.url).hostname,redirect:outbound.redirect,method:outbound.method});
    if(redirect)return new Response(null,{status:307,headers:{location:'https://must-not-follow.invalid/secret'}});
    if(stage==='speech')return Response.json({result:'COMPLETED',text:'  Water, please. '});
    if(stage==='translation')return Response.json({message:{result:{translatedText:'물을 주세요.'}}});
    if(stage==='chat')return Response.json({status:{code:'20000'},result:{finishReason:'stop',message:{content:JSON.stringify({replyKo:'담았어요.',operations:[{itemId:'udon',quantity:1,action:'add'}],serviceRequest:false})}}});
    const event=await outbound.json();
    if(!/^sha256=[a-f0-9]{64}$/.test(outbound.headers.get('x-kiosk-signature')||''))throw new Error('Missing signature');
    return Response.json({accepted:true,eventId:event.eventId});
  };
  globalThis.fetch=transport;
  try{
    if(stage==='outbox'){
      const row={id:'del_fixture',event_id:'evt_fixture',source_id:'ord_fixture',target:'kitchen',url:'https://receiver.example/api/webhooks/orders',payload:JSON.stringify({eventId:'evt_fixture',target:'kitchen',data:{id:'ord_fixture'}}),status:'queued',attempts:0};
      const DB={prepare(sql){let args;return {bind(...values){args=values;return this},async all(){return {results:[row]}},async first(){return {id:row.id}},async run(){row.status=sql.includes("status='delivered'")?'delivered':args[0];row.error=row.status==='delivered'?null:args[2];return {success:true}}}}};
      await flushKioskOutbox({DB,WEBHOOK_SECRET:'fixture-webhook-secret-over-thirty-two-characters',KITCHEN_WEBHOOK_URL:row.url,ROBOT_WEBHOOK_URL:row.url,KITCHEN_WEBHOOK_SITES_TOKEN:'fixture-sites',ROBOT_WEBHOOK_SITES_TOKEN:'fixture-sites'},transport);
      return Response.json({observed,status:row.status,error:row.error});
    }
    const provider=createKioskProviders(credentials);
    const value=stage==='speech'?await provider.transcribe({buffer:wav(),mimeType:'audio/wav',language:'en',kind:'service'})
      :stage==='translation'?await provider.translate({text:'Water '+path,source:'en',target:'ko'})
      :await provider.chat({text:'우동 하나',language:'ko',menu:[{id:'udon',name:{ko:'우동'}}]});
    return Response.json({observed,value});
  }catch(error){return Response.json({observed,code:error.code||'UNEXPECTED_RUNTIME_ERROR'});}
}};
`;

test('actual Worker request contracts accept provider and signed receiver requests without credential-following redirects', async t => {
  const bundled = await build({stdin:{contents:entry,resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'worker-runtime-fixture.ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
  const worker = new Miniflare({modules:true,compatibilityDate:'2026-05-15',script:bundled.outputFiles[0].text});
  try {
    for(const stage of ['speech','translation','chat','outbox'])await t.test(stage,async()=>{
      const regular=await (await worker.dispatchFetch(`https://fixture.example/${stage}`)).json();
      assert.equal(regular.code,undefined,`${stage}: production request must construct in workerd`);
      assert.equal(regular.observed.length,1);
      assert.equal(regular.observed[0].redirect,'manual');
      assert.equal(regular.observed[0].method,'POST');
      if(stage==='outbox')assert.equal(regular.status,'delivered');
      const blocked=await (await worker.dispatchFetch(`https://fixture.example/${stage}/redirect`)).json();
      assert.equal(blocked.observed.length,1,'No redirect target should be requested');
      assert.ok(blocked.observed.every(call=>call.host!=='must-not-follow.invalid'));
      if(stage==='outbox'){
        assert.equal(blocked.status,'retrying');
        assert.equal(blocked.error,'Receiver redirect was blocked (HTTP 307).');
      }else assert.equal(blocked.code,'PROVIDER_REDIRECT_BLOCKED');
    });
  } finally {await worker.dispose();}
});
