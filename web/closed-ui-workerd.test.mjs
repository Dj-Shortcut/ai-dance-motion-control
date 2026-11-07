import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createBrowserAuth} from './browser-auth.mjs';
import {prepareBoundUi} from './frontend/multiuser/ui-auth.mjs';

const require=createRequire('/Users/Mac/Documents/Codex/2026-08-01/sites-plugin-sites-openai-bundled-maak-3/package.json');const {Miniflare}=require('miniflare');
async function migrate(db,file){const sql=(await readFile(new URL(file,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'');for(const s of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(s).run();}
const waitFor=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('Local UI did not settle');};
function worker(dir){return new Miniflare({workers:[
 {name:'private',modules:true,scriptPath:join(dir,'entry.mjs'),compatibilityDate:'2026-01-01',bindings:{LOCAL_FIXTURE:'yes'},d1Databases:{DB:'closed-ui-fixture'},serviceBindings:{MOCK_AUTH:'mock-auth',MOCK_MOLLIE:'mock-mollie'}},
 {name:'mock-auth',modules:true,scriptPath:join(dir,'mock-auth.mjs'),compatibilityDate:'2026-01-01'},
 {name:'mock-mollie',modules:true,scriptPath:join(dir,'mock-mollie.mjs'),compatibilityDate:'2026-01-01'}]});}

test('copied RIG payment UI and two simulated sessions use the same closed-service local D1',async()=>{
 const dir=await mkdtemp(join(process.cwd(),'.rig-closed-ui-'));let mf;
 try{
  for(const [input,output] of [['closed-test-fixture-entry.mjs','entry.mjs'],['local-mock-auth.mjs','mock-auth.mjs'],['local-mock-mollie.mjs','mock-mollie.mjs']])await build({entryPoints:[input],outfile:join(dir,output),bundle:true,format:'esm',platform:'browser',logLevel:'silent'});
  mf=worker(dir);const db=await mf.getD1Database('DB');for(const f of ['./public-identity-schema.sql','./cloudflare-migrations/0001_test_baseline.sql','./closed-test-tenant.sql'])await migrate(db,f);
  await db.prepare('INSERT INTO rig_closed_test_tenant VALUES(1,?,?,?,?,?,?)').bind('closed-fixture','test','https://rig.local','https://abcdefghijklmnopqrst.supabase.co','pfl_TESTPROFILE','https://hooks.rig.local/api/payments/webhook').run();
  const html=await readFile('frontend/multiuser/index.html','utf8'),payments=await readFile('frontend/multiuser/payments.js','utf8');
  async function screen(token){
   const dom=new JSDOM(html,{url:'https://rig.local/multiuser/',runScripts:'outside-only'}),win=dom.window;
   win.HTMLMediaElement.prototype.pause=()=>{};
   for(const dialog of win.document.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true};dialog.close=function(){this.open=false};}
   let signedIn=true,checkout=null;
   const fakeFactory=()=>({auth:{getSession:async()=>({data:{session:signedIn?{access_token:token}:null}}),signOut:async()=>{signedIn=false;return {}}}});
   const fetcher=(url,init)=>{const h=new Headers(init.headers);if((init.method||'GET').toUpperCase()==='POST')h.set('origin','https://rig.local');return mf.dispatchFetch(url,{...init,headers:h});};
   const auth=createBrowserAuth({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_fixturekey12345',callbackUrl:'https://rig.local/auth/callback',browser:win,clientFactory:fakeFactory,fetcher});
   const binding=await prepareBoundUi({auth,browser:win});win.rigRequest=binding.request;win.rigScopedStorage=binding.scopedStorage;win.rigCheckout=url=>{checkout=url;};win.eval(payments);
   await waitFor(()=>win.document.getElementById('creditsButton').textContent.includes('0,00'));
   return {dom,win,auth,binding,checkout:()=>checkout};
  }
  const a=await screen('a.b.c'),b=await screen('d.e.f');assert.notEqual(a.binding.userId,b.binding.userId);
  const doc=a.win.document;doc.getElementById('creditsButton').click();
  await waitFor(()=>doc.getElementById('packageList').children.length===1&&!doc.getElementById('packageList').children[0].disabled);
  doc.getElementById('packageList').children[0].click();await waitFor(()=>a.checkout()!==null);
  const order=await db.prepare('SELECT payment_id FROM rig_orders WHERE user_id=?').bind(a.binding.userId).first();
  const mockMollie=await mf.getWorker('mock-mollie'),privateWorker=await mf.getWorker('private');
  await mockMollie.fetch(`https://api.mollie.com/v2/payments/${order.payment_id}/mock-paid`,{method:'POST',headers:{authorization:'Bearer test_fixture'}});
  const hook=()=>privateWorker.fetch('https://hooks.rig.local/api/payments/webhook',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:`id=${order.payment_id}`});
  assert.equal((await hook()).status,200);assert.equal((await hook()).status,200);
  doc.getElementById('refreshPayment').click();await waitFor(()=>doc.getElementById('creditsButton').textContent.includes('5,00'));
  assert.equal((await (await b.binding.request('/api/payments/balance')).json()).balance,0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM rig_ledger WHERE event_id LIKE 'credit:%'").first()).n,1);
  assert.equal((await a.binding.request('/api/generations/recent')).status,404);
  await a.auth.signOut();await assert.rejects(a.binding.request('/api/payments/balance'),/opnieuw/);
  a.binding.dispose();b.binding.dispose();a.dom.window.close();b.dom.window.close();
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
