// Private operational reporting. This is not a tax return or a provider invoice.
import {validateProductionTenant} from './production-tenant.mjs';
import {parseProfitPolicy,profitPolicyRow,validProfitSnapshot} from './profit-policy.mjs';
import {d1Limit} from './router.mjs';
import {prepareOwnerMutation} from './owner-security.mjs';
import {workflowProviderBudgetPredicate} from './workflow-finance.mjs';

const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID=/^[A-Za-z0-9_-]{1,100}$/;
const VERSION=/^[A-Za-z0-9_.-]{1,64}$/;
const categories=new Set(['fal-charge','fal-topup','mollie','hosting','other','refund']);
const columns=['eur_per_usd_micros','provider_vat_bps','payment_fee_bps','failure_buffer_bps','preparation_cents','min_margin_bps','daily_provider_limit_usd_micros','min_price_cents','min_pro_price_cents'];
const names=['eurPerUsdMicros','providerVatBps','paymentFeeBps','failureBufferBps','preparationCents','minMarginBps','dailyProviderLimitUsdMicros','minPriceCents','minProPriceCents'];
const json=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const error=(message,status)=>json({error:message},status);
const whole=(n,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const optionalRate=value=>typeof value==='string'&&/^[1-9][0-9]*$/.test(value)&&whole(Number(value),1,250)?Number(value):null;
const dateValid=value=>typeof value==='string'&&/^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const timeZone='Europe/Brussels';
function localDate(now){const p=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);const get=t=>p.find(x=>x.type===t).value;return `${get('year')}-${get('month')}-${get('day')}`;}
function monthStart(year,month){const provisional=Date.UTC(year,month-1,1),part=new Intl.DateTimeFormat('en',{timeZone,timeZoneName:'shortOffset'}).formatToParts(provisional).find(x=>x.type==='timeZoneName')?.value,offset=/^GMT\+([12])$/.exec(part||'');if(!offset)throw Error('Report timezone unavailable');return provisional-Number(offset[1])*3600000;}
function reportPeriod(url){
 const params=url.searchParams,month=params.get('month');
 if([...params.keys()].some(k=>k!=='month')||params.getAll('month').length>1||month!==null&&!/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(month))return null;
 if(month===null)return {month:null,from:null,to:null,timeZone,start:null,end:null};
 const [year,m]=month.split('-').map(Number),start=monthStart(year,m),end=m===12?monthStart(year+1,1):monthStart(year,m+1);
 return {month,from:new Date(start).toISOString(),to:new Date(end).toISOString(),timeZone,start,end};
}
async function body(req){
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))return null;
 const length=req.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>8192))return null;
 const reader=req.body?.getReader();if(!reader)return null;let size=0;const parts=[];
 try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>8192)return null;parts.push(r.value)}const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length}const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return value&&typeof value==='object'&&!Array.isArray(value)?value:null}catch{return null}finally{void reader.cancel().catch(()=>{})}
}
const policyFrom=row=>({...parseProfitPolicy(row),updatedAt:row.updated_at});
const effectiveExpenses=`SELECT e.* FROM rig_finance_expenses e WHERE NOT EXISTS(SELECT 1 FROM rig_finance_expenses replacement WHERE replacement.replaces_expense_id=e.id)`;
const periodSQL=field=>`(? IS NULL OR ${field}>=?) AND (? IS NULL OR ${field}<?)`;
const periodArgs=p=>[p.start,p.start,p.end,p.end];
const ledgerTime=alias=>`CAST(strftime('%s',${alias}.created_at) AS INTEGER)*1000`;
// The credit journal proves a paid purchase. Expired/open checkout face values
// and unclaimed promotional invitations are never counted as cash received.
const purchases=`SELECT o.*,${ledgerTime('l')} AS credited_at FROM rig_orders o JOIN rig_ledger l
 ON l.event_id='credit:'||o.id AND l.order_id=o.id AND l.user_id=o.user_id AND l.delta=o.credits
 WHERE o.payment_id IS NOT NULL AND o.state IN ('paid','reversal_review')`;
const completed=`SELECT j.* FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id AND q.user_id=j.user_id AND q.price_cents=j.price_cents
 WHERE j.state='completed' AND q.funding_kind='credits'
 AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='reserve:'||j.id AND l.user_id=j.user_id AND l.delta=-j.price_cents)
 AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='settle:'||j.id AND l.user_id=j.user_id AND l.delta=0)
 AND NOT EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='release:'||j.id)`;
