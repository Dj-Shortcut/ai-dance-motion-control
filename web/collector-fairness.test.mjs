import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {collectQueued} from './background-collector.mjs';

test('older persistently queued jobs cannot permanently block later jobs',async()=>{
 const sql=new DatabaseSync(':memory:');
 try{
  sql.exec("CREATE TABLE rig_generation_jobs(id TEXT PRIMARY KEY,user_id TEXT,state TEXT,created_at INTEGER)");
  sql.exec(readFileSync(new URL('./cloudflare-migrations/0003_test_collector_fairness.sql',import.meta.url),'utf8'));
  const ids=Array.from({length:6},(_,i)=>`123e4567-e89b-42d3-a456-${String(i).padStart(12,'0')}`);
  const insert=sql.prepare('INSERT INTO rig_generation_jobs VALUES(?,?,?,?)');
  ids.forEach((id,i)=>insert.run(id,'owner','queued',i));
  const other='123e4567-e89b-42d3-a456-999999999999';insert.run(other,'other','queued',0);
  const db={prepare(q){let args=[];return {bind(...v){args=v;return this},async all(){return {results:sql.prepare(q).all(...args)}},async run(){return {meta:{changes:Number(sql.prepare(q).run(...args).changes)}}}}}};
  let now=1000;const calls=[];
  const args={enabled:true,db,owner:'owner',origin:'https://owner.example',clock:()=>now++,handler:async req=>{
   const id=new URL(req.url).pathname.split('/').at(-1);calls.push(id);
   if(id===ids[0])return new Response('temporary failure',{status:503});
   return Response.json({id,state:'processing'});
  }};
  const first=await collectQueued(args);assert.equal(first.failed,1);assert.deepEqual(calls,ids.slice(0,4));
  await collectQueued(args);
  assert.deepEqual(calls.slice(4,6),ids.slice(4,6));assert.equal(new Set(calls).size,6);assert.ok(!calls.includes(other));
 }finally{sql.close()}
});
