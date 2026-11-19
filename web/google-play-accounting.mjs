// Owner-only evidence export. Google developer revenue is not a bank payout;
// wallet issuance/reversal is not another cash sale/refund. No invoices or mail.
import {validateProductionTenant} from './production-tenant.mjs';
import {d1Limit} from './router.mjs';
const OWNER=/^u-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/,PRODUCT=/^[a-z][a-z0-9._-]{0,99}$/;
const MAX_ROWS=5000,OVERVIEW=200,NANO=1000000000n;
const HEADERS={'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const json=(body,status=200)=>Response.json(body,{status,headers:HEADERS});
const failure=(text,status=503)=>json({error:text},status);
const whole=value=>Number.isSafeInteger(value)&&value>=0;
const timestamp=value=>whole(value)&&value<=8640000000000000;
function monthStart(year,month){
 const utc=Date.UTC(year,month-1,1),zone=new Intl.DateTimeFormat('en',{timeZone:'Europe/Brussels',timeZoneName:'shortOffset'}).formatToParts(utc).find(x=>x.type==='timeZoneName')?.value,offset=/^GMT\+([12])$/.exec(zone??'');
 if(!offset)throw Error('Unsupported time zone');return utc-Number(offset[1])*3600000;
}
function period(url){
 if(!url.search)return {month:null,start:null,end:null,timeZone:'Europe/Brussels',basis:'RIG-recorded-events-not-tax-point'};
 if(!/^\?month=20\d{2}-(?:0[1-9]|1[0-2])$/.test(url.search))return null;
 const month=url.searchParams.get('month'),[year,m]=month.split('-').map(Number);
 return {month,start:monthStart(year,m),end:m===12?monthStart(year+1,1):monthStart(year,m+1),timeZone:'Europe/Brussels',basis:'RIG-recorded-events-not-tax-point'};
}
const periodSQL=name=>`(? IS NULL OR ${name}>=?) AND (? IS NULL OR ${name}<?)`;
const periodArgs=p=>[p.start,p.start,p.end,p.end];
function nanos(value,{negative=false}={}){
 if(!value||value.currencyCode!=='EUR'||typeof value.units!=='string'||! /^-?(?:0|[1-9]\d{0,17})$/.test(value.units)||!Number.isSafeInteger(value.nanos)||Math.abs(value.nanos)>999999999)throw Error('Invalid Money');
 const units=BigInt(value.units),fraction=BigInt(value.nanos);
 if(units>0n&&fraction<0n||units<0n&&fraction>0n||!negative&&(units<0n||fraction<0n))throw Error('Inconsistent Money');
 return units*NANO+fraction;
}
function money(value){
 if(value===null)return null;
 const negative=value<0n,absolute=negative?-value:value,units=value/NANO,fraction=value%NANO;
 return {currencyCode:'EUR',units:units.toString(),nanos:Number(fraction),decimal:(negative?'-':'')+(absolute/NANO).toString()+'.'+(absolute%NANO).toString().padStart(9,'0')};
}
function financial(raw,productId){
 if(typeof raw!=='string'||raw.length>32768)return null;
 try{
  const value=JSON.parse(raw);
  if(value?.version!==1||value.source!=='google_order_v1'||value.mode!=='live'||value.productId!==productId||value.currency!=='EUR'||typeof value.orderId!=='string'||value.orderId.length<1||value.orderId.length>512||/[^\x21-\x7e]/.test(value.orderId)||!['PENDING','PROCESSED','CANCELED','PENDING_REFUND','PARTIALLY_REFUNDED','REFUNDED'].includes(value.state))return null;
  const gross=nanos(value.total),tax=value.tax==null?null:nanos(value.tax),net=value.developerRevenueInBuyerCurrency==null?null:nanos(value.developerRevenueInBuyerCurrency,{negative:true});
  if(tax!==null&&tax>gross||net!==null&&net>gross)throw Error('Inconsistent order amounts');
  const partials=value.partialRefundEvents??[];
  if(!Array.isArray(partials)||partials.length>100)throw Error('Invalid refund history');
  let partialRefund=0n;
  for(const event of partials){if(!['PENDING','PROCESSED_SUCCESSFULLY'].includes(event?.state))throw Error('Invalid refund event');const amount=nanos(event.total);if(event.state==='PROCESSED_SUCCESSFULLY')partialRefund+=amount;}
  const fullRefund=value.refundEvent==null?null:nanos(value.refundEvent.total);
  // A later net figure includes refund deductions. Derive fees only from a
  // processed, unrefunded snapshot with all three original components present.
  const fees=value.state==='PROCESSED'&&fullRefund===null&&partials.length===0&&tax!==null&&net!==null&&gross-tax-net>=0n?gross-tax-net:null;
  const refunded=value.state==='REFUNDED';
  const cashRefund=fullRefund!==null&&partials.length===0?fullRefund:fullRefund!==null||refunded?null:partialRefund;
  return {orderId:value.orderId,state:value.state,gross,tax,net,fees,cashRefund,fullRefund,partialRefund};
 }catch{return null;}
}
function identity(row){
 if(!HASH.test(row.token_hash??'')||!OWNER.test(row.user_id??'')||!PRODUCT.test(row.product_id??'')||!Number.isSafeInteger(row.credit_cents)||row.credit_cents<=0||!timestamp(row.created_at))throw Error('Invalid report row');
 return {receiptReference:'GP-'+row.token_hash,accountReference:row.user_id,productId:row.product_id,recordedAt:new Date(row.created_at).toISOString()};
}
const metric=values=>({amount:values.every(value=>value!==null)?money(values.reduce((sum,value)=>sum+value,0n)):null,knownSubtotal:money(values.reduce((sum,value)=>sum+(value??0n),0n)),unknownCount:values.filter(value=>value===null).length});
const csvColumns=['event_kind','receipt_reference','account_reference','product_id','state','recorded_at_utc','updated_at_utc','currency','google_order_id','financial_snapshot','google_gross_eur','google_tax_eur','google_developer_revenue_eur','google_fees_derived_eur','google_latest_developer_revenue_eur','google_verified_cash_refund_eur','rig_credit_issued_cents','rig_credit_reversed_cents','consumed','financial_evidence','bank_payout_reconciled','accounting_treatment'];
function csv(rows){
 const cell=(value,column)=>{
  if(typeof value==='number'){if(!Number.isSafeInteger(value))throw Error('Unsafe CSV integer');return String(value);}
  if(typeof value==='boolean')return value?'true':'false';
  let text=value==null?'':String(value);
  // These decimals are generated exclusively from BigInt Money, not user text.
  if(column.endsWith('_eur')&&/^-?\d+\.\d{9}$/.test(text))return text;
  if(/^[\s]*[=+\-@]/u.test(text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
 };
 return '\ufeff'+[csvColumns.map(key=>cell(key,key)).join(';'),...rows.map(row=>csvColumns.map(key=>cell(row[key],key)).join(';'))].join('\r\n')+'\r\n';
}
async function readReport(db,p){
 if((await db.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first())?.mode!=='live'||(await db.prepare('SELECT version FROM rig_google_play_schema WHERE id=1').first())?.version!=='rig-google-play-v1')throw Error('Wrong report realm');
 const statements=[
  db.prepare(`SELECT r.token_hash,r.user_id,r.product_id,r.credit_cents,r.state,r.consumed,r.finance_json,r.created_at,r.updated_at,c.finance_json AS credit_finance_json FROM rig_google_play_receipts r LEFT JOIN rig_google_play_credit_claims c ON c.token_hash=r.token_hash AND c.user_id=r.user_id WHERE r.mode='live' AND r.package_name='dev.andyarijs.rig' AND ${periodSQL('r.created_at')} ORDER BY r.created_at,r.token_hash LIMIT ?`).bind(...periodArgs(p),MAX_ROWS+1),
  db.prepare(`SELECT c.token_hash,c.user_id,r.product_id,c.credit_cents,c.finance_json,c.created_at,EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='google-play:'||c.token_hash AND l.user_id=c.user_id AND l.order_id IS NULL AND l.delta=c.credit_cents) AS ledger_proved FROM rig_google_play_credit_claims c JOIN rig_google_play_receipts r ON r.token_hash=c.token_hash AND r.user_id=c.user_id WHERE r.mode='live' AND r.package_name='dev.andyarijs.rig' AND ${periodSQL('c.created_at')} ORDER BY c.created_at,c.token_hash LIMIT ?`).bind(...periodArgs(p),MAX_ROWS+1),
  db.prepare(`SELECT v.token_hash,v.user_id,r.product_id,v.credit_cents,v.reason,v.created_at,EXISTS(SELECT 1 FROM rig_ledger l JOIN rig_google_play_credit_claims c ON c.token_hash=v.token_hash AND c.user_id=v.user_id AND c.credit_cents=v.credit_cents WHERE l.event_id='google-play-reversal:'||v.token_hash AND l.user_id=v.user_id AND l.order_id IS NULL AND l.delta=-v.credit_cents) AS ledger_proved FROM rig_google_play_reversals v JOIN rig_google_play_receipts r ON r.token_hash=v.token_hash AND r.user_id=v.user_id WHERE r.mode='live' AND r.package_name='dev.andyarijs.rig' AND ${periodSQL('v.created_at')} ORDER BY v.created_at,v.token_hash LIMIT ?`).bind(...periodArgs(p),MAX_ROWS+1)
 ];
 const result=await db.batch(statements);
 if(!Array.isArray(result)||result.length!==3||result.some(item=>item.success===false||!Array.isArray(item.results)))throw Error('Incomplete report result');
 if(result.some(item=>item.results.length>MAX_ROWS))throw Object.assign(Error('Choose a month'),{code:'report_too_large'});
 const [receipts,claims,reversals]=result.map(item=>item.results),totals={gross:[],tax:[],net:[],fees:[],refunds:[]},rows=[],purchases=[],orders=new Set();let issued=0,reversed=0,invalidFinancial=0;
 for(const row of receipts){
  const id=identity(row);if(!timestamp(row.updated_at)||![0,1].includes(row.consumed))throw Error('Invalid receipt state');
  const snapshot=financial(row.credit_finance_json??row.finance_json,row.product_id),latest=financial(row.finance_json,row.product_id);
  const duplicate=Boolean(snapshot&&orders.has(snapshot.orderId));if(snapshot)orders.add(snapshot.orderId);
  const source=snapshot&&!duplicate?snapshot:null,current=latest&&!duplicate&&(!snapshot||latest.orderId===snapshot.orderId)?latest:null;if(!source||!current)invalidFinancial++;
  // Pending/cancelled order values are not proof that Google processed money.
  const processed=source&&!['PENDING','CANCELED'].includes(source.state)?source:null;
  // A voided purchase can reverse the wallet before an updated Orders money
  // snapshot exists. Its stale PROCESSED record does not establish zero refund.
  const cashRefund=current&&(!['reversed','refunded'].includes(row.state)||current.state==='REFUNDED'&&current.fullRefund!==null)?current.cashRefund:null;
  totals.gross.push(processed?.gross??null);totals.tax.push(processed?.tax??null);totals.net.push(processed?.net??null);totals.fees.push(processed?.fees??null);totals.refunds.push(cashRefund);
  const item={...id,state:row.state,updatedAt:new Date(row.updated_at).toISOString(),consumed:row.consumed===1,googleOrderId:source?.orderId??null,financialSnapshot:row.credit_finance_json==null?'latest-order-snapshot-no-credit':'credit-grant-order-snapshot',googleGross:money(processed?.gross??null),googleTax:money(processed?.tax??null),googleDeveloperRevenue:money(processed?.net??null),googleFeesDerived:money(processed?.fees??null),latestGoogleDeveloperRevenue:money(current?.net??null),verifiedCashRefund:money(cashRefund),evidence:source&&current?'verified-google-order-snapshot':duplicate?'duplicate-order-reference':'missing-or-invalid-order-snapshot'};
  purchases.push(item);rows.push({event_kind:'google-order-observed',receipt_reference:id.receiptReference,account_reference:id.accountReference,product_id:id.productId,state:item.state,recorded_at_utc:id.recordedAt,updated_at_utc:item.updatedAt,currency:'EUR',google_order_id:item.googleOrderId,financial_snapshot:item.financialSnapshot,google_gross_eur:item.googleGross?.decimal,google_tax_eur:item.googleTax?.decimal,google_developer_revenue_eur:item.googleDeveloperRevenue?.decimal,google_fees_derived_eur:item.googleFeesDerived?.decimal,google_latest_developer_revenue_eur:item.latestGoogleDeveloperRevenue?.decimal,google_verified_cash_refund_eur:item.verifiedCashRefund?.decimal,consumed:item.consumed,financial_evidence:item.evidence,bank_payout_reconciled:false,accounting_treatment:'provider-order-evidence-not-bank-payout-or-tax-journal'});
 }
 for(const row of claims){
  const id=identity(row);if(row.ledger_proved!==1)throw Error('Credit ledger invariant');issued+=row.credit_cents;
  rows.push({event_kind:'rig-credit-issued',receipt_reference:id.receiptReference,account_reference:id.accountReference,product_id:id.productId,state:'credited',recorded_at_utc:id.recordedAt,currency:'EUR',rig_credit_issued_cents:row.credit_cents,financial_evidence:'matching-immutable-claim-and-ledger-event',bank_payout_reconciled:false,accounting_treatment:'wallet-liability-not-additional-cash-revenue'});
 }
 for(const row of reversals){
  const id=identity(row);if(row.ledger_proved!==1||!['refunded','voided','cancelled'].includes(row.reason))throw Error('Reversal ledger invariant');reversed+=row.credit_cents;
  rows.push({event_kind:'rig-credit-reversed',receipt_reference:id.receiptReference,account_reference:id.accountReference,product_id:id.productId,state:row.reason,recorded_at_utc:id.recordedAt,currency:'EUR',rig_credit_reversed_cents:row.credit_cents,financial_evidence:'matching-reversal-and-ledger-event',bank_payout_reconciled:false,accounting_treatment:'wallet-reversal-not-proof-of-cash-refund'});
 }
 if(!Number.isSafeInteger(issued)||!Number.isSafeInteger(reversed))throw Error('Unsafe credit total');
 return {rows,report:{provider:'google-play',currency:'EUR',mode:'live',period:p,receiptCount:receipts.length,creditEventCount:claims.length,reversalEventCount:reversals.length,invalidFinancialRecordCount:invalidFinancial,providerGross:metric(totals.gross),providerTax:metric(totals.tax),providerDeveloperRevenue:metric(totals.net),providerFeesDerived:metric(totals.fees),providerVerifiedCashRefunds:metric(totals.refunds),issuedCreditCents:issued,reversedCreditCents:reversed,payoutReconciled:false,actualBankPayout:null,actualProfit:null,formalAccountingComplete:false,automaticAccountableImport:false,automaticPeppolDelivery:false,invoiceCreated:false,purchases:purchases.slice(0,OVERVIEW),hasMorePurchases:purchases.length>OVERVIEW,exportPath:'/api/owner/accounting/export/google-play.csv'+(p.month?'?month='+p.month:''),warnings:['Google-opbrengst na inhoudingen is geen bevestigde bankuitbetaling.','Afgeleide kosten gebruiken uitsluitend een onveranderde order met bekende bruto-, belasting- en netto-componenten.','Uitgegeven en teruggeboekt RIG-tegoed zijn geen tweede geldontvangst of bewezen bankterugbetaling.','Ontbrekende of onvolledige Google-bedragen blijven onbekend; bedragen worden niet uit het tegoed afgeleid.','De periode gebruikt geregistreerde RIG-gebeurtenissen, geen automatisch vastgesteld fiscaal boekingsmoment.','Dit is bronmateriaal voor controle in Accountable; er wordt geen factuur gemaakt, gemaild of via Peppol verzonden.']}};
}

export function createGooglePlayAccounting({tenant=validateProductionTenant,limiter=d1Limit}={}){
 return async function handle(req,env,{userId}={}){
  if(!OWNER.test(env?.RIG_PRODUCTION_OWNER_USER_ID??'')||userId!==env.RIG_PRODUCTION_OWNER_USER_ID)return failure('Geen toegang.',403);
  let url;try{url=new URL(req.url);}catch{return failure('Aanvraag geweigerd.',400);}
  if(req.method!=='GET'||url.hash||!['/api/owner/accounting/google-play','/api/owner/accounting/export/google-play.csv'].includes(url.pathname))return failure('Niet gevonden.',404);
  const selected=period(url);if(!selected)return failure('Kies een geldige maand.',400);
  try{
   const mapped=await tenant(env);
   if(!mapped||mapped.DB!==env.PRODUCTION_DB||env.PRODUCTION_DB===env.DB||mapped.RIG_MODE!=='live'||url.origin!==mapped.RIG_PUBLIC_ORIGIN)return failure('Google Play-administratie is tijdelijk niet beschikbaar.');
   if(await limiter({env:mapped,category:'finance',userId,method:'GET'})!==true)return failure('Te veel aanvragen. Probeer later opnieuw.',429);
   const value=await readReport(mapped.DB,selected);
   if(url.pathname.endsWith('.csv')){
    const text=csv(value.rows);if(new TextEncoder().encode(text).length>8*1024*1024)return failure('Kies een afzonderlijke maand voor deze export.',413);
    return new Response(text,{headers:{...HEADERS,'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="RIG-Google-Play-${selected.month??'alle-periodes'}.csv"`,'content-security-policy':"default-src 'none'; frame-ancestors 'none'"}});
   }
   return json(value.report);
  }catch(error){return failure(error.code==='report_too_large'?'Kies een afzonderlijke maand voor deze export.':'Google Play-administratie is tijdelijk niet beschikbaar.',error.code==='report_too_large'?413:503);}
 };
}
export const handleGooglePlayAccounting=createGooglePlayAccounting();
