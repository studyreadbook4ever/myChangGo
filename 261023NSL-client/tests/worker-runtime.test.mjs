import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { Miniflare } from 'miniflare';

test('real Worker runtime constructs the outbound request and rejects redirects', async () => {
  const source=stripTypeScriptTypes(await readFile(new URL('../lib/order-gateway.ts',import.meta.url),'utf8'));
  const script=source+`\nexport default {fetch(request){return orderGateway(request,{DAMDA_BACKEND_URL:'https://staff.example.com',DAMDA_BACKEND_TOKEN:'test-token',DAMDA_GATEWAY_SECRET:'g'.repeat(64),DAMDA_COOKIE_SECRET:'c'.repeat(64)},async(url,init)=>{const outbound=new Request(url,init); if(request.headers.get('x-test-redirect'))return new Response('{}',{status:302,headers:{location:'https://untrusted.example.com','content-type':'application/json'}});return Response.json({ok:true,redirect:outbound.redirect});})}}`;
  const worker=new Miniflare({modules:true,compatibilityDate:'2026-05-15',script});
  try {
    const response=await worker.dispatchFetch('https://guest.example.com/api/health');
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,redirect:'manual'});
    const redirect=await worker.dispatchFetch('https://guest.example.com/api/health',{headers:{'x-test-redirect':'1'}});
    assert.equal(redirect.status,503);assert.equal(redirect.headers.get('location'),null);
  } finally {await worker.dispose();}
});
