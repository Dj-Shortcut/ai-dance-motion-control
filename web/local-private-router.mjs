import {preAuthLimit} from './preauth-limit.mjs';
import {createSupabaseIdentity} from './supabase-identity.mjs';
import {createGenerationHandler} from './generation.mjs';
import {createD1GenerationStores} from './d1.mjs';
import {inspectMp4} from './mp4-inspect.mjs';

const issuer='https://abcdefghijklmnopqrst.supabase.co',key='sb_publishable_fixturekey12345',fakeKey='local-fake-not-a-key';
const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const unavailable=()=>json({error:'Proefomgeving niet beschikbaar.'},503);
const hex=bytes=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
async function bounded(req,max=1024*1024){if(!req.body)throw Error('empty');const r=req.body.getReader(),parts=[];let size=0;try{for(;;){const {value,done}=await r.read();if(done)break;size+=value.byteLength;if(size>max)throw Error('size');parts.push(value);}const all=new Uint8Array(size);let at=0;for(const part of parts){all.set(part,at);at+=part.byteLength}if(!size)throw Error('empty');return all;}catch(e){void r.cancel().catch(()=>{});throw e;}}
async function mockedFetch(env,url,init={}){
 const u=new URL(url);if(!['https://queue.fal.run','https://v3b.fal.media'].includes(u.origin))throw Error('Non-mock URL');
 const h=new Headers(init.headers);h.set('authorization',`Key ${fakeKey}`);
 const response=await env.MOCK_FAL.fetch(new Request(url,{...init,headers:h,redirect:'manual'}));if(response.status>=300&&response.status<400)throw Error('redirect');return response;
}
function media(env){
 async function getOwned(user,id){
  const row=await env.DB.prepare('SELECT * FROM rig_fixture_assets WHERE id=? AND user_id=?').bind(id,user).first();if(!row)return null;
  const obj=await env.BUCKET.get(row.r2key);if(!obj)return null;const data=await obj.arrayBuffer();
  if(hex(await crypto.subtle.digest('SHA-256',data))!==row.sha256)return null;
  return {id:row.id,kind:row.kind,verified:true,sha256:row.sha256,...(row.kind==='video'?{durationVerified:true,durationSeconds:row.duration}:{})};
 }
 return {getOwned,async uploadOwned(user,id,hash){const asset=await getOwned(user,id);if(!asset||asset.sha256!==hash)throw Error('asset');return {...asset,url:`https://v3b.fal.media/files/b/mock/${id}.mp4`};}};
}
function results(env){return {
 async store(job,url){if(url!=='https://v3b.fal.media/files/b/mock/output.mp4')throw Error('url');const response=await mockedFetch(env,url);if(!response.ok)throw Error('mock result');const bytes=await bounded(response);inspectMp4(bytes);const key=`rig-results/${job.id}.mp4`;await env.BUCKET.put(key,bytes);return key;},
 async read(job){const obj=await env.BUCKET.get(job.resultKey);if(!obj)throw Error('result');return new Response(obj.body,{headers:{'content-type':'video/mp4','cache-control':'private, no-store'}});}
};}
export default {async fetch(req,env){
 if(env.LOCAL_FIXTURE!=='yes'||env.RIG_PUBLIC_ORIGIN!=='https://rig.local'||!env.DB||!env.BUCKET||typeof env.MOCK_AUTH?.fetch!=='function'||typeof env.MOCK_FAL?.fetch!=='function'||env.FAL_KEY||env.MOLLIE_API_KEY||env.RIG_STAGING_OWNER)return unavailable();
 const u=new URL(req.url),path=u.pathname;if(u.origin!=='https://rig.local'||!['GET','POST'].includes(req.method))return new Response(null,{status:404});
 if(req.method==='POST'&&req.headers.get('origin')!=='https://rig.local')return json({error:'Ongeldige oorsprong.'},403);
 if(!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(req.headers.get('authorization')||''))return json({error:'Aanmelden vereist.'},401);
 try{if(!await preAuthLimit(env.DB,Date.now(),1000))return json({error:'Te veel aanvragen.'},429);}catch{return unavailable();}
 let user;try{const authenticate=createSupabaseIdentity({projectUrl:issuer,publishableKey:key,fetcher:async(input,init)=>{const response=await env.MOCK_AUTH.fetch(new Request(input,{...init,redirect:'manual'}));if(response.status>=300&&response.status<400)throw Error('redirect');return response;}});user=await authenticate(req,env);}catch{return unavailable();}
 if(!user)return json({error:'Aanmelden vereist.'},401);
 if(path==='/api/session'&&req.method==='GET')return json({userId:user});
 if(path==='/api/payments/balance'&&req.method==='GET'){
  try{const row=await env.DB.prepare('SELECT COALESCE(SUM(delta),0) AS balance FROM rig_ledger WHERE user_id=?').bind(user).first();if(!row||!Number.isSafeInteger(row.balance)||row.balance<0)throw Error();return json({balance:row.balance});}catch{return unavailable();}
 }
 if(path==='/api/assets'&&req.method==='POST'){
  try{
   const kind=req.headers.get('x-rig-asset-kind');if(!['image','video'].includes(kind))return json({error:'Alleen proefbestanden.'},400);
   const bytes=await bounded(req);let duration=null;
   if(kind==='video'){const meta=inspectMp4(bytes);duration=meta.durationSeconds;if(duration<3||duration>20)throw Error('duration');}
   else if(bytes.length<3||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)throw Error('jpeg');
   const id=crypto.randomUUID(),hash=hex(await crypto.subtle.digest('SHA-256',bytes)),r2key=`rig-fixture-inputs/${user}/${id}`;
   const stored=await env.BUCKET.put(r2key,bytes,{onlyIf:{etagDoesNotMatch:'*'}});if(!stored)throw Error('storage');
   await env.DB.prepare('INSERT INTO rig_fixture_assets(id,user_id,kind,r2key,sha256,duration) VALUES(?,?,?,?,?,?)').bind(id,user,kind,r2key,hash,duration).run();
   return json({id,kind,status:'ready'},201);
  }catch{return json({error:'Proefbestand kon niet worden verwerkt.'},400);}
 }
 const stores=createD1GenerationStores(env.DB,{mode:'test'});
 const handler=createGenerationHandler({...stores,assets:media(env),results:results(env),mode:'test',trustedOrigin:'https://rig.local',authenticate:async()=>({id:user}),falKey:fakeKey,pricing:{standard:25,pro:25,version:'fixture-only'}},(url,init)=>mockedFetch(env,url,init));
 return handler(req);
}};