// Promotional funds are consumed first. The reflected running sum handles
// gifts issued AFTER earlier paid use, without turning those gifts into sales.
const earnedCTE=`WITH completed AS (${completed}), events AS (
 SELECT user_id,event_id AS event_key,${ledgerTime('rig_ledger')} AS at,delta,0 AS spend FROM rig_ledger WHERE event_id LIKE 'promo:%' AND delta>0
 UNION ALL SELECT user_id,'video:'||id,finalized_at,-price_cents,price_cents FROM completed
), running AS (
 SELECT *,SUM(delta) OVER(PARTITION BY user_id ORDER BY at,event_key ROWS UNBOUNDED PRECEDING) AS raw FROM events
), reflected AS (
 SELECT *,raw-MIN(0,MIN(raw) OVER(PARTITION BY user_id ORDER BY at,event_key ROWS UNBOUNDED PRECEDING)) AS gift_balance FROM running
), allocated AS (
 SELECT *,LAG(gift_balance,1,0) OVER(PARTITION BY user_id ORDER BY at,event_key) AS prior_gift FROM reflected
), earned AS (
 SELECT substr(event_key,7) AS job_id,at,spend,MIN(spend,prior_gift) AS promo_spend,spend-MIN(spend,prior_gift) AS earned FROM allocated WHERE spend>0
)`;
function checkedRow(row){for(const [key,value]of Object.entries(row||{}))if(typeof value==='number'&&!Number.isSafeInteger(value))throw Error('Unsafe financial aggregate');return row;}
function snapshotOf(row){
 try{const input=JSON.parse(row.input_json),snapshot=input.profitSnapshot;if(!snapshot)return null;const policy={...snapshot,version:snapshot.policyVersion};return validProfitSnapshot(snapshot,{policy,fundingKind:row.funding_kind,retailPriceCents:row.price_cents,providerEstimateUsdMicros:input.providerEstimateUsdMicros})?snapshot:null}catch{return null;}
}
const snapPath=key=>`json_extract(q.input_json,'$.profitSnapshot.${key}')`;
const hasSnapshot=`CASE WHEN json_valid(q.input_json) THEN json_type(q.input_json,'$.profitSnapshot')='object' AND ${snapPath('version')}=1 AND json_type(q.input_json,'$.profitSnapshot.estimatedCostCents')='integer' AND ${snapPath('estimatedCostCents')}>=0 ELSE 0 END`;
const dispatched=`(c.job_id IS NOT NULL OR j.fal_request_id IS NOT NULL OR j.poll_token='dispatch-authorized' OR j.state='unknown')`;
// Match completed-video costs to the same recognition date as earned revenue.
// Pending/failed attempts remain in their authorization/preparation period.
const reportAt=`CASE WHEN j.state='completed' AND j.finalized_at IS NOT NULL THEN j.finalized_at ELSE COALESCE(c.authorized_at,j.created_at) END`;

