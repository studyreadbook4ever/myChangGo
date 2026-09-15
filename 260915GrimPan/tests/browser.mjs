import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
// Start the static site and a Chromium 155+ instance with WebMCP enabled first.
// Test contexts are isolated and closed; the connected browser stays running.
const URL=process.env.GRIMPAN_BASE_URL || 'http://127.0.0.1:8766/260915GrimPan/';
const REPORT_DIR=process.env.GRIMPAN_REPORT_DIR || '/tmp/grimpan-qa';
await fs.mkdir(REPORT_DIR,{recursive:true});
const reportPath=name=>path.join(REPORT_DIR,name);
const browser=await chromium.connectOverCDP(process.env.GRIMPAN_CDP_URL || 'http://127.0.0.1:9235');
const ctx=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
const p=await ctx.newPage();const errors=[];const results=[];const contexts=[ctx];
const watch=page=>page.on('pageerror',e=>errors.push(e.message));watch(p);
async function ready(page){await page.waitForFunction(()=>window.grimpan);await page.evaluate(()=>grimpan.ready);await page.waitForFunction(()=>/이 기기에|읽기 전용|실패/.test(document.querySelector('#save-status').textContent));}
const doc=page=>page.evaluate(()=>grimpan.getDocument());
const call=(page,name,args={})=>page.evaluate(async({name,args})=>{const ts=await document.modelContext.getTools();const t=ts.find(t=>t.name===name);if(!t)throw Error('Tool not found '+name);let r=await document.modelContext.executeTool(t,args);for(let i=0;i<3&&typeof r==='string';i++)r=JSON.parse(r);return r;},{name,args});
const ok=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r;};
async function test(name,fn){try{await fn();results.push({name,status:'pass'});console.log('PASS',name);}catch(e){results.push({name,status:'fail',message:e.message,stack:e.stack});console.log('FAIL',name,e.message);await p.screenshot({path:reportPath('failure-'+results.length+'.png')}).catch(()=>{});}}
async function coords(page,x,y){return page.evaluate(({x,y})=>{const r=document.querySelector('#board').getBoundingClientRect(),v=grimpan.getViewport();return{x:r.x+v.x+x*v.zoom,y:r.y+v.y+y*v.zoom};},{x,y});}
async function drag(page,points){const a=await coords(page,...points[0]);await page.mouse.move(a.x,a.y);await page.mouse.down();for(const pt of points.slice(1)){const q=await coords(page,...pt);await page.mouse.move(q.x,q.y,{steps:5});}await page.mouse.up();}
let nativeId,source,share,shared,sharedCtx,fork1,fork2,share2;
try{
await p.goto(URL);await ready(p);
await test('native155 discovery matches thirteen documented tools without comment tools',async()=>{
 const r=await p.evaluate(async()=>({ready:await grimpan.ready,names:(await document.modelContext.getTools()).map(t=>t.name)}));
 const expected=['agent_move','agent_pen','agent_turn','board_edit','board_fork','board_history','board_identity','board_quote','board_react','board_read','board_select','board_share','board_view'];
 assert.equal(r.ready.registered,13);assert.deepEqual(r.names.sort(),expected.sort());
 await fs.writeFile(reportPath('native-app-tools.json'),JSON.stringify(r,null,2));
});

await test('native fork AbortSignal immediate and microtask cancellation preserves document',async()=>{
 const result=await p.evaluate(async()=>{
  const tool=(await document.modelContext.getTools()).find(t=>t.name==='board_fork');
  const cases=[];
  for(const mode of ['immediate','microtask']){
   const before=JSON.stringify(grimpan.getDocument());
   const controller=new AbortController();
   const task=document.modelContext.executeTool(tool,{title:'취소된 포크'},{signal:controller.signal});
   if(mode==='immediate')controller.abort();else queueMicrotask(()=>controller.abort());
   let rejection=null;try{await task;}catch(e){rejection=e.name;}
   await new Promise(resolve=>setTimeout(resolve,150));
   cases.push({mode,rejection,unchanged:before===JSON.stringify(grimpan.getDocument())});
  }
  return cases;
 });
 for(const c of result){assert.equal(c.rejection,'AbortError',JSON.stringify(c));assert.equal(c.unchanged,true,JSON.stringify(c));}
});
await test('busy document rejects overlapping edits and local fork cancellation restores readiness',async()=>{
 const result=await p.evaluate(async()=>{
  const before=JSON.stringify(grimpan.getDocument()),controller=new AbortController();
  const fork=grimpan.call('board_fork',{title:'중단할 포크'},{signal:controller.signal});
  const busy=await grimpan.call('board_edit',{commands:[{type:'clear'}]});
  controller.abort();
  const cancelled=await fork;
  const ready=await grimpan.call('board_read',{});
  return{busy,cancelled,ready,unchanged:before===JSON.stringify(grimpan.getDocument())};
 });
 assert.equal(result.busy.error.code,'DOCUMENT_BUSY');
 assert.equal(result.cancelled.error.code,'ABORTED');
 assert.equal(result.ready.ok,true);assert.equal(result.unchanged,true);
});
await p.locator('#new-board').click();await p.waitForFunction(()=>grimpan.getDocument().objects.length===0);await p.waitForTimeout(150);
await test('native JS-object create move undo redo transaction',async()=>{let r=ok(await call(p,'board_edit',{commands:[{type:'create',object:{type:'rect',x:80,y:80,width:120,height:80,fill:'#d6e8d3',stroke:'#7160d8',strokeWidth:3}}]}));nativeId=r.createdIds[0];assert.ok(nativeId);ok(await call(p,'board_edit',{commands:[{type:'move',ids:[nativeId],dx:30,dy:20}]}));assert.equal((await doc(p)).objects[0].x,110);ok(await call(p,'board_history',{action:'undo'}));assert.equal((await doc(p)).objects[0].x,80);ok(await call(p,'board_history',{action:'redo'}));assert.equal((await doc(p)).objects[0].x,110);});
await test('native invalid batch is atomic',async()=>{const before=await doc(p);const r=await call(p,'board_edit',{commands:[{type:'create',object:{type:'rect',x:0,y:0,width:20,height:20}},{type:'move',ids:['unknown_object'],dx:1,dy:1}]});assert.equal(r.ok,false);assert.deepEqual(await doc(p),before);});
await test('real mouse pen and rectangle drawing',async()=>{ok(await call(p,'board_view',{x:40,y:40,zoom:1}));const n=(await doc(p)).objects.length;await p.locator('[data-tool="pen"]').click();await drag(p,[[280,120],[300,150],[320,110],[345,150]]);assert.equal((await doc(p)).objects.length,n+1);assert.equal((await doc(p)).objects.at(-1).type,'path');await p.locator('[data-tool="rect"]').click();await drag(p,[[390,100],[550,230]]);const rect=(await doc(p)).objects.at(-1);assert.equal(rect.type,'rect');assert.equal(rect.width,160);assert.equal(rect.height,130);});
await test('real mouse select move and style change',async()=>{const rect=(await doc(p)).objects.at(-1);await p.locator('[data-tool="select"]').click();await drag(p,[[440,150],[480,180]]);const after=(await doc(p)).objects.find(o=>o.id===rect.id);assert.equal(after.x,rect.x+40);assert.equal(after.y,rect.y+30);await p.locator('[data-color="#e996a5"]').click();await p.locator('#fill-enabled').check();assert.equal((await doc(p)).objects.find(o=>o.id===rect.id).stroke,'#e996a5');assert.equal((await doc(p)).objects.find(o=>o.id===rect.id).fill,'#e9e3ff');});
await test('real text create and double-click edit',async()=>{await p.locator('[data-tool="text"]').click();const q=await coords(p,100,320);await p.mouse.click(q.x,q.y);await p.locator('#text-content').fill('사람과 에이전트');await p.locator('#text-form button[type="submit"]').click();let text=(await doc(p)).objects.at(-1);assert.equal(text.text,'사람과 에이전트');await p.locator(`[data-object-id="${text.id}"]`).dblclick();await p.locator('#text-content').fill('함께 그려요!');await p.locator('#text-form button[type="submit"]').click();assert.equal((await doc(p)).objects.find(o=>o.id===text.id).text,'함께 그려요!');});
await test('real eraser and keyboard undo',async()=>{const n=(await doc(p)).objects.length;await p.locator('[data-tool="eraser"]').click();const q=await coords(p,140,130);await p.mouse.click(q.x,q.y);assert.equal((await doc(p)).objects.length,n-1);await p.keyboard.press('Control+z');assert.equal((await doc(p)).objects.length,n);});

await test('real note and bubble creation editing and font changes preserve card geometry',async()=>{
 for(const [type,x,y] of [['note',590,300],['bubble',590,520]]){
  await p.locator('#tab-draw').click();await p.locator(`[data-tool="${type}"]`).click();
  const point=await coords(p,x,y);await p.mouse.click(point.x,point.y);
  await p.locator('#text-content').fill(type==='note'?'작은 메모':'함께 이야기해요');
  await p.locator('#text-form button[type="submit"]').click();
  const card=(await doc(p)).objects.at(-1);assert.equal(card.type,type);assert.ok(card.width>0&&card.height>0);
  await p.locator(`[data-object-id="${card.id}"]`).dblclick();
  await p.locator('#text-content').fill(`${type} 수정한 이야기`);await p.locator('#text-form button[type="submit"]').click();
  const edited=(await doc(p)).objects.find(o=>o.id===card.id);
  assert.equal(edited.text,`${type} 수정한 이야기`);assert.equal(edited.width,card.width);assert.equal(edited.height,card.height);
  await p.locator('#font-size').focus();await p.locator('#font-size').press('ArrowRight');
  const resized=(await doc(p)).objects.find(o=>o.id===card.id);
  assert.ok(resized.fontSize>edited.fontSize);assert.equal(resized.width,card.width);assert.equal(resized.height,card.height);
 }
});
await test('story frame UI saves selected bounds and presents frames without editing',async()=>{
 await p.locator('#tab-story').click();
 for(const [title,description] of [['첫 장면','메모에서 시작하는 이야기'],['둘째 장면','말풍선으로 이어지는 생각']]){
  await p.locator('#scene-title').fill(title);await p.locator('#scene-description').fill(description);await p.locator('#scene-add').click();
 }
 const before=await doc(p);assert.equal(before.frames.length,2);assert.equal(await p.locator('#scene-list .story-card').count(),2);
 await p.locator('#scene-list .story-go').first().click();assert.equal(await p.locator('#story-overlay strong').textContent(),'첫 장면');
 await p.locator('#scene-present').click();assert.ok(await p.locator('body').evaluate(e=>e.classList.contains('presenting')));
 await p.getByRole('button',{name:'다음 장면',exact:true}).click();assert.equal(await p.locator('#story-overlay strong').textContent(),'둘째 장면');
 await p.locator('#scene-close').click();assert.deepEqual(await doc(p),before);await p.locator('#tab-draw').click();
});
await test('comment and reply models commands and UI are absent',async()=>{
 const current=await doc(p);assert.equal(Object.hasOwn(current,'comments'),false);
 assert.equal(await p.locator('#comments-list,#comment-form,#comment-text,.discussion-thread,.discussion-composer').count(),0);
 const rejected=await p.evaluate(()=>grimpan.call('board_edit',{commands:[{type:'comment_add',x:0,y:0,text:'removed'}]}));
 assert.equal(rejected.ok,false);assert.deepEqual(await doc(p),current);
});
await test('native identity is tab-memory only and reactions require it without author override',async()=>{
 const identityContext=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(identityContext);
 const identityPage=await identityContext.newPage();watch(identityPage);await identityPage.goto(URL);await ready(identityPage);
 const before=await doc(identityPage);
 const stored=await identityPage.evaluate(()=>({local:{...localStorage},session:{...sessionStorage},cookies:document.cookie}));
 const denied=await call(identityPage,'board_react',{emoji:'👍'});assert.equal(denied.ok,false);assert.equal(denied.error.code,'NICKNAME_REQUIRED');assert.deepEqual(await doc(identityPage),before);
 const result=ok(await call(identityPage,'board_identity',{nickname:'네이티브 보라'}));assert.equal(result.scope,'current_tab');assert.equal(result.authenticated,false);
 assert.equal((await call(identityPage,'board_read',{})).sessionNickname,'네이티브 보라');
 ok(await call(identityPage,'board_react',{emoji:'👍'}));
 const reacted=await doc(identityPage);assert.deepEqual(reacted.reactions.map(({emoji,author})=>({emoji,author})),[{emoji:'👍',author:'네이티브 보라'}]);
 assert.deepEqual(Object.keys(reacted.reactions[0]).sort(),['author','createdAt','emoji']);
 const override=await identityPage.evaluate(()=>grimpan.call('board_react',{emoji:'❤️',author:'다른 사람'}));assert.equal(override.ok,false);assert.deepEqual(await doc(identityPage),reacted);
 assert.deepEqual(await identityPage.evaluate(()=>({local:{...localStorage},session:{...sessionStorage},cookies:document.cookie})),stored);assert.equal((await identityContext.cookies()).length,0);
 await identityPage.waitForTimeout(600);const sibling=await identityContext.newPage();watch(sibling);await sibling.goto(URL);await ready(sibling);assert.equal((await call(sibling,'board_read',{})).sessionNickname,'');
 await identityPage.waitForTimeout(600);await identityPage.reload();await ready(identityPage);
 assert.equal((await call(identityPage,'board_read',{})).sessionNickname,'');
 assert.deepEqual((await doc(identityPage)).reactions,reacted.reactions);
 const again=await call(identityPage,'board_react',{emoji:'❤️'});assert.equal(again.error.code,'NICKNAME_REQUIRED');
});
await test('emoji UI requires nickname first and reload forgets identity but keeps public reaction',async()=>{
 await p.locator('#tab-reactions').click();const before=await doc(p);
 const stored=await p.evaluate(()=>({local:{...localStorage},session:{...sessionStorage},cookies:document.cookie}));
 await p.locator('#board-reactions [data-emoji="👍"]').click();assert.ok(await p.locator('#nickname-dialog').isVisible());assert.deepEqual(await doc(p),before);
 await p.locator('#nickname-dialog-input').fill('그림 친구');await p.locator('#confirm-nickname').click();
 await p.waitForFunction(()=>grimpan.getDocument().reactions.some(r=>r.emoji==='👍'&&r.author==='그림 친구'));
 const reactions=(await doc(p)).reactions;
 assert.equal((await call(p,'board_read',{})).sessionNickname,'그림 친구');assert.ok((await p.locator('#reaction-display-names').textContent()).includes('그림 친구'));
 assert.deepEqual(await p.evaluate(()=>({local:{...localStorage},session:{...sessionStorage},cookies:document.cookie})),stored);assert.equal((await ctx.cookies()).length,0);
 await p.waitForTimeout(600);await p.reload();await ready(p);assert.deepEqual((await doc(p)).reactions,reactions);assert.equal((await call(p,'board_read',{})).sessionNickname,'');
 await p.locator('#tab-reactions').click();await p.locator('#board-reactions [data-emoji="❤️"]').click();assert.ok(await p.locator('#nickname-dialog').isVisible());
 await p.locator('#cancel-nickname').click();assert.deepEqual((await doc(p)).reactions,reactions);await p.locator('#tab-draw').click();
});
await test('IndexedDB save and reload preserves exact document',async()=>{await p.waitForTimeout(800);const before=await doc(p);const dbs=await p.evaluate(()=>indexedDB.databases());assert.ok(dbs.length>0);await p.reload();await ready(p);assert.deepEqual(await doc(p),before);await p.screenshot({path:reportPath('desktop-edited.png')});});
await test('PNG SVG JSON exports are actual downloads',async()=>{await p.locator('#export-open').click();for(const [button,ext]of [['#download-json','.json'],['#download-png','.png'],['#download-svg','.svg']]){const waiting=p.waitForEvent('download');await p.locator(button).click();const d=await waiting;assert.ok(d.suggestedFilename().endsWith(ext));const path=reportPath('export'+ext);await d.saveAs(path);const bytes=await fs.readFile(path);assert.ok(bytes.length>100);if(ext==='.png')assert.equal(bytes.subarray(1,4).toString(),'PNG');if(ext==='.json')assert.deepEqual(JSON.parse(bytes.toString()),await doc(p));if(ext==='.svg')assert.ok(bytes.toString().includes('http://www.w3.org/2000/svg'));}await p.locator('#files-dialog .dialog-close').click();});
await test('malformed snapshot in open-link UI preserves document',async()=>{const before=await doc(p);await p.locator('#export-open').click();await p.locator('#import-url').fill(URL+'#board=invalid');await p.locator('#open-shared-url').click();await p.waitForTimeout(200);assert.deepEqual(await doc(p),before);assert.ok(await p.locator('#toast').isVisible());await p.locator('#files-dialog .dialog-close').click();});
await test('shared snapshot isolated tab read-only guards UI and native edit',async()=>{source=await doc(p);share=ok(await call(p,'board_share',{}));sharedCtx=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(sharedCtx);shared=await sharedCtx.newPage();watch(shared);const quotedURL=new globalThis.URL(share.url);quotedURL.search='?session_token=qa-sensitive-token';await shared.goto(quotedURL.href);await ready(shared);assert.equal(await shared.evaluate(()=>grimpan.isReadOnly()),true);assert.deepEqual(await doc(shared),source);const r=await call(shared,'board_edit',{commands:[{type:'clear'}]});assert.equal(r.ok,false);assert.equal(r.error.code,'READ_ONLY');await shared.locator('[data-tool="pen"]').click();await drag(shared,[[300,300],[330,330]]);assert.deepEqual(await doc(shared),source);await shared.screenshot({path:reportPath('shared-original.png')});});

await test('read-only shared board can present portable frames',async()=>{
 const before=await doc(shared);assert.equal(before.frames.length,2);assert.ok(before.reactions.length>0);
 await shared.locator('#tab-story').click();assert.equal(await shared.locator('#scene-add').isEnabled(),false);
 await shared.locator('#scene-present').click();assert.equal(await shared.locator('#story-overlay strong').textContent(),source.frames[0].title);
 await shared.getByRole('button',{name:'다음 장면',exact:true}).click();assert.equal(await shared.locator('#story-overlay strong').textContent(),source.frames[1].title);
 await shared.locator('#scene-close').click();assert.deepEqual(await doc(shared),before);
});
await test('reacting to a shared original asks nickname then forks while source stays unchanged',async()=>{
 const reactionContext=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(reactionContext);
 const reactionPage=await reactionContext.newPage();watch(reactionPage);await reactionPage.goto(share.url);await ready(reactionPage);
 await reactionPage.locator('#tab-reactions').click();await reactionPage.locator('#board-reactions [data-emoji="❤️"]').click();
 assert.ok(await reactionPage.locator('#nickname-dialog').isVisible());assert.equal(await reactionPage.evaluate(()=>grimpan.isReadOnly()),true);assert.deepEqual(await doc(reactionPage),source);
 await reactionPage.locator('#nickname-dialog-input').fill('이어 그리는 친구');await reactionPage.locator('#confirm-nickname').click();
 await reactionPage.waitForFunction(()=>!grimpan.isReadOnly()&&grimpan.getDocument().reactions.some(r=>r.author==='이어 그리는 친구'));
 const reacted=await doc(reactionPage);assert.notEqual(reacted.id,source.id);assert.equal(reacted.provenance[0].sourceHash,share.hash);
 assert.deepEqual(reacted.provenance[0].snapshot.reactions,source.reactions);assert.deepEqual(await doc(p),source);
});
await test('fork gets distinct board/object IDs; edits preserve original',async()=>{ok(await call(shared,'board_fork',{title:'첫 번째 포크'}));assert.equal(await shared.evaluate(()=>grimpan.isReadOnly()),false);fork1=await doc(shared);assert.equal(JSON.stringify(fork1).includes('qa-sensitive-token'),false);assert.notEqual(fork1.id,source.id);assert.ok(fork1.objects.every(o=>!source.objects.some(s=>s.id===o.id)));assert.equal(fork1.provenance[0].sourceHash,share.hash);const sourcePayload=structuredClone(fork1.provenance[0].snapshot);ok(await call(shared,'board_edit',{commands:[{type:'move',ids:[fork1.objects[0].id],dx:15,dy:20}]}));fork1=await doc(shared);assert.deepEqual(fork1.provenance[0].snapshot,sourcePayload);assert.deepEqual(await doc(p),source);});

await test('source comparison shows original and current SVGs without mutation',async()=>{
 const before=await doc(shared);await shared.locator('#tab-source').click();
 await shared.locator('#source-list .source-buttons').first().locator('button').nth(1).click();
 const views=shared.locator('#compare-dialog .compare-version > svg');assert.equal(await views.count(),2);
 assert.equal(await views.nth(0).evaluate(e=>e.children.length),source.objects.length);
 assert.equal(await views.nth(1).evaluate(e=>e.children.length),before.objects.length);
 assert.deepEqual(await doc(shared),before);await shared.screenshot({path:reportPath('source-comparison.png')});
 await shared.locator('#compare-dialog .dialog-close').click();
});
await test('source panel opens exact original and returns matching hash',async()=>{await shared.locator('#tab-source').click();await shared.locator('#source-list .source-item button').first().click();await shared.waitForFunction(()=>grimpan.isReadOnly());assert.deepEqual(await doc(shared),source);const h=ok(await call(shared,'board_share',{}));assert.equal(h.hash,share.hash);await shared.locator('#open-library').click();await shared.getByRole('button',{name:'첫 번째 포크 열기',exact:true}).click();await shared.waitForFunction(()=>!grimpan.isReadOnly());assert.equal((await doc(shared)).id,fork1.id);});
await test('two-fork source chain portable roundtrip in third context',async()=>{ok(await call(shared,'board_fork',{title:'두 번째 포크'}));fork2=await doc(shared);assert.equal(fork2.provenance.length,2);share2=ok(await call(shared,'board_share',{}));const thirdCtx=await browser.newContext({viewport:{width:1280,height:900}});contexts.push(thirdCtx);const third=await thirdCtx.newPage();watch(third);await third.goto(share2.url);await ready(third);assert.deepEqual(await doc(third),fork2);await third.locator('#tab-source').click();await third.locator('#source-list .source-item button').first().click();await third.waitForFunction(()=>grimpan.getDocument().title==='첫 번째 포크');assert.deepEqual(await doc(third),fork1);await third.locator('#source-list .source-item button').first().click();await third.waitForFunction(id=>grimpan.getDocument().id===id,source.id);assert.deepEqual(await doc(third),source);await third.screenshot({path:reportPath('source-chain-recovered.png')});});


await test('native quote and UI quote preserve source chain and undo target content once',async()=>{
 const quoteContext=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(quoteContext);
 const target=await quoteContext.newPage();watch(target);await target.goto(URL);await ready(target);
 await target.locator('#new-board').click();await target.waitForFunction(()=>grimpan.getDocument().objects.length===0);
 ok(await call(target,'board_edit',{commands:[{type:'create',object:{type:'rect',x:20,y:20,width:80,height:60}}]}));
 const before=await doc(target);
 const content=d=>({id:d.id,title:d.title,author:d.author,objects:d.objects,frames:d.frames,reactions:d.reactions,provenance:d.provenance,agent:d.agent});
 ok(await call(target,'board_quote',{url:share2.url,dx:80,dy:40}));
 const merged=await doc(target);assert.equal(merged.id,before.id);assert.equal(merged.objects.length,before.objects.length+fork2.objects.length);
 assert.equal(merged.frames.length,before.frames.length+fork2.frames.length);assert.deepEqual(merged.reactions,before.reactions);
 const quoted=merged.provenance.find(entry=>entry.sourceHash===share2.hash);assert.ok(quoted);
 assert.deepEqual(quoted.snapshot.objects,fork2.objects);assert.deepEqual(quoted.snapshot.frames,fork2.frames);assert.deepEqual(quoted.snapshot.reactions,fork2.reactions);
 assert.ok(merged.provenance.some(entry=>entry.sourceHash===share.hash));assert.deepEqual(await doc(p),source);
 ok(await call(target,'board_history',{action:'undo'}));assert.deepEqual(content(await doc(target)),content(before));
 await target.locator('#tab-draw').click();await target.locator('#export-open').click();await target.locator('#import-url').fill(share2.url);await target.locator('#quote-shared-url').click();
 await target.waitForFunction(n=>grimpan.getDocument().objects.length===n,before.objects.length+fork2.objects.length);
 assert.equal((await doc(target)).id,before.id);await target.locator('#undo').click();assert.deepEqual(content(await doc(target)),content(before));
});
await test('source open versus new board keeps latest document and URL aligned',async()=>{
 await shared.locator('#tab-source').click();
 await shared.evaluate(()=>{document.querySelector('#source-list .source-item button').click();document.querySelector('#new-board').click();});
 await shared.waitForFunction(()=>grimpan.getDocument().title==='제목 없는 그림'&&grimpan.getDocument().objects.length===0&&!grimpan.isReadOnly());
 const after=await doc(shared);
 await shared.waitForTimeout(350);
 assert.deepEqual(await doc(shared),after);
 assert.equal(await shared.evaluate(()=>location.hash),'');
 assert.equal((await call(shared,'board_read',{})).ok,true);
});
await test('star completes; garden stop freezes edits and raises pen',async()=>{await p.bringToFront();await p.locator('#tab-agent').click();let n=(await doc(p)).objects.length;await p.locator('#demo-star').click();await p.waitForFunction(()=>document.querySelector('#stop-agent').disabled,{},{timeout:10000});assert.equal((await doc(p)).objects.length,n+10);await p.locator('#demo-garden').click();await p.waitForTimeout(460);await p.locator('#stop-agent').click();const stopped=await doc(p);assert.equal(stopped.agent.penDown,false);await p.waitForTimeout(500);assert.deepEqual(await doc(p),stopped);await p.screenshot({path:reportPath('agent-demo.png')});});
await test('malformed hash navigation preserves current nonempty board',async()=>{const before=await doc(p);await p.evaluate(()=>location.hash='board=malformed');await p.waitForTimeout(250);assert.deepEqual(await doc(p),before);await p.evaluate(()=>history.replaceState(null,'',location.pathname));});

await test('invalid hash preserves an existing empty board and restores its URL',async()=>{
 await p.locator('#new-board').click();await p.waitForFunction(()=>grimpan.getDocument().objects.length===0);
 await p.locator('#board-title').fill('소중한 빈 보드');await p.locator('#board-title').press('Tab');
 const before=await doc(p),beforeURL=p.url();
 await p.evaluate(()=>location.hash='board=invalid');await p.waitForTimeout(250);
 assert.deepEqual(await doc(p),before);assert.equal(p.url(),beforeURL);
});
await test('mobile 390px layout and canvas pointer drawing',async()=>{const mobileCtx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});contexts.push(mobileCtx);const m=await mobileCtx.newPage();watch(m);await m.goto(URL);await ready(m);await m.screenshot({path:reportPath('mobile-initial.png'),fullPage:true});const dims=await m.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,board:document.querySelector('#board').getBoundingClientRect().toJSON()}));assert.ok(dims.scroll<=dims.width+1,JSON.stringify(dims));assert.ok(dims.board.width>150&&dims.board.height>150,JSON.stringify(dims));await m.locator('[data-tool="pen"]').click();const b=await m.locator('#board').boundingBox();const n=(await doc(m)).objects.length;await m.mouse.move(b.x+b.width*.3,b.y+b.height*.5);await m.mouse.down();await m.mouse.move(b.x+b.width*.7,b.y+b.height*.6,{steps:10});await m.mouse.up();assert.equal((await doc(m)).objects.length,n+1);});
await test('no uncaught browser JavaScript exceptions',async()=>{assert.deepEqual(errors,[]);});
}finally{await fs.writeFile(reportPath('results.json'),JSON.stringify({browser:await browser.version(),baseURL:URL,results,errors},null,2));for(const c of contexts)await c.close();await browser.close();}
if(results.some(r=>r.status==='fail'))process.exitCode=1;
