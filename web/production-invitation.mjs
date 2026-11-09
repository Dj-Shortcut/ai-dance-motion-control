// One previously authorized promotional gift. Provisioning must first revoke
// the unclaimed TEST invitation; this module never reads or copies TEST funds.
import {isProductionGenerationContext} from './production-generation-context.mjs';
import {validateProductionTenant} from './production-tenant.mjs';
import {d1Limit} from './router.mjs';

const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE=/^[A-Za-z0-9_-]{43}$/;
const EVENT='promo:rig-first-tester-v1';
const SOURCE='rig-public-test-v1';
const reply=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const unavailable=()=>reply({state:'unavailable'});
const invalidConfig=()=>reply({error:'Gratis tegoed is tijdelijk niet beschikbaar.'},503);
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');

async function readCode(req){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return null;
 const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>256))return null;
 const reader=req.body?.getReader();if(!reader)return null;let size=0,timer;const chunks=[];
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Read timeout')),5000)});
 try{
  for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;if(!(value instanceof Uint8Array))return null;size+=value.length;if(size>256)return null;chunks.push(value)}
  const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length}
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  return data&&typeof data==='object'&&!Array.isArray(data)&&Object.keys(data).length===1&&typeof data.code==='string'&&CODE.test(data.code)?data.code:null;
 }catch{return null}finally{clearTimeout(timer);try{void reader.cancel().catch(()=>{})}catch{}}
}

// SQL reused by claim, credit proof and status. The source receipt is a narrow
// operator assertion backed by the separately audited old-DB revocation.
const receipt=`p.amount_cents=500 AND p.source_environment_id='${SOURCE}'
 AND p.source_invitation_id=1 AND p.source_invalidated_at>0
 AND p.source_invalidated_at<=p.created_at`;

export async function handleProductionInvitation(req,rawEnv,{userId,productionContext,clock=Date.now}={}){
 try{
  if(rawEnv?.RIG_PRODUCTION_PROMOTIONAL_INVITATION_ENABLED!=='yes'||!USER.test(rawEnv.RIG_PRODUCTION_OWNER_USER_ID||'')||!isProductionGenerationContext(productionContext,{db:rawEnv.PRODUCTION_DB,origin:rawEnv.RIG_PRODUCTION_SITE_ORIGIN})||typeof clock!=='function')return invalidConfig();
  if(typeof userId!=='string'||!USER.test(userId))return reply({error:'Meld je aan bij RIG.'},401);
  const env=await validateProductionTenant(rawEnv);if(!env||env.DB!==productionContext.env.DB)return invalidConfig();
  const u=new URL(req.url),status=u.pathname==='/api/sponsor-invitations/status',redeem=u.pathname==='/api/sponsor-invitations/redeem';
  if(u.origin!==env.RIG_PUBLIC_ORIGIN||u.search||u.hash||!status&&!redeem)return reply({error:'Niet gevonden.'},404);
  if(status&&req.method!=='GET'||redeem&&req.method!=='POST')return reply({error:'Methode niet toegestaan.'},405);
  if(redeem&&req.headers.get('origin')!==env.RIG_PUBLIC_ORIGIN)return reply({error:'Aanvraag geweigerd.'},403);
  const owner=rawEnv.RIG_PRODUCTION_OWNER_USER_ID;
  if(!(await env.DB.prepare('SELECT 1 AS found FROM rig_sites_identities WHERE site_id=? AND user_id=?').bind(rawEnv.RIG_PRODUCTION_SITE_ID,owner).first())?.found)return invalidConfig();
  if(await d1Limit({env,category:'generation',userId,method:req.method})!==true)return reply({error:'Te veel aanvragen.'},429);
  const now=clock();if(!Number.isSafeInteger(now)||now<1)return invalidConfig();
  if(status){
   if(userId===owner)return unavailable();
   const row=await env.DB.prepare(`SELECT
    COALESCE((SELECT SUM(delta) FROM rig_ledger WHERE user_id=p.redeemed_by),0) AS balance,
    500+COALESCE((SELECT SUM(l.delta) FROM rig_ledger l JOIN rig_generation_jobs j
      ON j.user_id=l.user_id AND j.created_at>=p.redeemed_at
      AND (l.event_id='reserve:'||j.id OR l.event_id='release:'||j.id)
      WHERE l.user_id=p.redeemed_by),0) AS gift_remaining
    FROM rig_production_invitation p JOIN rig_ledger g ON g.event_id=?
     AND g.user_id=p.redeemed_by AND g.delta=500 AND g.order_id IS NULL
    WHERE p.id=1 AND p.redeemed_by=? AND p.redeemed_at IS NOT NULL AND ${receipt}
     AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')
     AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=p.redeemed_by)`)
    .bind(EVENT,userId).first();
   if(!Number.isSafeInteger(row?.balance)||!Number.isSafeInteger(row?.gift_remaining))return unavailable();
   // Gift is consumed before later purchases. A confirmed generation refund
   // restores it; purchased funds never increase the free-credit indicator.
   return reply({state:'eligible',remainingCents:Math.max(0,Math.min(500,row.balance,row.gift_remaining))});
  }
  const code=await readCode(req);if(!code)return unavailable();
  if(userId===owner)return reply({state:'owner',currency:'EUR'});
  const digest=await hash(code),db=env.DB;
  const claim=db.prepare(`UPDATE rig_production_invitation AS p SET redeemed_by=?,redeemed_at=?
   WHERE p.id=1 AND p.code_hash=? AND p.redeemed_by IS NULL AND p.expires_at>?
    AND p.created_at<=? AND ${receipt}
    AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')
    AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=?)
    AND NOT EXISTS(SELECT 1 FROM rig_ledger WHERE event_id=?)`)
   .bind(userId,now,digest,now,now,userId,EVENT);
  const credit=db.prepare(`INSERT OR IGNORE INTO rig_ledger(event_id,user_id,order_id,delta)
   SELECT ?,p.redeemed_by,NULL,500 FROM rig_production_invitation p
   WHERE p.id=1 AND p.code_hash=? AND p.redeemed_by=? AND p.redeemed_at=?
    AND p.expires_at>? AND ${receipt}
    AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')
    AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=p.redeemed_by)`)
   .bind(EVENT,digest,userId,now,now);
  await db.batch([claim,credit]);
  const proof=await db.prepare(`SELECT 1 AS found FROM rig_production_invitation p
   JOIN rig_ledger g ON g.event_id=? AND g.user_id=p.redeemed_by AND g.delta=500 AND g.order_id IS NULL
   WHERE p.id=1 AND p.code_hash=? AND p.redeemed_by=? AND p.redeemed_at IS NOT NULL AND ${receipt}
    AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')
    AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=p.redeemed_by)`)
   .bind(EVENT,digest,userId).first();
  return proof?.found===1?reply({state:'redeemed',amountCents:500,currency:'EUR'}):unavailable();
 }catch{return invalidConfig()}
}
