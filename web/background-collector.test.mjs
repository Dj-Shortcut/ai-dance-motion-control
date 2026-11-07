import test from 'node:test';
import assert from 'node:assert/strict';
import {collectQueued} from './background-collector.mjs';
const id='39f68c0a-61df-4127-b53b-b685e8edfb84';
const origin='https://owner.example';
const empty={checked:0,completed:0,pending:0,needsReview:0,failed:0};
const makeDb=rows=>({prepare(sql){
 if(sql.startsWith('SELECT')){assert.match(sql,/j\.user_id=\? AND j\.state='queued'/);return {bind(owner,limit){assert.equal(owner,'owner');assert.equal(limit,4);return {async all(){return {results:rows}}}}}}
 assert.match(sql,/INSERT INTO rig_collector_attempts/);return {bind(_at,job,owner){assert.equal(owner,'owner');assert.equal(job,id);return {async run(){return {meta:{changes:1}}}}}};
}});
const args=rows=>({enabled:true,db:makeDb(rows),owner:'owner',origin});
test('disabled collection performs no database or provider calls',async()=>assert.deepEqual(await collectQueued({enabled:false}),empty));
test('owner collection calls existing handler and records confirmed completion',async()=>{
 const calls=[];const result=await collectQueued({...args([{id,user_id:'owner'}]),handler:async r=>{calls.push({url:r.url,method:r.method});return Response.json({id,state:'completed'})}});
 assert.deepEqual(result,{...empty,checked:1,completed:1});assert.deepEqual(calls,[{url:`${origin}/api/generations/${id}`,method:'GET'}]);
});
test('pending and uncertain states are not reported as completion',async()=>{
 for(const state of ['queued','processing','unknown','needs_review','failed']){
  const result=await collectQueued({...args([{id,user_id:'owner'}]),handler:async()=>Response.json({id,state})});
  assert.equal(result.completed,0);assert.equal(result[state==='queued'||state==='processing'?'pending':'needsReview'],1);
 }
});
test('other users and malformed IDs never reach the handler',async()=>{
 let calls=0;const result=await collectQueued({...args([{id,user_id:'other'},{id:'bad',user_id:'owner'}]),handler:async()=>{calls++;return new Response()}});
 assert.deepEqual(result,{...empty,failed:2});assert.equal(calls,0);
});
test('failed, malformed or mismatched replies are counted for a later retry',async()=>{
 for(const handler of [async()=>new Response('down',{status:503}),async()=>new Response('not json'),async()=>Response.json({id:'other',state:'completed'}),async()=>Response.json({id,state:'invented'}),async()=>new Response('x'.repeat(8193))]){
  const result=await collectQueued({...args([{id,user_id:'owner'}]),handler});assert.deepEqual(result,{...empty,failed:1});
 }
});
test('malformed origin, excessive work and missing owner fail closed',async()=>{
 for(const values of [{origin:'https://owner.example/path'},{limit:5},{owner:'../x'}])await assert.rejects(collectQueued({...args([]),handler:async()=>new Response(),...values}));
});
