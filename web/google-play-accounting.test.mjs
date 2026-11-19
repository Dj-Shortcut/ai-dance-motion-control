// Synthetic report rows only. No Google, Fal, mail, or bank requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGooglePlayAccounting,handleGooglePlayAccounting} from './google-play-accounting.mjs';
const OWNER='u-12345678-1234-4123-8123-123456789abc',OTHER='u-22345678-1234-4123-8123-123456789abc',origin='https://rig.example';
const amount=(units,nanos=0)=>({currencyCode:'EUR',units:String(units),nanos});
const financial=overrides=>JSON.stringify({version:1,source:'google_order_v1',mode:'live',productId:'rig_credit_5',orderId:'GPA.fixture',state:'PROCESSED',currency:'EUR',total:amount(8,990000001),tax:amount(1,500000000),developerRevenueInBuyerCurrency:amount(6,123456789),partialRefundEvents:[],...overrides});
const row=overrides=>({token_hash:'a'.repeat(64),user_id:OWNER,product_id:'rig_credit_5',credit_cents:500,state:'credited',consumed:1,finance_json:financial(),credit_finance_json:financial(),created_at:1795080000000,updated_at:1795080000001,...overrides});
function fixture({receipts=[],claims=[],reversals=[],mode='live',version='rig-google-play-v1',limit=true,tenantValue,tenantError=false,batchError=false}={}){
 const calls=[];const db={prepare(sql){calls.push(sql);return {sql,args:[],bind(...args){return {...this,args}},async first(){return sql.includes('rig_payment_environment')?{mode}:{version}}}},async batch(statements){calls.push(...statements);if(batchError)throw Error('private-db-detail');return [receipts,claims,reversals].map(results=>({success:true,results}))}};
 const env={DB:{test:true},PRODUCTION_DB:db,RIG_PRODUCTION_OWNER_USER_ID:OWNER};
 const handle=createGooglePlayAccounting({tenant:async()=>{if(tenantError)throw Error('private-tenant');return tenantValue===undefined?{DB:db,RIG_MODE:'live',RIG_PUBLIC_ORIGIN:origin}:tenantValue},limiter:async()=>limit});
 const request=(path='/api/owner/accounting/google-play',options={})=>handle(new Request(origin+path,{method:options.method??'GET'}),env,{userId:options.userId??OWNER});
 return {calls,db,env,handle,request};
}
test('requires exact owner before any database access and never returns provider details',async()=>{
 const f=fixture({receipts:[row()]});const denied=await f.request(undefined,{userId:OTHER});assert.equal(denied.status,403);assert.deepEqual(f.calls,[]);
 const raw=await handleGooglePlayAccounting(new Request(origin+'/api/owner/accounting/google-play'),{RIG_PRODUCTION_OWNER_USER_ID:OWNER},{userId:OWNER});assert.equal(raw.status,503);
 f.env.RIG_PRODUCTION_OWNER_USER_ID='owner';assert.equal((await f.request()).status,403);
});
test('keeps decimal nanos exact and separates credit face from Google gross, tax and developer revenue',async()=>{
 const r=row(),f=fixture({receipts:[r],claims:[{...r,ledger_proved:1}]});const response=await f.request(),value=await response.json();assert.equal(response.status,200);
 assert.equal(value.providerGross.amount.decimal,'8.990000001');assert.equal(value.providerTax.amount.decimal,'1.500000000');assert.equal(value.providerDeveloperRevenue.amount.decimal,'6.123456789');assert.equal(value.providerFeesDerived.amount.decimal,'1.366543212');
 assert.equal(value.issuedCreditCents,500);assert.equal(value.reversedCreditCents,0);assert.equal(value.payoutReconciled,false);assert.equal(value.actualBankPayout,null);assert.equal(value.actualProfit,null);assert.equal(value.formalAccountingComplete,false);assert.equal(value.automaticAccountableImport,false);assert.equal(value.automaticPeppolDelivery,false);assert.equal(value.invoiceCreated,false);
 assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
});
test('unknown tax, fees and missing or malformed finance remain unknown instead of invented from wallet credit',async()=>{
 const one=row({credit_finance_json:financial({tax:null})}),two=row({token_hash:'b'.repeat(64),credit_finance_json:null,finance_json:null});const f=fixture({receipts:[one,two]});const value=await(await f.request()).json();
 assert.equal(value.providerGross.amount,null);assert.equal(value.providerGross.knownSubtotal.decimal,'8.990000001');assert.equal(value.providerGross.unknownCount,1);assert.equal(value.providerTax.unknownCount,2);assert.equal(value.providerFeesDerived.unknownCount,2);assert.equal(value.invalidFinancialRecordCount,1);
 assert.equal(value.purchases[1].googleGross,null);assert.equal(value.purchases[1].googleDeveloperRevenue,null);
});
test('original grant snapshot preserves fees while latest verified full refund is distinct from wallet reversal',async()=>{
 const latest=financial({state:'REFUNDED',developerRevenueInBuyerCurrency:amount(0,-1),refundEvent:{total:amount(8,990000001)},partialRefundEvents:[]});const r=row({state:'reversed',finance_json:latest}),f=fixture({receipts:[r],claims:[{...r,ledger_proved:1}],reversals:[{...r,reason:'refunded',ledger_proved:1}]});
 const value=await(await f.request()).json();assert.equal(value.providerDeveloperRevenue.amount.decimal,'6.123456789');assert.equal(value.providerFeesDerived.amount.decimal,'1.366543212');assert.equal(value.purchases[0].latestGoogleDeveloperRevenue.decimal,'-0.000000001');assert.equal(value.providerVerifiedCashRefunds.amount.decimal,'8.990000001');assert.equal(value.issuedCreditCents,500);assert.equal(value.reversedCreditCents,500);assert.equal(value.actualBankPayout,null);
});
test('latest refund-adjusted net cannot turn refunds into invented service fees',async()=>{
 const r=row({credit_finance_json:null,finance_json:financial({state:'PARTIALLY_REFUNDED',developerRevenueInBuyerCurrency:amount(4),partialRefundEvents:[{state:'PROCESSED_SUCCESSFULLY',total:amount(1,123456789)},{state:'PENDING',total:amount(2)}]})});const value=await(await fixture({receipts:[r]}).request()).json();
 assert.equal(value.providerFeesDerived.amount,null);assert.equal(value.providerVerifiedCashRefunds.amount.decimal,'1.123456789');
 const ambiguous=row({finance_json:financial({state:'REFUNDED',refundEvent:{total:amount(8,990000001)},partialRefundEvents:[{state:'PROCESSED_SUCCESSFULLY',total:amount(1)}]})});assert.equal((await(await fixture({receipts:[ambiguous]}).request()).json()).providerVerifiedCashRefunds.amount,null);
});
test('pending and cancelled Google orders are not reported as processed revenue',async()=>{
 for(const state of ['PENDING','CANCELED']){const r=row({credit_finance_json:null,finance_json:financial({state})});const value=await(await fixture({receipts:[r]}).request()).json();assert.equal(value.providerGross.amount,null);assert.equal(value.providerDeveloperRevenue.amount,null);assert.equal(value.issuedCreditCents,0);}
});
test('duplicate or mismatching Google order identities never double the known cash totals or refunds',async()=>{
 const r=row(),duplicate=row({token_hash:'b'.repeat(64)});const value=await(await fixture({receipts:[r,duplicate]}).request()).json();assert.equal(value.providerGross.amount,null);assert.equal(value.providerGross.knownSubtotal.decimal,'8.990000001');assert.equal(value.providerVerifiedCashRefunds.unknownCount,1);assert.equal(value.purchases[1].evidence,'duplicate-order-reference');
 const mismatch=row({finance_json:financial({orderId:'GPA.other',refundEvent:{total:amount(1)}})});const v=await(await fixture({receipts:[mismatch]}).request()).json();assert.equal(v.providerVerifiedCashRefunds.amount,null);assert.equal(v.purchases[0].latestGoogleDeveloperRevenue,null);assert.equal(v.invalidFinancialRecordCount,1);
});
test('rejects unsupported currency, inconsistent Money, impossible amounts and non-normalized records',async()=>{
 const cases=[{currency:'USD'},{mode:'test'},{productId:'rig_credit_25'},{total:amount(-1)},{total:amount('1',-1)},{total:amount('1',1000000000)},{total:{...amount(1),units:1}},{total:amount('01')},{tax:amount(9)},{developerRevenueInBuyerCurrency:amount(10)},{partialRefundEvents:[{state:'MADE_UP',total:amount(1)}]}];
 for(const overrides of cases){const r=row({credit_finance_json:null,finance_json:financial(overrides)});const v=await(await fixture({receipts:[r]}).request()).json();assert.equal(v.providerGross.amount,null);assert.equal(v.invalidFinancialRecordCount,1);}
});
test('CSV distinguishes order/credit/reversal events, neutralizes formulas and never exports purchase secrets',async()=>{
 const r=row({finance_json:financial({orderId:'=HYPERLINK("https://evil.invalid")'}),credit_finance_json:null});const f=fixture({receipts:[r],claims:[{...r,ledger_proved:1}],reversals:[{...r,reason:'refunded',ledger_proved:1}]});const response=await f.request('/api/owner/accounting/export/google-play.csv?month=2026-11'),text=await response.text();
 assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'text/csv; charset=utf-8');assert.match(response.headers.get('content-disposition'),/RIG-Google-Play-2026-11.csv/);assert.match(text,/"'=HYPERLINK\(""https:\/\/evil.invalid""\)"/);assert.match(text,/8\.990000001;1\.500000000;6\.123456789;1\.366543212/);
 const lines=text.trim().split('\r\n');assert.equal(lines.length,4);assert.match(lines[1],/google-order-observed/);assert.match(lines[2],/rig-credit-issued/);assert.match(lines[3],/rig-credit-reversed/);assert.doesNotMatch(lines[2],/8\.990000001/);assert.doesNotMatch(lines[3],/8\.990000001/);assert.doesNotMatch(text,/purchaseToken|sealed_token|account_id|finance_json|Mollie/i);
});
test('filters each event by Brussels calendar month, including DST and independent claim/reversal times',async()=>{
 const f=fixture();const response=await f.request('/api/owner/accounting/google-play?month=2026-03'),value=await response.json();assert.equal(response.status,200);assert.equal(value.period.start,Date.parse('2026-02-28T23:00:00Z'));assert.equal(value.period.end,Date.parse('2026-03-31T22:00:00Z'));assert.equal(value.period.basis,'RIG-recorded-events-not-tax-point');
 const statements=f.calls.filter(v=>typeof v==='object');assert.equal(statements.length,3);assert.match(statements[0].sql,/r\.created_at>=\?/);assert.match(statements[1].sql,/c\.created_at>=\?/);assert.match(statements[2].sql,/v\.created_at>=\?/);for(const statement of statements)assert.deepEqual(statement.args,[value.period.start,value.period.start,value.period.end,value.period.end,5001]);
 const december=await(await fixture().request('/api/owner/accounting/google-play?month=2026-12')).json();assert.equal(december.period.end,Date.parse('2026-12-31T23:00:00Z'));
});
test('rejects invalid routes, methods and ambiguous query strings before any read',async()=>{
 const f=fixture();for(const suffix of ['?month=2026-00','?month=2026-13','?month=2026-1','?month=2026-01&month=2026-02','?month=2026-01&extra=1','?token=secret','?month=2026%2d01'])assert.equal((await f.request('/api/owner/accounting/google-play'+suffix)).status,400);
 assert.equal((await f.request('/api/owner/accounting/google-play/',{})).status,404);assert.equal((await f.request(undefined,{method:'POST'})).status,404);assert.deepEqual(f.calls,[]);
});
test('requires distinct live production database, exact origin, current schema and healthy rate limiter',async()=>{
 for(const options of [{mode:'test'},{version:'old'},{tenantValue:null},{tenantError:true},{batchError:true}])assert.equal((await fixture(options).request()).status,503);
 const same=fixture();same.env.DB=same.env.PRODUCTION_DB;assert.equal((await same.request()).status,503);
 const wrong=fixture();assert.equal((await wrong.handle(new Request('https://evil.invalid/api/owner/accounting/google-play'),wrong.env,{userId:OWNER})).status,503);
 assert.equal((await fixture({limit:false}).request()).status,429);
});
test('returns no partial results when row limit or wallet ledger invariants fail',async()=>{
 assert.equal((await fixture({receipts:Array(5001).fill(row())}).request()).status,413);
 for(const options of [{claims:[{...row(),ledger_proved:0}]},{reversals:[{...row(),reason:'refunded',ledger_proved:0}]},{receipts:[row({consumed:2})]},{receipts:[row({token_hash:'not-a-hash'})]}]){const response=await fixture(options).request();assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private-db-detail|Invariant|token_hash/);}
});
