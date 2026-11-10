import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {JSDOM} from 'jsdom';
import {createSupabaseIdentity} from './supabase-identity.mjs';
import {createBrowserAuth} from './browser-auth.mjs';
import {prepareBoundUi} from './frontend/multiuser/ui-auth.mjs';
import {createLocalMultiuserFixture} from './multiuser-fixture-backend.mjs';

const projectUrl='https://abcdefghijklmnopqrst.supabase.co',publishableKey='sb_publishable_fixturekey12345';
const html=readFileSync(new URL('./frontend/multiuser/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('./frontend/multiuser/app.js',import.meta.url),'utf8');
const payments=readFileSync(new URL('./frontend/multiuser/payments.js',import.meta.url),'utf8');
const generation=readFileSync(new URL('./frontend/multiuser/generation-ui.js',import.meta.url),'utf8');
function fixtureDatabase(){const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('./public-identity-schema.sql',import.meta.url),'utf8'));
 return {sqlite,db:{prepare(sql){return {bind(...args){return {async first(){return sqlite.prepare(sql).get(...args);},async run(){return sqlite.prepare(sql).run(...args);}};}};}}};}
const shared=()=>{const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)}};
const waitFor=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('Fixture UI did not settle');};

test('a five-second trial uses the existing explicit payment and generation flow while isolating two customer balances',async()=>{
 const {sqlite,db}=fixtureDatabase(),subjects={'a.b.c':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','d.e.f':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
 const authenticate=createSupabaseIdentity({projectUrl,publishableKey,fetcher:async(_url,init)=>{
  const id=subjects[new Headers(init.headers).get('authorization')?.slice(7)];return id?Response.json({id}):Response.json({msg:'Invalid'}, {status:401});}});
 const backend=createLocalMultiuserFixture({authenticate});
 const env={DB:db,RIG_PUBLIC_AUTH_EXPERIMENT:'local-fixture-only',RIG_MODE:'test',RIG_MOLLIE_MODE:'test',RIG_PUBLIC_ORIGIN:'https://rig.local'};
 const storage=shared();
 async function ui(token,{interactive=false}={}){
  const dom=new JSDOM(html,{url:'https://rig.local/multiuser/',runScripts:'outside-only'}),win=dom.window;
  win.Blob=Blob;win.URL.createObjectURL=()=>`blob:https://rig.local/${crypto.randomUUID()}`;win.URL.revokeObjectURL=()=>{};
  for(const dialog of win.document.querySelectorAll('dialog')){dialog.showModal=function(){this.open=true};dialog.close=function(){this.open=false};}
  let active=true,currentToken=token;
  const browser={location:win.location,history:win.history,sessionStorage:storage,URL:win.URL};
  const clientFactory=()=>({auth:{getSession:async()=>({data:{session:active?{access_token:currentToken}:null}}),signOut:async()=>{active=false;return {};}}});
  const requested=[];
  const fetcher=(url,init)=>{requested.push(new URL(url).pathname);const headers=new Headers(init.headers);if((init.method||'GET').toUpperCase()==='POST')headers.set('origin','https://rig.local');return backend(new Request(url,{...init,headers}),env);};
  const auth=createBrowserAuth({projectUrl,publishableKey,callbackUrl:'https://rig.local/auth/callback',browser,clientFactory,fetcher});
  const binding=await prepareBoundUi({auth,browser});
  win.rigRequest=binding.request;win.rigScopedStorage=binding.scopedStorage;win.rigOpenVideo=binding.openVideo;win.rigSessionActive=binding.isActive;let checkoutVisited=false;win.rigCheckout=()=>{checkoutVisited=true;};
  const prepared=[];
  if(interactive){
   win.rigVideoEnabled=true;win.rigVideoQualities=['standard','pro'];win.requestAnimationFrame=()=>1;win.cancelAnimationFrame=()=>{};
   for(const video of win.document.querySelectorAll('video')){
    for(const [name,value] of Object.entries({duration:12,currentTime:0,paused:true,readyState:2,videoWidth:1280,videoHeight:720}))Object.defineProperty(video,name,{configurable:true,writable:true,value});
    video.pause=()=>{video.paused=true};video.play=async()=>{video.paused=false};
   }
   win.Image=class{constructor(){this.naturalWidth=1280;this.naturalHeight=720}set src(_value){this.onload()}};
   win.rigMedia={bounds:crop=>crop,dimensions:()=>({width:1280,height:720}),paint(){},prepareImage:async()=>({blob:new Blob(['photo'],{type:'image/jpeg'})}),prepareVideo:async(_video,crop,start,duration)=>{prepared.push({crop:{...crop},start,duration});return {blob:new Blob(['video'],{type:'video/mp4'}),duration};}};
   win.eval(app);
  }else{
   const media={image:{blob:new Blob(['photo'],{type:'image/jpeg'})},video:{blob:new Blob(['video'],{type:'video/mp4'})},face:null,angles:[],quality:'pro',keepSound:true,steady:false,prompt:'Maak een dansvideo met dezelfde beweging.'};
   win.rigPreparedMedia=()=>media;
  }
  win.eval(payments);win.eval(generation);
  await waitFor(()=>win.document.getElementById('creditsButton').textContent.includes('0,00'));
  return {dom,win,binding,auth,requested,prepared,checkoutVisited:()=>checkoutVisited,setToken:value=>{currentToken=value;}};
 }
 const alice=await ui('a.b.c',{interactive:true}),bob=await ui('d.e.f');assert.notEqual(alice.binding.userId,bob.binding.userId);
 alice.binding.scopedStorage.setItem('rig-generation-job','alice-pending');assert.equal(bob.binding.scopedStorage.getItem('rig-generation-job'),null);alice.binding.scopedStorage.removeItem('rig-generation-job');
 const d=alice.win.document;d.getElementById('creditsButton').click();
 await waitFor(()=>d.getElementById('packageList').children.length===1&&!d.getElementById('packageList').children[0].disabled);
 d.getElementById('packageList').children[0].click();await waitFor(()=>alice.checkoutVisited());
 d.getElementById('refreshPayment').click();await waitFor(()=>d.getElementById('creditsButton').textContent.includes('5,00'));
 assert.equal((await (await bob.binding.request('/api/payments/balance')).json()).balance,0);
 for(const [id,name,type] of [['personInput','person.jpg','image/jpeg'],['motionInput','motion.mp4','video/mp4']]){
  Object.defineProperty(d.getElementById(id),'files',{configurable:true,value:[new alice.win.File(['file'],name,{type})]});d.getElementById(id).dispatchEvent(new alice.win.Event('change',{bubbles:true}));
 }
 d.getElementById('motionVideo').dispatchEvent(new alice.win.Event('loadedmetadata'));
 d.getElementById('duration').value='8';d.getElementById('duration').dispatchEvent(new alice.win.Event('change'));
 d.getElementById('start').value='2.3';d.getElementById('start').dispatchEvent(new alice.win.Event('change'));
 d.getElementById('motionCropButton').click();d.getElementById('cropX').value='10';d.getElementById('cropW').value='80';d.getElementById('applyCrop').click();
 d.getElementById('prepare').click();assert.equal(d.getElementById('briefDialog').open,true);d.getElementById('tryShortVideo').click();await waitFor(()=>d.getElementById('uploadDialog').open);
 assert.equal(d.getElementById('duration').value,'8');assert.deepEqual(alice.prepared,[{crop:{x:10,y:0,w:80,h:100},start:2.3,duration:5}]);assert.equal(alice.requested.includes('/api/generations'),false);
 d.getElementById('confirmUpload').click();await waitFor(()=>!d.getElementById('confirmGeneration').hidden);
 assert.match(d.getElementById('quoteMessage').textContent,/1,00/);assert.equal(alice.requested.includes('/api/generations'),false);assert.equal((await (await alice.binding.request('/api/payments/balance')).json()).balance,500);
 d.getElementById('confirmGeneration').click();await waitFor(()=>d.getElementById('quoteMessage').textContent.includes('Je proefje is klaar.'));
 assert.match(d.getElementById('resultVideo').src,/^blob:https:\/\/rig\.local\//);
 assert.equal((await (await alice.binding.request('/api/payments/balance')).json()).balance,400);
 assert.equal((await (await bob.binding.request('/api/payments/balance')).json()).balance,0);
 // Bob cannot read Alice's real fixture result, even with the job id.
 const videoPath=alice.requested.find(path=>/^\/api\/generations\/[^/]+\/video$/.test(path));
 assert.ok(videoPath);assert.equal((await bob.binding.request(videoPath)).status,404);
 alice.setToken('d.e.f');await assert.rejects(alice.binding.request('/api/payments/balance'),/gewijzigd/);alice.setToken('a.b.c');
 await alice.auth.signOut();await assert.rejects(alice.binding.request('/api/payments/balance'),/opnieuw/);
 assert.equal((await bob.binding.request('/api/payments/balance')).status,200);
 alice.binding.dispose();bob.binding.dispose();alice.dom.window.close();bob.dom.window.close();sqlite.close();
});
