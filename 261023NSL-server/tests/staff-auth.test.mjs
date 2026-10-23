import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const directory=mkdtempSync(new URL('../.test-staff-auth-',import.meta.url).pathname);
for(const name of ['receiver','staff-auth']) {
  const source=readFileSync(new URL(`../lib/${name}.ts`,import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace("from './receiver'", "from './receiver.mjs'");
  writeFileSync(`${directory}/${name}.mjs`,code);
}
const {authorizePrivateStaff}=await import(pathToFileURL(`${directory}/staff-auth.mjs`));
test.after(()=>rmSync(directory,{recursive:true,force:true}));
const token='test-operator-token-long-enough-for-authorization';
const owner='owner@example.test';

test('complete platform identity and explicit operator token retain private staff access',async()=>{
  assert.equal(await authorizePrivateStaff(new Headers(),token,true,undefined),true);
  assert.equal(await authorizePrivateStaff(new Headers({authorization:`Bearer ${token}`}),token,false,undefined),true);
});
test('email-only platform identity requires an explicit matching owner pin',async()=>{
  const headers=new Headers({'oai-authenticated-user-email':'Owner@Example.test'});
  assert.equal(await authorizePrivateStaff(headers,token,false,undefined),false);
  assert.equal(await authorizePrivateStaff(headers,token,false,'someone-else@example.test'),false);
  assert.equal(await authorizePrivateStaff(headers,token,false,owner),true);
  assert.equal(await authorizePrivateStaff(new Headers({'oai-authenticated-user-email':'not-an-email'}),token,false,'not-an-email'),false);
});
test('service access and display name alone cannot become staff identity',async()=>{
  assert.equal(await authorizePrivateStaff(new Headers({'OAI-Sites-Authorization':'Bearer service-credential'}),token,false,owner),false);
  assert.equal(await authorizePrivateStaff(new Headers({'oai-authenticated-user-full-name':'Owner'}),token,false,owner),false);
  assert.equal(await authorizePrivateStaff(new Headers({authorization:'Bearer wrong-token'}),token,false,owner),false);
});
test('public gateway requests never gain staff access through identity or a pinned email',async()=>{
  const headers=new Headers({'x-damda-gateway':'gateway-secret','oai-authenticated-user-email':owner});
  assert.equal(await authorizePrivateStaff(headers,token,false,owner),false);
  assert.equal(await authorizePrivateStaff(headers,token,true,owner),false);
});
