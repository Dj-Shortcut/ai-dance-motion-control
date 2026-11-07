import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handlePaymentRoute} from './payment.mjs';
const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));sql.exec("INSERT INTO rig_payment_environment(id,mode) VALUES(1,'test')");
class D1{prepare(q){let values=[];return{bind(...v){values=v;return this},async first(){return sql.prepare(q).get(...values)??null},async run(){let r=sql.prepare(q).run(...values);return{meta:{changes:Number(r.changes)}}},async all(){return{results:sql.prepare(q).all(...values)}}}}async batch(list){sql.exec('BEGIN');try{const results=[];for(const stmt of list)results.push(await stmt.run());sql.exec('COMMIT');return results}catch(e){sql.exec('ROLLBACK');throw e}}}
const env={DB:new D1(),MOLLIE_API_KEY:'test_x',RIG_MOLLIE_MODE:'test',RIG_PUBLIC_ORIGIN:'https://rig.example',RIG_WEBHOOK_URL:'https://webhook.example/mollie',RIG_PACKAGES:JSON.stringify([{id:'pack',amountCents:500,credits:500}])};
const originalFetch=globalThis.fetch;let calls=0,reply;
globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.mollie.com/v2/payments');assert.equal(options.method,'POST');calls++;return reply(options)};
after(()=>{globalThis.fetch=originalFetch;sql.close()});
function create(user,key){return handlePaymentRoute(new Request('https://rig.example/api/payments/create',{method:'POST',headers:{origin:'https://rig.example','content-type':'application/json'},body:JSON.stringify({packageId:'pack',requestId:key})}),env,user)}
function order(user){return sql.prepare('SELECT state,payment_id FROM rig_orders WHERE user_id=? ORDER BY rowid DESC LIMIT 1').get(user)}
const err=(status,extra={})=>Response.json({status,title:'Rejected',detail:'TOP SECRET PROVIDER DETAIL',...extra},{status});
test('documented 422 is terminal, reveals no provider text, and permits a fresh user-initiated attempt',async()=>{
 const before=calls;reply=async()=>err(422);let r=await create('u422','request_422_first');assert.equal(r.status,422);assert.doesNotMatch(await r.text(),/TOP SECRET|terminal|422/);assert.equal(order('u422').state,'failed');assert.equal(order('u422').payment_id,null);assert.equal(calls,before+1);
 reply=async()=>Response.json({id:'tr_ABC123456',mode:'test',_links:{checkout:{href:'https://www.mollie.com/checkout/example'}}});r=await create('u422','request_422_second');assert.equal(r.status,200);assert.equal(order('u422').state,'open');assert.equal(calls,before+2);
});
test('other 4xx remain uncertain without automatic retries',async()=>{for(const status of [400,401,403,404,405,410,415,429]){const user=`u${status}`,before=calls;reply=async()=>err(status);const r=await create(user,`request_case_${status}`);assert.equal(r.status,503);assert.equal(order(user).state,'unknown');assert.equal(calls,before+1)}});
test('timeout, duplicate conflict, server failure, malformed and mismatched responses remain unknown',async()=>{
 const cases=[['timeout',async()=>{throw Error('timeout')}],['408',async()=>err(408)],['409',async()=>err(409)],['500',async()=>err(500)],['html',async()=>new Response('bad gateway',{status:422,headers:{'content-type':'text/html'}})],['malformed',async()=>new Response('{',{status:422,headers:{'content-type':'application/json'}})],['mismatch',async()=>err(422,{status:500})]];
 for(const [name,fn] of cases){const user=`uncertain_${name}`,before=calls;reply=fn;const r=await create(user,`request_uncertain_${name}`);assert.equal(r.status,503,name);assert.equal(order(user).state,'unknown',name);assert.equal(calls,before+1,name)}
});
test('a concurrent provider identity or terminal state cannot be overwritten by a rejection',async()=>{
 reply=async options=>{const id=JSON.parse(options.body).metadata.order_id;sql.prepare("UPDATE rig_orders SET state='paid',payment_id='tr_RACE12345' WHERE id=?").run(id);return err(422)};
 const r=await create('race','request_race_12345');assert.equal(r.status,503);assert.deepEqual({...order('race')},{state:'paid',payment_id:'tr_RACE12345'});
});
