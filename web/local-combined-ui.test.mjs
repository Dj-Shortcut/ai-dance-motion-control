// jsdom UI -> local workerd HTTP -> local D1/R2 -> mock providers. No deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {createBrowserAuth} from './browser-auth.mjs';
import {prepareBoundUi} from './frontend/multiuser/ui-auth.mjs';
const {Miniflare}=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json')('miniflare');
const waitFor=async fn=>{for(let i=0;i<400;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw Error('UI did not settle')};
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const stmt of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(stmt).run()}

test('two UI sessions use simulated checkout, price confirmation, recovery and private video on local D1/R2',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.rig-combined-ui-'));let mf;const windows=[];
 try{
  for(const [input,output] of [['local-combined-ingress.mjs','ingress.mjs'],['local-combined-private.mjs','private.mjs'],['local-mock-auth.mjs','auth.mjs'],['local-mock-fal.mjs','fal.mjs'],['local-mock-mollie.mjs','mollie.mjs']])
   await build({entryPoints:[input],outfile:join(dir,output),bundle:true,format:'esm',platform:'browser',logLevel:'silent',loader:{'.mp4':'base64'}});
  mf=new Miniflare({workers:[
   {name:'ingress',modules:true,scriptPath:join(dir,'ingress.mjs'),compatibilityDate:'2026-01-01',bindings:{LOCAL_FIXTURE:'yes',RIG_PUBLIC_ORIGIN:'https://rig.local'},serviceBindings:{PRIVATE_ROUTER:'private'}},
   {name:'private',modules:true,scriptPath:join(dir,'private.mjs'),compatibilityDate:'2026-01-01',bindings:{LOCAL_FIXTURE:'yes',RIG_PUBLIC_ORIGIN:'https://rig.local'},d1Databases:{DB:'combined-ui'},r2Buckets:{BUCKET:'combined-ui'},serviceBindings:{MOCK_AUTH:'auth',MOCK_FAL:'fal',MOCK_MOLLIE:'mollie'}},
   {name:'auth',modules:true,scriptPath:join(dir,'auth.mjs'),compatibilityDate:'2026-01-01'},
   {name:'fal',modules:true,scriptPath:join(dir,'fal.mjs'),compatibilityDate:'2026-01-01',bindings:{LOCAL_FIXTURE:'yes'},d1Databases:{DB:'combined-ui'}},
   {name:'mollie',modules:true,scriptPath:join(dir,'mollie.mjs'),compatibilityDate:'2026-01-01'}
  ]});
  const db=await mf.getD1Database('DB','private');for(const file of ['./public-identity-schema.sql','./cloudflare-migrations/0001_test_baseline.sql','./local-video-schema.sql'])await migrate(db,file);
  const html=await readFile('frontend/multiuser/index.html','utf8'),payments=await readFile('frontend/multiuser/payments.js','utf8'),generation=await readFile('frontend/multiuser/generation-ui.js','utf8');
  const jpeg=await readFile('trial-fixtures/synthetic.jpg'),video=await readFile('trial-fixtures/synthetic.mp4');
  const mockMollie=await mf.getWorker('mollie'),privateWorker=await mf.getWorker('private');
  async function makeUi(token){
   const dom=new JSDOM(html,{url:'https://rig.local/multiuser/',runScripts:'outside-only'}),win=dom.window;windows.push(dom);
   win.HTMLMediaElement.prototype.pause=()=>{};
   win.Blob=Blob;win.URL.createObjectURL=()=>`blob:https://rig.local/${crypto.randomUUID()}`;win.URL.revokeObjectURL=()=>{};
   for(const dialog of win.document.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true};dialog.close=function(){this.open=false};}
   const requested=[];
   const fetcher=(url,init={})=>{requested.push(new URL(url).pathname);const headers=new Headers(init.headers);if((init.method||'GET').toUpperCase()==='POST')headers.set('origin','https://rig.local');return mf.dispatchFetch(url,{...init,headers});};
   const auth=createBrowserAuth({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_fixturekey12345',callbackUrl:'https://rig.local/auth/callback',browser:win,clientFactory:()=>({auth:{getSession:async()=>({data:{session:{access_token:token}}})}}),fetcher});
   const binding=await prepareBoundUi({auth,browser:win});win.rigRequest=binding.request;win.rigScopedStorage=binding.scopedStorage;win.rigOpenVideo=binding.openVideo;win.rigSessionActive=binding.isActive;
   let checkoutPromise;
   win.rigCheckout=url=>{const id=new URL(url).pathname.split('/').at(-1);checkoutPromise=(async()=>{
    const paid=await mockMollie.fetch(`https://api.mollie.com/v2/payments/${id}/mock-paid`,{method:'POST',headers:{authorization:'Bearer test_fixture'}});assert.equal(paid.status,200);
    const hook=()=>privateWorker.fetch('https://hooks.rig.local/api/payments/webhook',{method:'POST',headers:{'x-local-fixture':'mock-callback-only','content-type':'application/x-www-form-urlencoded'},body:`id=${id}`});
    assert.equal((await hook()).status,200);assert.equal((await hook()).status,200);
   })()};
   const media={image:{blob:new Blob([jpeg],{type:'image/jpeg'})},video:{blob:new Blob([video],{type:'video/mp4'})},face:null,angles:[],quality:'pro',keepSound:false,steady:false,prompt:'Maak een dansvideo met dezelfde beweging.'};
   win.rigPreparedMedia=()=>media;win.document.getElementById('duration').value='4';win.eval(payments);win.eval(generation);
   await waitFor(()=>win.document.getElementById('creditsButton').textContent.includes('0,00'));
   return {win,binding,requested,getCheckout:()=>checkoutPromise};
  }
  const a=await makeUi('a.b.c'),b=await makeUi('d.e.f');assert.notEqual(a.binding.userId,b.binding.userId);
  async function buy(ui){const d=ui.win.document;d.getElementById('creditsButton').click();await waitFor(()=>d.getElementById('packageList').children.length===1&&!d.getElementById('packageList').children[0].disabled);d.getElementById('packageList').children[0].click();await waitFor(()=>!!ui.getCheckout());await ui.getCheckout();d.getElementById('refreshPayment').click();await waitFor(()=>d.getElementById('creditsButton').textContent.includes('5,00'));}
  await buy(a);assert.equal((await (await b.binding.request('/api/payments/balance')).json()).balance,0);await buy(b);
  async function createVideo(ui){const d=ui.win.document;d.dispatchEvent(new ui.win.Event('rig-prepared-ready'));await waitFor(()=>d.getElementById('uploadDialog').open);d.getElementById('confirmUpload').click();await waitFor(()=>!d.getElementById('confirmGeneration').hidden);assert.match(d.getElementById('quoteMessage').textContent,/1,00/);d.getElementById('confirmGeneration').click();await waitFor(()=>d.getElementById('quoteMessage').textContent==='Je video is klaar.');assert.match(d.getElementById('resultVideo').src,/^blob:https:\/\/rig\.local\//);}
  await createVideo(a);await createVideo(b);
  assert.equal((await (await a.binding.request('/api/payments/balance')).json()).balance,400);assert.equal((await (await b.binding.request('/api/payments/balance')).json()).balance,400);
  const path=a.requested.find(x=>/^\/api\/generations\/[^/]+\/video$/.test(x));assert.ok(path);assert.equal((await b.binding.request(path)).status,404);
  const recover=await a.binding.request('/api/generation-intents/missing-fixture-request/reconcile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({quoteId:'fixture-quote'})});assert.equal(recover.status,200);assert.equal((await recover.json()).state,'canceled');
  const estimate=await a.binding.request('/api/estimate/fal?quality=pro&duration=4');assert.equal(estimate.status,200);assert.equal((await estimate.json()).providerEstimate.usdMicros,672000);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM rig_ledger WHERE event_id LIKE 'credit:%'").first()).n,2);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM rig_fixture_fal_dispatch').first()).n,2);
  a.binding.dispose();b.binding.dispose();
 }finally{for(const dom of windows)dom.window.close();if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true})}
});
