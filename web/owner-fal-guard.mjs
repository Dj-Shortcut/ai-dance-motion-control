// One explicitly enabled owner-only test; never a public billing policy.
const ownerId=/^[A-Za-z0-9_-]{1,100}$/;
const smallInt=(v,max)=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v)&&Number.isSafeInteger(Number(v))&&Number(v)<=max;
const marker='rig-owner-fal-one-test-v1';
import {getFalPricePreflight} from './price-preflight.mjs';
export function falConfigured(env,user=env?.RIG_STAGING_OWNER){
 return env?.RIG_MODE==='test'&&env?.RIG_MOLLIE_MODE==='test'&&env?.RIG_OWNER_FAL_TEST_ENABLED==='yes'&&ownerId.test(user||'')&&user===env.RIG_STAGING_OWNER&&
  typeof env.FAL_KEY==='string'&&env.FAL_KEY.length>0&&env.FAL_KEY.length<1024&&typeof env.RIG_MEDIA_SECRET==='string'&&env.RIG_MEDIA_SECRET.length>=32&&typeof env.RIG_MEDIA?.fetch==='function'&&
  typeof env.BUCKET?.get==='function'&&typeof env.BUCKET?.put==='function'&&typeof env.BUCKET?.head==='function'&&typeof env.DB?.prepare==='function'&&
  smallInt(env.RIG_PRICE_STANDARD,250)&&smallInt(env.RIG_PRICE_PRO,250)&&smallInt(env.RIG_OWNER_FAL_MAX_PRICE_CENTS,1000)&&smallInt(env.RIG_OWNER_FAL_MAX_USD_MICROS,2000000)&&typeof env.RIG_PRICE_VERSION==='string'&&/^[A-Za-z0-9_.-]{1,40}$/.test(env.RIG_PRICE_VERSION);
}
export function createOwnerTrialGuard(env,owner,{priceFetch=getFalPricePreflight}={}){
 if(!falConfigured(env,owner))throw Error('Owner fal trial unavailable');
 const max=Number(env.RIG_OWNER_FAL_MAX_PRICE_CENTS);
 return {
  permits({durationSeconds,priceCents}){return Number.isFinite(durationSeconds)&&durationSeconds>=3&&durationSeconds<=10.1&&Number.isSafeInteger(priceCents)&&priceCents>0&&priceCents<=max;},
  async estimate(quality,durationSeconds){
   if(!['standard','pro'].includes(quality)||!Number.isFinite(durationSeconds)||durationSeconds<3||durationSeconds>10.1)throw Error('Invalid test estimate');
   const pricing=await priceFetch(env.FAL_KEY),rate=pricing?.prices?.[quality];
   if(pricing?.currency!=='USD'||pricing?.unit!=='second'||!Number.isFinite(rate)||rate<=0)throw Error('Provider estimate unavailable');
   const micros=Math.ceil(rate*1000000)*Math.ceil(durationSeconds);
   if(!Number.isSafeInteger(micros)||micros<=0||micros>Number(env.RIG_OWNER_FAL_MAX_USD_MICROS))throw Error('Provider estimate exceeds test limit');
   return micros;
  },
  async claimOnce(){
   // One durable attempt for this entire test. Never reuse the marker after
   // an ambiguous upload/submission or automatically retry a paid operation.
   const row=await env.DB.prepare('INSERT INTO rig_rate_limits(bucket,window_start,requests) VALUES(?,?,1) ON CONFLICT(bucket) DO NOTHING RETURNING bucket').bind(marker,Date.now()).first();
   return row?.bucket===marker;
  }
 };
}
