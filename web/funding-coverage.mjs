// Server-only sale admission. No recharge, payment, generation or credential
// management is performed here. The caller owns authentication/owner routing.
import {loadProfitPolicy} from './profit-policy.mjs';
const BILLING='https://api.fal.ai/v1/account/billing?expand=credits';
const MAX_USD=1000000000000000,MAX_CENTS=100000000000,MAX_BUFFER=1000000000000;
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION=/^[A-Za-z0-9_.-]{1,64}$/,USERNAME=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const whole=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
const caches=new WeakMap();
const failureDiagnostics=new WeakMap();
const failureStages=new Set(['network','deadline','http_status','content_type','content_encoding','body_size','content_length_invalid','content_length_mismatch','json','schema','account_mismatch','currency','balance','exposure']);
export class FundingCoverageError extends Error{
 constructor(code='funding_unavailable',reason='unavailable'){
  super(code==='funding_capacity'?'Nieuwe tegoedaankopen zijn tijdelijk niet beschikbaar.':'De beschikbaarheid van nieuwe tegoedaankopen kon niet worden gecontroleerd.');
  this.name='FundingCoverageError';this.code=code;this.reason=reason;this.status=503;
 }
}
const refused=(code,reason)=>new FundingCoverageError(code,reason);
function diagnosticFailure(stage,httpStatus=null,reason='provider_unavailable'){
 const error=refused('funding_unavailable',reason);
 // No response text, credential, account identity, URL or arbitrary exception
 // field enters this record. Only the explicit owner read may serialize it.
 if(failureStages.has(stage))failureDiagnostics.set(error,Object.freeze({stage,httpStatus:whole(httpStatus,100,599)?httpStatus:null}));
 return error;
}
function database(env){const db=env?.PRODUCTION_DB??env?.DB;if(!db?.prepare||!db?.batch)throw refused('funding_setup','database_unavailable');return db;}
function coefficient(finance){
 // Ignoring preparation and every rounding cost gives an UPPER bound for net
 // Fal USD per retail cent under the existing mandatory margin policy. Round
 // this per-cent coefficient UP with BigInt, never through floating division.
 const room=10000-finance.minMarginBps-finance.paymentFeeBps;
 if(room<=0)throw refused('funding_setup','finance_policy_unavailable');
 const n=BigInt(room)*100000000000000n;
 const d=BigInt(finance.eurPerUsdMicros)*BigInt(10000+finance.providerVatBps)*BigInt(10000+finance.failureBufferBps);
 const value=Number((n+d-1n)/d);
 if(!whole(value,1,20000))throw refused('funding_setup','finance_policy_unavailable');return value;
}
async function configuration(env){
 const db=database(env);let row,finance,mode;
 try{row=await db.prepare('SELECT * FROM rig_funding_policy WHERE id=1').first();mode=await db.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first();finance=await loadProfitPolicy(db);}catch{throw refused('funding_setup','policy_unavailable');}
 if(env?.RIG_FUNDING_COVERAGE_ENABLED!=='yes'||row?.enabled!==1)throw refused('funding_setup','policy_disabled');
 if(row.id!==1||!VERSION.test(row.version||'')||!USERNAME.test(row.expected_username||'')||!whole(row.buffer_usd_micros,0,MAX_BUFFER)||!whole(row.max_snapshot_age_ms,1000,60000)||mode?.mode!=='live')throw refused('funding_setup','policy_invalid');
 if(typeof env.FAL_KEY!=='string'||env.FAL_KEY.length<1||env.FAL_KEY.length>1024||/[\r\n]/.test(env.FAL_KEY))throw refused('funding_setup','provider_key_missing');
 return {db,policy:row,finance,factor:coefficient(finance),key:env.FAL_KEY};
}
async function boundedJSON(response,signal){
 const status=response?.status;
 if(!whole(status,100,599))throw diagnosticFailure('network');
 if(!response.ok||response.redirected)throw diagnosticFailure('http_status',status);
 if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw diagnosticFailure('content_type',status);
 if(!response.body)throw diagnosticFailure('json',status);
 const encoding=(response.headers.get('content-encoding')??'identity').trim().toLowerCase();
 if(!['identity','gzip','br'].includes(encoding))throw diagnosticFailure('content_encoding',status);
 const length=response.headers.get('content-length');
 if(length!==null&&!/^\d+$/.test(length))throw diagnosticFailure('content_length_invalid',status);
 if(length!==null&&Number(length)>16384)throw diagnosticFailure('body_size',status);
 const reader=response.body.getReader(),chunks=[];let total=0,onAbort;
 const deadline=new Promise((_,reject)=>{onAbort=()=>reject(diagnosticFailure('deadline',status));signal.addEventListener('abort',onAbort,{once:true});});
 try{
  if(signal.aborted)throw diagnosticFailure('deadline',status);
  for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(signal.aborted)throw diagnosticFailure('deadline',status);if(done)break;if(!(value instanceof Uint8Array)||total+value.length>16384)throw diagnosticFailure('body_size',status);chunks.push(value);total+=value.length;}
  // Fetch can decode a compressed response while retaining its wire headers.
  // Only identity Content-Length describes these bytes. The decoded stream is
  // still capped above, regardless of the advertised encoding or wire length.
  if(encoding==='identity'&&length!==null&&Number(length)!==total)throw diagnosticFailure('content_length_mismatch',status);
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw diagnosticFailure('json',status);}
 }finally{signal.removeEventListener('abort',onAbort);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function fetchBalance(config,network,now){
 if(typeof network!=='function'||!whole(now,1,Number.MAX_SAFE_INTEGER-60000))throw refused('funding_setup','invalid_request');
 // Share only short, credential/account/policy-bound reads in this isolate.
 // This saves concurrent API reads; it never replaces SQL liability checks.
 const signature=JSON.stringify([config.policy.version,config.policy.expected_username,config.policy.buffer_usd_micros,config.policy.max_snapshot_age_ms,config.finance]);
 let cache=caches.get(config.db);
 if(!cache||cache.key!==config.key||cache.signature!==signature||cache.network!==network){cache={key:config.key,signature,network};caches.set(config.db,cache);}
 const age=cache.value?now-cache.value.fetchedAt:Infinity;
 if(age>=0&&age<Math.min(10000,config.policy.max_snapshot_age_ms)&&cache.value.expiresAt>now)return cache.value;
 if(cache.pending)return cache.pending;
 const pending=(async()=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  const fetchDeadline=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('Provider deadline')),{once:true}));
  let httpStatus=null;try{
   const response=await Promise.race([network(BILLING,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',signal:controller.signal,headers:{Authorization:`Key ${config.key}`,Accept:'application/json'}}),fetchDeadline]);
   httpStatus=whole(response?.status,100,599)?response.status:null;
   const value=await boundedJSON(response,controller.signal),credits=value?.credits;
   if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.username!=='string'||!credits||typeof credits!=='object'||Array.isArray(credits))throw diagnosticFailure('schema',httpStatus);
   if(value.username!==config.policy.expected_username)throw diagnosticFailure('account_mismatch',httpStatus);
   if(credits.currency!=='USD')throw diagnosticFailure('currency',httpStatus);
   if(typeof credits.current_balance!=='number'||!Number.isFinite(credits.current_balance)||credits.current_balance<0)throw diagnosticFailure('balance',httpStatus);
   const micros=Math.floor(credits.current_balance*1000000);if(!whole(micros,0,MAX_USD))throw diagnosticFailure('balance',httpStatus);
   // Fal supplies no balance-as-of timestamp or freshness guarantee. fetchedAt
   // is only our observation time, and recent/uncertain costs are kept covered.
   const result=Object.freeze({availableUsdMicros:micros,fetchedAt:now,expiresAt:now+config.policy.max_snapshot_age_ms});cache.value=result;return result;
  }catch(error){throw failureDiagnostics.has(error)?error:diagnosticFailure(controller.signal.aborted?'deadline':'network',httpStatus);}finally{clearTimeout(timer);}
 })();cache.pending=pending;
 try{return await pending;}finally{if(cache.pending===pending)cache.pending=null;}
}
async function exposure(db){
 let row;try{row=await db.prepare("SELECT *,typeof(positive_wallet_cents) wallet_type,typeof(held_retail_cents) held_type,typeof(payable_order_cents) orders_type,typeof(provider_reserved_usd_micros) provider_type FROM rig_funding_exposure").first();}catch{throw diagnosticFailure('exposure',null,'exposure_unavailable');}
 if(!row||!['wallet_type','held_type','orders_type','provider_type'].every(key=>row[key]==='integer')||!['positive_wallet_cents','held_retail_cents','payable_order_cents'].every(key=>whole(row[key],0,MAX_CENTS))||!whole(row.provider_reserved_usd_micros,0,MAX_USD))throw diagnosticFailure('exposure',null,'exposure_unavailable');
 const total=row.positive_wallet_cents+row.held_retail_cents+row.payable_order_cents;if(!whole(total,0,MAX_CENTS))throw diagnosticFailure('exposure',null,'exposure_unavailable');
 return {positiveWalletCents:row.positive_wallet_cents,heldRetailCents:row.held_retail_cents,payableOrderCents:row.payable_order_cents,retailLiabilityCents:total,providerReservedUsdMicros:row.provider_reserved_usd_micros};
}
function summary(config,reading,owed){
 const requiredUsdMicros=owed.retailLiabilityCents*config.factor+owed.providerReservedUsdMicros+config.policy.buffer_usd_micros;
 if(!whole(requiredUsdMicros,0,Number.MAX_SAFE_INTEGER))throw diagnosticFailure('exposure',null,'exposure_unavailable');
 const headroomUsdMicros=reading.availableUsdMicros-requiredUsdMicros;
 return {enabled:true,status:headroomUsdMicros>=0?'ready':'insufficient',reason:headroomUsdMicros>=0?null:'funding_capacity',...reading,providerBalanceAsOf:null,...owed,usdMicrosPerEuroCent:config.factor,bufferUsdMicros:config.policy.buffer_usd_micros,requiredUsdMicros,headroomUsdMicros,newCreditCapacityCents:Math.max(0,Math.floor(headroomUsdMicros/config.factor)),policyVersion:config.policy.version,financeVersion:config.finance.version};
}
function snapshot(config,reading){
 const id=crypto.randomUUID();
 return {id,statement:config.db.prepare('INSERT INTO rig_funding_snapshots(id,funding_version,finance_version,finance_json,username,balance_usd_micros,usd_micros_per_euro_cent,buffer_usd_micros,fetched_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,config.policy.version,config.finance.version,JSON.stringify(config.finance),config.policy.expected_username,reading.availableUsdMicros,config.factor,config.policy.buffer_usd_micros,reading.fetchedAt,reading.expiresAt)};
}
export async function readFundingCoverage(env,{network=fetch,now=Date.now(),diagnostics=false}={}){
 let config;
 try{config=await configuration(env);const reading=await fetchBalance(config,network,now);return summary(config,reading,await exposure(config.db));}
 catch(error){return {enabled:Boolean(config),status:error?.code==='funding_setup'?'setup':'unavailable',reason:error instanceof FundingCoverageError?error.code:'funding_unavailable',fetchedAt:null,expiresAt:null,providerBalanceAsOf:null,availableUsdMicros:null,retailLiabilityCents:null,providerReservedUsdMicros:null,requiredUsdMicros:null,headroomUsdMicros:null,...(config?{policyVersion:config.policy.version,financeVersion:config.finance.version}:{}),...(diagnostics===true&&failureDiagnostics.has(error)?{diagnostic:failureDiagnostics.get(error)}:{})};}
}
export async function prepareFundingAdmission(mappedEnv,{userId,orderId,requestId,pkg,network=fetch,now=Date.now()}={}){
 if(!USER.test(userId||'')||!UUID.test(orderId||'')||typeof requestId!=='string'||!/^[A-Za-z0-9_-]{12,80}$/.test(requestId)||!pkg||!/^[a-z0-9_-]{1,40}$/.test(pkg.id||'')||!whole(pkg.amountCents,1,1000000)||!whole(pkg.credits,1,100000000))throw refused('funding_setup','invalid_request');
 const config=await configuration(mappedEnv),reading=await fetchBalance(config,network,now),owed=await exposure(config.db),status=summary(config,reading,owed);
 if(status.headroomUsdMicros<pkg.credits*config.factor)throw refused('funding_capacity','capacity');
 const saved=snapshot(config,reading),snapshotId=saved.id;
 const before=[
  saved.statement,
  config.db.prepare('INSERT INTO rig_funding_admissions(order_id,user_id,request_id,package_id,amount_cents,credit_cents,snapshot_id,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,request_id) DO NOTHING').bind(orderId,userId,requestId,pkg.id,pkg.amountCents,pkg.credits,snapshotId,now)
 ];
 return {before,gate:{sql:'EXISTS(SELECT 1 FROM rig_funding_valid_admissions a WHERE a.order_id=? AND a.user_id=? AND a.request_id=? AND a.package_id=? AND a.amount_cents=? AND a.credit_cents=? AND a.snapshot_id=?)',params:[orderId,userId,requestId,pkg.id,pkg.amountCents,pkg.credits,snapshotId]}};
}
export async function prepareOwnerFundingAdmission(env,{userId,jobId,quoteId,providerEstimateUsdMicros,network=fetch,now=Date.now()}={}){
 if(!USER.test(userId||'')||userId!==env?.RIG_PRODUCTION_OWNER_USER_ID||!UUID.test(jobId||'')||!UUID.test(quoteId||'')||!whole(providerEstimateUsdMicros,1,MAX_USD))throw refused('funding_setup','invalid_owner_request');
 const db=database(env);let exists,policy;
 try{
  exists=await db.prepare("SELECT 1 found FROM sqlite_master WHERE type='table' AND name='rig_funding_policy'").first();
  if(exists)policy=await db.prepare('SELECT enabled FROM rig_funding_policy WHERE id=1').first();
 }catch{throw refused('funding_setup','policy_unavailable');}
 // Compatibility applies ONLY to direct owner use before commercial coverage
 // is activated. Customer sales never take this path or receive a gate of 1.
 if(!exists||policy?.enabled===0)return {before:[],gate:{sql:'1',params:[]}};
 if(policy?.enabled!==1)throw refused('funding_setup','policy_invalid');
 const config=await configuration(env),reading=await fetchBalance(config,network,now),status=summary(config,reading,await exposure(db));
 if(status.headroomUsdMicros<providerEstimateUsdMicros)throw refused('funding_capacity','owner_capacity');
 const saved=snapshot(config,reading);
 return {before:[saved.statement,db.prepare('INSERT INTO rig_owner_funding_admissions(job_id,user_id,quote_id,estimated_usd_micros,snapshot_id,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id) DO NOTHING').bind(jobId,userId,quoteId,providerEstimateUsdMicros,saved.id,now)],gate:{sql:'EXISTS(SELECT 1 FROM rig_owner_valid_funding_admissions a WHERE a.job_id=? AND a.user_id=? AND a.quote_id=? AND a.estimated_usd_micros=? AND a.snapshot_id=?)',params:[jobId,userId,quoteId,providerEstimateUsdMicros,saved.id]}};
}
