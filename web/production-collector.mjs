// Bounded scheduled reconciliation. Never creates a payment or a Fal request.
// Ownership comes from the production DB, never an external scheduling argument.
import {createProductionGenerationContext} from './production-generation-context.mjs';
import {createProductionVideoService} from './production-video-service.mjs';
import {createProductionPayment} from './production-payment.mjs';
import {collectInvoiceDocuments} from './invoice-delivery.mjs';
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function statusJSON(response){
 const reader=response.body?.getReader();if(!reader)throw Error('Missing status');
 const parts=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192)throw Error('Large status');parts.push(value)}const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}finally{void reader.cancel().catch(()=>{})}
}
export async function collectProduction(env,{network=fetch,videoFactory=createProductionVideoService,clock=Date.now,limit=4}={}){
 const stats={videosChecked:0,paymentsChecked:0,needsReview:0,unavailable:0};
 if(env.RIG_AUTOMATIC_INVOICES_ENABLED==='yes')stats.invoices=await collectInvoiceDocuments(env,{now:clock(),limit});
 if(env.RIG_PRODUCTION_COLLECTION_ENABLED!=='yes')return stats;
 if(!Number.isInteger(limit)||limit<1||limit>4)throw Error('Invalid collection limit');
 const context=await createProductionGenerationContext(env);if(!context)return stats;
 const mapped=context.env,now=clock();if(!Number.isSafeInteger(now)||now<1)throw Error('Invalid collection time');
 const jobs=await mapped.DB.prepare("SELECT j.id,j.user_id FROM rig_generation_jobs j LEFT JOIN rig_collector_attempts a ON a.job_id=j.id WHERE j.state='queued' AND j.fal_request_id IS NOT NULL ORDER BY COALESCE(a.last_attempt_at,0),j.created_at,j.id LIMIT ?").bind(limit).all();
 for(const job of jobs.results??[]){
  if(!ID.test(job.id||'')||!USER.test(job.user_id||'')){stats.needsReview++;continue}
  let response;
  try{
   const recorded=await mapped.DB.prepare("INSERT INTO rig_collector_attempts(job_id,last_attempt_at) SELECT id,? FROM rig_generation_jobs WHERE id=? AND user_id=? AND state='queued' ON CONFLICT(job_id) DO UPDATE SET last_attempt_at=MAX(last_attempt_at,excluded.last_attempt_at)").bind(now,job.id,job.user_id).run();
   if(recorded.meta?.changes!==1)continue;
   const handler=await videoFactory(env,{trustedUserId:job.user_id,productionContext:context,providerFetch:network,gatewayFetch:network});
   response=await handler(new Request(mapped.RIG_PUBLIC_ORIGIN+'/api/generations/'+job.id));
   if(!response?.ok)throw Error('Collection unavailable');
   const status=await statusJSON(response);
   if(status?.id!==job.id||!['queued','processing','completed','failed','unknown','needs_review'].includes(status.state))throw Error('Invalid owned status');
   stats.videosChecked++;
   if(['failed','unknown','needs_review'].includes(status.state))stats.needsReview++;
  }catch{stats.unavailable++}finally{try{await response?.body?.cancel()}catch{}}
 }
 const payment=createProductionPayment({transport:network});
 const orders=await mapped.DB.prepare("SELECT o.id,o.user_id,o.request_id FROM rig_orders o LEFT JOIN rig_payment_reconciliation_attempts a ON a.order_id=o.id WHERE o.payment_id IS NOT NULL AND o.state IN ('open','unknown','creating','paid','credit_pending_review') AND COALESCE(a.last_attempt_at,0)<? ORDER BY COALESCE(a.last_attempt_at,0),o.created_at,o.id LIMIT ?").bind(now-300000,limit).all();
 for(const order of orders.results??[]){
  if(!ID.test(order.id||'')||!USER.test(order.user_id||'')||!/^[A-Za-z0-9_-]{12,80}$/.test(order.request_id||'')){stats.needsReview++;continue}
  let response;
  try{
   await mapped.DB.prepare('INSERT INTO rig_payment_reconciliation_attempts(order_id,last_attempt_at) VALUES(?,?) ON CONFLICT(order_id) DO UPDATE SET last_attempt_at=MAX(last_attempt_at,excluded.last_attempt_at)').bind(order.id,now).run();
   response=await payment.user(new Request(mapped.RIG_PUBLIC_ORIGIN+'/api/payments/orders/'+order.request_id+'/reconcile',{method:'POST',headers:{origin:mapped.RIG_PUBLIC_ORIGIN,'content-type':'application/json'},body:'{}'}),env,order.user_id);
   if(!response?.ok)throw Error('Payment check unavailable');
   stats.paymentsChecked++;
  }catch{stats.unavailable++}finally{try{await response?.body?.cancel()}catch{}}
 }
 return stats;
}
