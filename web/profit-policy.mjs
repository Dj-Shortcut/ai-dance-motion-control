// Server-only budget estimates. These are conservative planning assumptions,
// never a provider invoice, actual FX transaction, or a customer-visible price.
const whole=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const VERSION=/^[A-Za-z0-9_.-]{1,64}$/;
const fields=Object.freeze({
 eur_per_usd_micros:['eurPerUsdMicros',500000,2000000],
 provider_vat_bps:['providerVatBps',0,3000],
 payment_fee_bps:['paymentFeeBps',0,3000],
 failure_buffer_bps:['failureBufferBps',0,10000],
 preparation_cents:['preparationCents',0,500],
 min_margin_bps:['minMarginBps',0,9000],
 daily_provider_limit_usd_micros:['dailyProviderLimitUsdMicros',100000,1000000000],
 min_price_cents:['minPriceCents',1,1200],
 min_pro_price_cents:['minProPriceCents',1,1200]
});
export function parseProfitPolicy(row){
 if(!row||row.id!==1||!VERSION.test(row.version||''))throw Error('Profit policy unavailable');
 const policy={version:row.version};
 for(const [column,[name,min,max]]of Object.entries(fields)){
  if(!whole(row[column],min,max))throw Error('Profit policy unavailable');
  policy[name]=row[column];
 }
 return Object.freeze(policy);
}
export async function loadProfitPolicy(db){return parseProfitPolicy(await db.prepare('SELECT * FROM rig_finance_policy WHERE id=1').first());}
export function profitPolicyRow(policy){
 const row={id:1,version:policy?.version};
 for(const [column,[name]]of Object.entries(fields))row[column]=policy?.[name];
 parseProfitPolicy(row);return row;
}
export function retailPriceCents(policy,{quality,billedSeconds,rateCents,providerEstimateUsdMicros,fundingKind='credits',maxPriceCents=1200}){
 profitPolicyRow(policy);
 if(!['standard','pro','edit-standard'].includes(quality)||!whole(billedSeconds,3,quality==='edit-standard'?15:30)||!whole(rateCents,1,250))throw Error('Invalid retail price');
 let price=Math.max(quality==='pro'?policy.minProPriceCents:policy.minPriceCents,rateCents*billedSeconds);
 if(!whole(maxPriceCents,1,1200)||price>maxPriceCents)throw Error('Retail price exceeds cap');
 if(providerEstimateUsdMicros===undefined)return price;
 const initial=createProfitSnapshot({policy,fundingKind,retailPriceCents:price,providerEstimateUsdMicros});
 if(fundingKind==='owner-provider')return price;
 // Solve the fixed-cost part first, then account for the integer-cent fee
 // ceiling. This is a NEW quote only; persisted confirmations are never raised.
 const room=10000-policy.minMarginBps-policy.paymentFeeBps;
 if(room<=0)throw Error('Contribution margin unavailable');
 const fixed=initial.providerCostCents+initial.failureReserveCents+initial.preparationCents;
 price=Math.max(price,up(BigInt(fixed)*10000n,BigInt(room)));
 for(;price<=maxPriceCents;price++)if(profitable(createProfitSnapshot({policy,fundingKind,retailPriceCents:price,providerEstimateUsdMicros})))return price;
 throw Error('Profitable price exceeds cap');
}
function up(numerator,denominator){
 const result=(BigInt(numerator)+BigInt(denominator)-1n)/BigInt(denominator);
 const number=Number(result);if(!whole(number,0,Number.MAX_SAFE_INTEGER))throw Error('Cost estimate overflow');return number;
}
export function createProfitSnapshot({policy,fundingKind,retailPriceCents:price,providerEstimateUsdMicros:usd}){
 profitPolicyRow(policy);
 if(!['credits','owner-provider'].includes(fundingKind)||!whole(price,1,1200)||!whole(usd,1,6000000))throw Error('Invalid cost estimate');
 const revenueCents=fundingKind==='credits'?price:0;
 const providerNetCostCents=up(BigInt(usd)*BigInt(policy.eurPerUsdMicros),10000000000n);
 const providerVatReserveCents=up(BigInt(providerNetCostCents)*BigInt(policy.providerVatBps),10000n);
 const providerCostCents=providerNetCostCents+providerVatReserveCents;
 const paymentFeeReserveCents=up(BigInt(revenueCents)*BigInt(policy.paymentFeeBps),10000n);
 const failureReserveCents=up(BigInt(providerCostCents)*BigInt(policy.failureBufferBps),10000n);
 const estimatedCostCents=providerCostCents+paymentFeeReserveCents+failureReserveCents+policy.preparationCents;
 const marginCents=revenueCents-estimatedCostCents;
 return Object.freeze({version:1,policyVersion:policy.version,fundingKind,retailPriceCents:price,revenueCents,providerEstimateUsdMicros:usd,
  ...Object.fromEntries(Object.values(fields).map(([name])=>[name,policy[name]])),
  providerNetCostCents,providerVatReserveCents,providerCostCents,paymentFeeReserveCents,failureReserveCents,estimatedCostCents,marginCents,
  marginBps:revenueCents?Math.floor(marginCents*10000/revenueCents):null});
}
export function profitable(snapshot){return snapshot?.fundingKind==='owner-provider'||snapshot?.fundingKind==='credits'&&whole(snapshot.revenueCents,1,1200)&&Number.isSafeInteger(snapshot.marginCents)&&whole(snapshot.minMarginBps,0,9000)&&BigInt(snapshot.marginCents)*10000n>=BigInt(snapshot.revenueCents)*BigInt(snapshot.minMarginBps);}
// Recompute every field from trusted persisted quote inputs and the current
// policy. An old/missing policy never silently reprices a confirmed quote.
export function validProfitSnapshot(snapshot,{policy,fundingKind,retailPriceCents,providerEstimateUsdMicros}={}){
 try{
  const expected=createProfitSnapshot({policy,fundingKind,retailPriceCents,providerEstimateUsdMicros});
  return Boolean(snapshot&&typeof snapshot==='object'&&!Array.isArray(snapshot)&&Object.keys(snapshot).length===Object.keys(expected).length&&Object.keys(expected).every(key=>Object.hasOwn(snapshot,key)&&Object.is(snapshot[key],expected[key])));
 }catch{return false;}
}
