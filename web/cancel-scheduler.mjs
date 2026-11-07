// Internal TEST-ONLY cancellation processor. It provides no network listener or
// publicly accessible endpoint. The private Worker's scheduled event invokes it
// directly when explicitly configured; never use client-provided identifiers.
import {processCancel} from './cancellation.mjs';
const PAYMENT_ID=/^tr_[A-Za-z0-9]{6,80}$/;
const TEST_KEY=/^test_[A-Za-z0-9]+$/;
const API='https://api.mollie.com/v2/payments/';
const MAX_RESPONSE_BYTES=65536;

async function readBoundedJson(response){
 const declared=response.headers.get('content-length');if(declared&&(!/^\d+$/.test(declared)||Number(declared)>MAX_RESPONSE_BYTES))throw Error('Invalid provider response');
 const mime=(response.headers.get('content-type')||'').split(';',1)[0].trim().toLowerCase();
 if(mime!=='application/json'&&mime!=='application/hal+json')throw Error('Invalid provider response');
 const reader=response.body?.getReader();if(!reader)throw Error('Invalid provider response');
 const chunks=[];let size=0;try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_RESPONSE_BYTES){await reader.cancel();throw Error('Invalid provider response')}chunks.push(value)}}finally{reader.releaseLock()}
 const bytes=new Uint8Array(size);let i=0;for(const c of chunks){bytes.set(c,i);i+=c.byteLength}return JSON.parse(new TextDecoder().decode(bytes));
}

// Binds a test key to a fixed Mollie v2 origin. Redirects are forbidden; the
// signal is supplied by processCancel, which aborts each request on timeout.
export function createMollieTestClient({apiKey,fetchImpl=fetch}){
 if(!TEST_KEY.test(apiKey||'')||typeof fetchImpl!=='function')throw Error('Mollie test configuration required');
 async function request(id,method,{signal}={}){
  if(!PAYMENT_ID.test(id||'')||!signal)throw Error('Invalid provider request');
  const response=await fetchImpl(API+encodeURIComponent(id),{method,redirect:'manual',signal,headers:{Authorization:`Bearer ${apiKey}`,Accept:'application/json'}});
  if(!response.ok)throw Error('Mollie request failed');
  return method==='GET'?await readBoundedJson(response):undefined;
 }
 return {fetchPayment:(id,opts)=>request(id,'GET',opts),cancelPayment:(id,opts)=>request(id,'DELETE',opts)};
}

// Serial, bounded work avoids fanning out expensive provider calls. Every item
// is separately claimed/fenced by processCancel. If an invocation dies, another
// can reclaim only after lease expiry, respecting delete_attempted. Review items
// are intentionally not retried: they need a separate audited operator process.
export async function runCancellationBatch({env,fetchImpl=fetch,clock=Date.now,maxItems=3,budgetMs=45000,timeoutMs=4000}={}){
 if(env?.RIG_MODE!=='test'||env?.RIG_MOLLIE_MODE!=='test'||env?.RIG_MOLLIE_TEST_SCHEDULER_ENABLED!=='yes'||!env?.DB||!TEST_KEY.test(env.MOLLIE_API_KEY||''))throw Error('Isolated test scheduler not configured');
 if(!Number.isInteger(maxItems)||maxItems<1||maxItems>5||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>10000||!Number.isInteger(budgetMs)||budgetMs<3*timeoutMs+1000||budgetMs>55000||typeof clock!=='function')throw Error('Invalid batch limits');
 const mode=await env.DB.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first();if(mode?.mode!=='test')throw Error('Test database required');
 const client=createMollieTestClient({apiKey:env.MOLLIE_API_KEY,fetchImpl});const begin=clock();
 const result=await env.DB.prepare("SELECT order_id FROM rig_cancel_requests WHERE state='queued' OR (state='processing' AND lease_until <= ?) ORDER BY updated_at ASC, order_id ASC LIMIT ?").bind(begin,maxItems).all();
 if(!Array.isArray(result?.results))throw Error('Queue unavailable');
 const counts={examined:0,done:0,review:0,notClaimed:0,lostLease:0};
 for(const item of result.results){
   if(clock()-begin+3*timeoutMs+1000>budgetMs)break;
   if(typeof item.order_id!=='string'||!/^[A-Za-z0-9_-]{12,80}$/.test(item.order_id))throw Error('Invalid queue entry');
   const value=await processCancel({db:env.DB,orderId:item.order_id,mode:'test',...client,clock,timeoutMs});
   counts.examined++;if(value.state==='done')counts.done++;else if(value.state==='review')counts.review++;else if(value.state==='not_claimed')counts.notClaimed++;else if(value.state==='lost_lease')counts.lostLease++;else throw Error('Unknown queue result');
 }
 return counts;
}
