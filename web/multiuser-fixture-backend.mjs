import {preAuthLimit} from './preauth-limit.mjs';

// Deliberately isolated mock; no network, provider SDKs, real payments, media
// persistence or Worker entrypoint. Never use for actual customer funds.
export function createLocalMultiuserFixture({authenticate}){
 if(typeof authenticate!=='function')throw Error('Verifier required');
 const accounts=new Map(),assets=new Map(),quotes=new Map(),jobs=new Map();
 const account=id=>{if(!accounts.has(id))accounts.set(id,{balance:0,orders:new Map(),intents:new Map()});return accounts.get(id)};
 const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
 return async function(request,env){
  if(env?.RIG_PUBLIC_AUTH_EXPERIMENT!=='local-fixture-only'||env?.RIG_MODE!=='test'||env?.RIG_MOLLIE_MODE!=='test'
   ||env?.RIG_PUBLIC_ORIGIN!=='https://rig.local'||env?.FAL_KEY||env?.MOLLIE_API_KEY||env?.RIG_MEDIA||env?.BUCKET||env?.RIG_STAGING_OWNER)return json({error:'Uitgeschakeld.'},503);
  const url=new URL(request.url),path=url.pathname;
  if(url.origin!=='https://rig.local'||!['GET','POST'].includes(request.method))return json({error:'Niet gevonden.'},404);
  if(request.method==='POST' && request.headers.get('origin')!=='https://rig.local')return json({error:'Ongeldige oorsprong.'},403);
  if(!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(request.headers.get('authorization')||''))return json({error:'Aanmelden vereist.'},401);
  try{if(!await preAuthLimit(env.DB,Date.now(),1000))return json({error:'Te veel aanvragen.'},429);}catch{return json({error:'Tijdelijk niet beschikbaar.'},503);}
  let user;try{user=await authenticate(request,env);}catch{return json({error:'Tijdelijk niet beschikbaar.'},503);}
  if(!user)return json({error:'Aanmelden vereist.'},401);
  const acc=account(user),id=()=>crypto.randomUUID(),read=async()=>{try{return await request.json()}catch{return {}}};
  if(path==='/api/session'&&request.method==='GET')return json({userId:user});
  if(path==='/api/payments/balance'&&request.method==='GET')return json({balance:acc.balance});
  if(path==='/api/payments/packages'&&request.method==='GET')return json({packages:[{id:'fixture5',amountCents:500,credits:500}]});
  if(path==='/api/payments/orders'&&request.method==='GET')return json({orders:[]});
  if(path==='/api/payments/create'&&request.method==='POST'){
   const data=await read();if(data.packageId!=='fixture5'||!/^[A-Za-z0-9_-]{12,80}$/.test(data.requestId||''))return json({error:'Ongeldige proef.'},400);
   if(!acc.orders.has(data.requestId))acc.orders.set(data.requestId,{state:'open'});
   return json({checkoutUrl:'https://checkout.mollie.com/fixture-only'});
  }
  const order=path.match(/^\/api\/payments\/orders\/([A-Za-z0-9_-]{12,80})\/reconcile$/);
  if(order&&request.method==='POST'){
   const data=acc.orders.get(order[1]);if(!data)return json({error:'Niet gevonden.'},404);
   if(data.state!=='paid'){data.state='paid';acc.balance+=500;}return json({state:'paid'});
  }
  if(path==='/api/generations/recent'&&request.method==='GET')return json({job:null});
  if(path==='/api/assets'&&request.method==='POST'){
   const kind=request.headers.get('x-rig-asset-kind');if(!['image','video','face','angle'].includes(kind))return json({error:'Ongeldig bestand.'},400);
   const asset=id();assets.set(asset,{user,kind});return json({id:asset,kind,status:'ready'});
  }
  if(path==='/api/generation-quotes'&&request.method==='POST'){
   const data=await read();if(!['imageId','videoId'].every(k=>assets.get(data[k])?.user===user))return json({error:'Niet gevonden.'},404);
   const quote=id();quotes.set(quote,{user});return json({id:quote,priceCents:100,currency:'EUR',durationSeconds:3,billedSeconds:3,providerEstimateUsdMicros:300000});
  }
  if(path==='/api/generations'&&request.method==='POST'){
   const data=await read();if(!/^[A-Za-z0-9_-]{1,100}$/.test(data.idempotencyKey||''))return json({error:'Ongeldige proef.'},400);
   const previous=acc.intents.get(data.idempotencyKey);if(previous)return previous.quoteId===data.quoteId?json({id:previous.job,state:'queued'}):json({error:'Ongeldige proef.'},409);
   const quote=quotes.get(data.quoteId);if(!quote||quote.user!==user)return json({error:'Niet gevonden.'},404);
   if(acc.balance<100)return json({error:'Onvoldoende fictief tegoed.'},402);
   acc.balance-=100;quotes.delete(data.quoteId);const job=id();jobs.set(job,{user});acc.intents.set(data.idempotencyKey,{quoteId:data.quoteId,job});return json({id:job,state:'queued'});
  }
  const job=path.match(/^\/api\/generations\/([A-Za-z0-9_-]+)(\/video)?$/);
  if(job&&request.method==='GET'){
   if(jobs.get(job[1])?.user!==user)return json({error:'Niet gevonden.'},404);
   return job[2]?new Response(new Uint8Array([0,0,0,1]),{headers:{'content-type':'video/mp4','cache-control':'no-store'}}):json({id:job[1],state:'completed',videoPath:`/api/generations/${job[1]}/video`});
  }
  return json({error:'Niet gevonden.'},404);
 };
}