async function summary(mapped,period,now){
 const pendingProviderBudget=workflowProviderBudgetPredicate({enabled:mapped.RIG_OWNER_CLEANUP_VALIDATION_ENABLED==='yes',job:'j'});
 const db=mapped.DB,p=periodArgs(period),rows=await db.batch([
  db.prepare('SELECT * FROM rig_finance_policy WHERE id=1'),
  db.prepare(`SELECT COALESCE(SUM(amount_cents),0) cash,COALESCE(SUM(credits),0) issued,COALESCE(SUM(CASE WHEN state='reversal_review' THEN amount_cents ELSE 0 END),0) review FROM (${purchases}) WHERE ${periodSQL('credited_at')}`).bind(...p),
  db.prepare(`SELECT COALESCE(SUM(MAX(balance,0)),0) outstanding,COALESCE(SUM(MAX(-balance,0)),0) negative FROM (SELECT user_id,SUM(delta) balance FROM rig_ledger GROUP BY user_id)`),
  db.prepare(`SELECT COALESCE(SUM(delta),0) promo FROM rig_ledger WHERE event_id LIKE 'promo:%' AND delta>0`),
  db.prepare(`SELECT COALESCE(SUM(-r.delta),0) held FROM rig_ledger r WHERE r.event_id LIKE 'reserve:%' AND NOT EXISTS(SELECT 1 FROM rig_ledger f WHERE f.event_id IN ('release:'||substr(r.event_id,9),'settle:'||substr(r.event_id,9)))`),
  db.prepare(`${earnedCTE} SELECT COALESCE(SUM(earned),0) earned,COALESCE(SUM(promo_spend),0) promo_spend,COALESCE(SUM(spend),0) spend FROM earned WHERE ${periodSQL('at')}`).bind(...p),
  db.prepare(`SELECT j.state,q.funding_kind,COUNT(*) count,SUM(CASE WHEN ${dispatched} THEN 1 ELSE 0 END) dispatched,
   SUM(CASE WHEN ${hasSnapshot} THEN 0 ELSE 1 END) missing_estimate,
   COALESCE(SUM(CASE WHEN ${hasSnapshot} AND ${dispatched} THEN ${snapPath('providerCostCents')} ELSE 0 END),0) fal,
   COALESCE(SUM(CASE WHEN ${hasSnapshot} AND ${dispatched} THEN ${snapPath('paymentFeeReserveCents')} ELSE 0 END),0) payment,
   COALESCE(SUM(CASE WHEN ${hasSnapshot} THEN ${snapPath('preparationCents')} ELSE 0 END),0) preparation,
   COALESCE(SUM(CASE WHEN ${hasSnapshot} AND ${dispatched} THEN ${snapPath('failureReserveCents')} ELSE 0 END),0) failure,
   SUM(CASE WHEN ${dispatched} AND NOT EXISTS(SELECT 1 FROM (${effectiveExpenses}) e WHERE e.category='fal-charge' AND e.job_id=j.id) THEN 1 ELSE 0 END) missing_actual
   FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id AND q.user_id=j.user_id
   LEFT JOIN rig_generation_costs c ON c.job_id=j.id WHERE ${periodSQL(reportAt)} GROUP BY j.state,q.funding_kind`).bind(...p),
  db.prepare(`SELECT category,COALESCE(SUM(amount_cents),0) amount FROM (${effectiveExpenses}) WHERE (? IS NULL OR substr(expense_date,1,7)=?) GROUP BY category`).bind(period.month,period.month),
  db.prepare(`${earnedCTE} SELECT j.id,j.state,j.created_at,j.finalized_at,j.fal_request_id,j.price_cents,q.funding_kind,q.input_json,q.duration_seconds,c.job_id AS cost_job_id,COALESCE(e.earned,0) AS earned_cents,${reportAt} AS recognized_at,
   (SELECT e.amount_cents FROM (${effectiveExpenses}) e WHERE e.category='fal-charge' AND e.job_id=j.id) actual_cost,
   ${dispatched} AS dispatched FROM rig_generation_jobs j JOIN rig_generation_quotes q ON q.id=j.quote_id AND q.user_id=j.user_id
   LEFT JOIN rig_generation_costs c ON c.job_id=j.id LEFT JOIN earned e ON e.job_id=j.id WHERE ${periodSQL(reportAt)} ORDER BY recognized_at DESC,j.id DESC LIMIT 50`).bind(...p),
  db.prepare(`SELECT id,category,expense_date,amount_cents,note,job_id,replaces_expense_id,created_at FROM (${effectiveExpenses}) WHERE (? IS NULL OR substr(expense_date,1,7)=?) ORDER BY expense_date DESC,created_at DESC,id DESC LIMIT 100`).bind(period.month,period.month),
  db.prepare(`SELECT COALESCE(SUM(c.provider_estimate_usd_micros),0) used FROM rig_generation_costs c JOIN rig_generation_jobs j ON j.id=c.job_id WHERE ${pendingProviderBudget}`).bind(new Date(now).toISOString().slice(0,10)),
  db.prepare("SELECT COUNT(*) count FROM rig_orders WHERE state IN ('reversal_review','credit_pending_review')")
 ]);
 if(rows.some(row=>row.success!==true))throw Error('Financial read failed');
 const result=i=>rows[i].results,one=i=>checkedRow(result(i)[0]);
 const policy=policyFrom(one(0)),purchase=one(1),wallet=one(2),held=one(4).held,earned=one(5),groups=result(6).map(checkedRow),expenseGroups=new Map(result(7).map(checkedRow).map(row=>[row.category,row.amount]));
 const sum=key=>groups.reduce((n,row)=>n+row[key],0),missingEstimateJobs=sum('missing_estimate'),missingActualJobs=sum('missing_actual');
 const estimatedFalCents=missingEstimateJobs?null:sum('fal'),estimatedPaymentCents=missingEstimateJobs?null:sum('payment'),estimatedPreparationCents=missingEstimateJobs?null:sum('preparation'),estimatedFailureReserveCents=missingEstimateJobs?null:sum('failure');
 const estimatedTotalCents=missingEstimateJobs?null:estimatedFalCents+estimatedPaymentCents+estimatedPreparationCents+estimatedFailureReserveCents;
 const actualFalRecordedCents=expenseGroups.get('fal-charge')||0,actualMollieRecordedCents=expenseGroups.get('mollie')||0,fixedRecordedCents=(expenseGroups.get('hosting')||0)+(expenseGroups.get('other')||0),refundedCents=expenseGroups.get('refund')||0;
 // A generic customer refund is cash repaid, often unused prepaid liability.
 // It is not proof that an earned video sale has been reversed or a new cost.
 const actualRecordedCents=actualFalRecordedCents+actualMollieRecordedCents+fixedRecordedCents,estimatedContributionCents=estimatedTotalCents===null?null:earned.earned-estimatedTotalCents;
 const jobs=result(8).map(row=>{const snapshot=snapshotOf(row),knownDispatch=row.dispatched===1,cost=snapshot?(knownDispatch?snapshot.estimatedCostCents:snapshot.preparationCents):null;return {id:row.id,createdAt:new Date(row.created_at).toISOString(),recognizedAt:new Date(row.recognized_at).toISOString(),state:row.state,fundingKind:row.funding_kind,priceCents:row.funding_kind==='owner-provider'?0:row.price_cents,durationSeconds:row.duration_seconds,providerRequestId:row.fal_request_id||null,estimatedCostCents:cost,actualCostCents:row.actual_cost??null,canRecordFalCost:knownDispatch&&row.actual_cost===null,estimatedMarginCents:cost===null?null:row.earned_cents-cost};});
 const warnings=['Dit is een operationeel overzicht, geen belastingaangifte.','Werkelijke winst is nog niet vastgesteld: factuurkosten kunnen onvolledig zijn.','De wisselkoers en btw-, betaal- en foutreserves zijn budgetaannames.','Mollie-opbrengsten worden niet automatisch naar Fal overgemaakt.','Een ingevoerde terugbetaling is een geldstroom. Ze wijzigt niet automatisch het klanttegoed of de omzet van een voltooide video.'];
 if(missingActualJobs)warnings.push(`Voor ${missingActualJobs} verzonden video-opdrachten ontbreekt een ingevoerde Fal-kost.`);
 if(missingEstimateJobs)warnings.push(`Voor ${missingEstimateJobs} oudere opdrachten ontbreekt een volledige kostenraming.`);
 if(one(11).count)warnings.push('Er zijn betalingen of terugboekingen die controle nodig hebben; een creditcorrectie bewijst geen ontvangen geldterugbetaling.');
 if(wallet.negative)warnings.push('Er zijn negatieve tegoedsaldi. Die verminderen de verplichting tegenover andere klanten niet.');
 const budgetDay=new Date(now).toISOString().slice(0,10),used=one(10).used;
 const report={currency:'EUR',generatedAt:new Date(now).toISOString(),period:{month:period.month,from:period.from,to:period.to,timeZone},
  income:{cashReceivedCents:purchase.cash,creditIssuedCents:purchase.issued,earnedVideoCents:earned.earned,refundedCents,promotionalVideoUseCents:earned.promo_spend,paymentReviewCents:purchase.review},
  credits:{outstandingCents:wallet.outstanding,promoIssuedCents:one(3).promo,heldCents:held,liabilityCents:wallet.outstanding+held,negativeBalanceCents:wallet.negative},
  costs:{estimatedFalCents,estimatedPaymentCents,estimatedPreparationCents,estimatedFailureReserveCents,estimatedTotalCents,actualRecordedCents,actualFalRecordedCents,actualMollieRecordedCents,fixedRecordedCents,falTopupsCents:expenseGroups.get('fal-topup')||0,actualCoverageComplete:false,actualProfitCents:null,recordedResultCents:earned.earned-actualRecordedCents,missingActualJobs,missingEstimateJobs,automaticBillingConnected:false},
  margin:{estimatedContributionCents,estimatedMarginBps:estimatedContributionCents!==null&&earned.earned?Math.floor(estimatedContributionCents*10000/earned.earned):null,estimatedOperatingResultCents:estimatedContributionCents===null?null:estimatedContributionCents-fixedRecordedCents},
  videoCounts:{total:sum('count'),completed:groups.filter(row=>row.state==='completed').reduce((n,row)=>n+row.count,0),unknown:groups.filter(row=>row.state==='unknown').reduce((n,row)=>n+row.count,0),ownerUse:groups.filter(row=>row.funding_kind==='owner-provider').reduce((n,row)=>n+row.count,0)},
  dailyBudget:{budgetDay,timeZone:'UTC',usedUsdMicros:used,limitUsdMicros:policy.dailyProviderLimitUsdMicros,remainingUsdMicros:Math.max(0,policy.dailyProviderLimitUsdMicros-used)},
  prices:{standardCentsPerSecond:optionalRate(mapped.RIG_PRICE_STANDARD),proCentsPerSecond:optionalRate(mapped.RIG_PRICE_PRO),editCentsPerSecond:optionalRate(mapped.RIG_PRICE_EDIT)},policy,jobs,
  expenses:result(9).map(row=>({id:row.id,category:row.category,date:row.expense_date,amountCents:row.amount_cents,note:row.note,jobId:row.job_id,replacesExpenseId:row.replaces_expense_id,createdAt:new Date(row.created_at).toISOString()})),warnings};
 for(const key of ['income','credits','costs','margin','videoCounts','dailyBudget','prices','policy'])checkedRow(report[key]);
 return report;
}
async function saveExpense(req,mapped,user,now){
 const data=await body(req),required=['idempotencyKey','category','date','amountCents','note'],optional=['jobId','replacesExpenseId','verification'];
 if(!data||required.some(key=>!Object.hasOwn(data,key))||Object.keys(data).some(key=>!required.includes(key)&&!optional.includes(key))||!UUID.test(data.idempotencyKey||'')||!categories.has(data.category)||!dateValid(data.date)||data.date>localDate(now)||!whole(data.amountCents,0,100000000)||(data.amountCents===0&&data.category!=='fal-charge'&&data.replacesExpenseId==null)||typeof data.note!=='string'||Array.from(data.note.trim()).length<1||Array.from(data.note).length>240||/[\u0000-\u001f\u007f]/.test(data.note)||(data.category==='fal-charge'?!ID.test(data.jobId||''):Object.hasOwn(data,'jobId')))return error('Controleer de datum, het bedrag en de kostensoort.',400);
 if(Object.hasOwn(data,'replacesExpenseId')&&!UUID.test(data.replacesExpenseId||''))return error('Controleer de correctie.',400);
 const normalized={category:data.category,date:data.date,amountCents:data.amountCents,note:data.note.trim(),jobId:data.jobId??null,replacesExpenseId:data.replacesExpenseId??null};
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(normalized)))),n=>n.toString(16).padStart(2,'0')).join('');
 const db=mapped.DB,prior=await db.prepare('SELECT id,request_hash FROM rig_finance_expenses WHERE idempotency_key=?').bind(data.idempotencyKey).first();
 if(prior)return prior.request_hash===hash?json({id:prior.id,recorded:true,replayed:true}):error('Deze aanvraagcode is al gebruikt voor een andere kost.',409);
 const {verification,...payload}=data;
 const security=await prepareOwnerMutation(db,{ownerId:user,operation:'finance-expense',payload,verification,now});if(!security.ok)return security.response;
 const id=crypto.randomUUID(),insert=db.prepare(`INSERT INTO rig_finance_expenses(id,idempotency_key,category,expense_date,amount_cents,note,job_id,replaces_expense_id,request_hash,created_by,created_at)
 SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (${security.gate.sql}) AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')
 AND (?<>'fal-charge' OR EXISTS(SELECT 1 FROM rig_generation_jobs j WHERE j.id=? AND (j.fal_request_id IS NOT NULL OR EXISTS(SELECT 1 FROM rig_generation_costs c WHERE c.job_id=j.id))))
 AND (? IS NULL OR EXISTS(SELECT 1 FROM rig_finance_expenses e WHERE e.id=? AND e.category=? AND e.job_id IS ? AND e.expense_date=? AND NOT EXISTS(SELECT 1 FROM rig_finance_expenses r WHERE r.replaces_expense_id=e.id)))`)
 .bind(id,data.idempotencyKey,data.category,data.date,data.amountCents,data.note.trim(),data.jobId??null,data.replacesExpenseId??null,hash,user,now,...security.gate.params,data.category,data.jobId??null,data.replacesExpenseId??null,data.replacesExpenseId??null,data.category,data.jobId??null,data.date);
 try{const results=await db.batch([...security.before,insert]);const result=results.at(-1);if(result.meta?.changes===1)return json({id,recorded:true,replayed:false},201);}catch{}
 const concurrent=await db.prepare('SELECT id,request_hash FROM rig_finance_expenses WHERE idempotency_key=?').bind(data.idempotencyKey).first();
 if(concurrent?.request_hash===hash)return json({id:concurrent.id,recorded:true,replayed:true});
 return error('Deze kost is niet opgeslagen. Controleer de video of de bestaande kost.',409);
}
async function savePolicy(req,mapped,user,now){
 const data=await body(req);
 if(!data||Object.keys(data).filter(key=>key!=='verification').length!==names.length+1||!VERSION.test(data.expectedVersion||'')||names.some(name=>!Object.hasOwn(data,name))||Object.keys(data).some(key=>key!=='expectedVersion'&&key!=='verification'&&!names.includes(key)))return error('Controleer de kosteninstellingen.',400);
 const version=`profit-${now}-${crypto.randomUUID().slice(0,8)}`;let row;
 try{row=profitPolicyRow({...data,version});}catch{return error('Een kosteninstelling valt buiten het toegestane bereik.',400);}
 const current=await mapped.DB.prepare('SELECT version FROM rig_finance_policy WHERE id=1').first();
 if(current?.version!==data.expectedVersion)return error('De instellingen zijn ondertussen gewijzigd. Vernieuw het overzicht en controleer ze opnieuw.',409);
 const {verification,...payload}=data;
 const security=await prepareOwnerMutation(mapped.DB,{ownerId:user,operation:'finance-policy',payload,verification,now});if(!security.ok)return security.response;
 const update=mapped.DB.prepare(`UPDATE rig_finance_policy SET version=?,${columns.map(column=>column+'=?').join(',')},updated_at=? WHERE id=1 AND version=? AND (${security.gate.sql}) AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')`).bind(version,...columns.map(column=>row[column]),now,data.expectedVersion,...security.gate.params);
 const history=mapped.DB.prepare('INSERT INTO rig_finance_policy_history(version,policy_json,changed_by,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM rig_finance_policy WHERE id=1 AND version=?)').bind(version,JSON.stringify(parseProfitPolicy(row)),user,now,version);
 const result=await mapped.DB.batch([...security.before,update,history]);if(result.at(-2)?.meta?.changes!==1||result.at(-1)?.meta?.changes!==1)return error('De instellingen zijn ondertussen gewijzigd. Vernieuw het overzicht en controleer ze opnieuw.',409);
 return json({saved:true,policy:{...parseProfitPolicy(row),updatedAt:now}});
}
// userId must come from authenticateProductionSites, never from request data.
export async function handleOwnerFinance(req,env,{userId,now=Date.now()}={}){
 if(!USER.test(env?.RIG_PRODUCTION_OWNER_USER_ID||'')||userId!==env.RIG_PRODUCTION_OWNER_USER_ID)return error('Geen toegang.',403);
 const mapped=await validateProductionTenant(env);if(!mapped)return error('Het financiële overzicht is tijdelijk niet beschikbaar.',503);
 const url=new URL(req.url);
 if(url.origin!==mapped.RIG_PUBLIC_ORIGIN||!['GET','POST'].includes(req.method)||req.method==='POST'&&req.headers.get('origin')!==mapped.RIG_PUBLIC_ORIGIN)return error('Aanvraag geweigerd.',403);
 if(await d1Limit({env:mapped,category:'finance',userId,method:req.method})!==true)return error('Te veel aanvragen. Probeer later opnieuw.',429);
 try{
  if(req.method==='GET'&&url.pathname==='/api/owner/finance'){
   const period=reportPeriod(url);if(!period)return error('Kies een geldige maand.',400);
   return json(await summary(mapped,period,now));
  }
  if(req.method==='POST'&&!url.search&&url.pathname==='/api/owner/finance/expenses')return await saveExpense(req,mapped,userId,now);
  if(req.method==='POST'&&!url.search&&url.pathname==='/api/owner/finance/policy')return await savePolicy(req,mapped,userId,now);
  return error('Niet gevonden.',404);
 }catch{return error('Het financiële overzicht is tijdelijk niet beschikbaar.',503);}
}
