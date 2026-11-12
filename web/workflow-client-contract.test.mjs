import test from 'node:test';
import assert from 'node:assert/strict';
import {WORKFLOW_CLIENT_CONTRACT,validateWorkflowClientPlan,validateWorkflowClientMedia,validateWorkflowClientInspection} from './workflow-client-contract.mjs';
import {readBoundedWorkflowClientOutput} from './production-workflow-client-stores.mjs';
const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64);
const media=()=>({width:360,height:640,frameCount:12,fpsNumerator:24,fpsDenominator:1,timelineSha256:A,hasAudio:true,audio:{packetSha256:A,timelineSha256:B,codecConfigSha256:C}});
const steps=[{id:'preclean',kind:'preclean'},{id:'base',kind:'base',dependsOn:'preclean'}];
const plan=()=>({id:'compose',contract:WORKFLOW_CLIENT_CONTRACT,beforeStepId:'base',cleanFromStepId:'preclean',source:{id:'source',sha256:A},mask:{id:'mask',sha256:B},media:media()});
const inspection=()=>({mime:'video/mp4',codec:'h264',inspectionLevel:'container-only',sha256:C,size:4096,...media(),presentationPts:['0/1',...Array(11).fill('1/24')]});

test('client plan is a single immutable preclean-to-primary edge without URLs or arbitrary fields',()=>{
 assert.deepEqual(validateWorkflowClientPlan(plan(),steps,'base'),plan());
 for(const change of [p=>p.source.url='https://example.com',p=>p.source.id='../file',p=>p.cleanFromStepId='base',p=>p.beforeStepId='other',p=>p.mask.id='source',p=>p.contract='future']){const p=plan();change(p);assert.throws(()=>validateWorkflowClientPlan(p,steps,'base'));}
});
test('client media bounds and exact original AAC proofs fail closed',()=>{
 assert.deepEqual(validateWorkflowClientMedia(media()),media());
 for(const change of [m=>m.width=3842,m=>m.frameCount=482,m=>m.fpsNumerator=60,m=>m.audio.packetSha256='',m=>m.hasAudio=false,m=>m.extra=true]){const m=media();change(m);assert.throws(()=>validateWorkflowClientMedia(m));}
 assert.equal(validateWorkflowClientMedia({...media(),hasAudio:false,audio:null}).hasAudio,false);
});
test('composed structure binds exact held hash, source clock and bit-identical AAC proof',()=>{
 assert.equal(validateWorkflowClientInspection(inspection(),media(),{role:'output',sha256:C}).sha256,C);
 for(const change of [x=>x.sha256=A,x=>x.timelineSha256=B,x=>x.presentationPts[0]='1/8',x=>x.audio.packetSha256=B,x=>x.audio.timelineSha256=A,x=>x.audio.codecConfigSha256=A,x=>x.size=16777217]){const x=inspection();change(x);assert.throws(()=>validateWorkflowClientInspection(x,media(),{role:'output',sha256:C}));}
 const silent={...inspection(),hasAudio:false,audio:null};assert.equal(validateWorkflowClientInspection(silent,media(),{role:'clean',sha256:C}).hasAudio,false);assert.throws(()=>validateWorkflowClientInspection(inspection(),media(),{role:'mask',sha256:C}));
});
test('client output reader bounds real bytes and snapshots mutable input before inspection',async()=>{
 const original=new Uint8Array(64).fill(7),copy=await readBoundedWorkflowClientOutput(original);original.fill(9);assert.equal(copy[0],7);
 for(const bytes of [new Uint8Array(31),new Uint8Array(16777217)])await assert.rejects(readBoundedWorkflowClientOutput(bytes));
 if(typeof SharedArrayBuffer!=='undefined')await assert.rejects(readBoundedWorkflowClientOutput(new Uint8Array(new SharedArrayBuffer(64))));
 const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(32));c.enqueue(new Uint8Array(32));c.close()}});assert.equal((await readBoundedWorkflowClientOutput(stream)).length,64);
});
test('client output stream deadline and byte overflow cancel an unpaid upload',async()=>{
 let cancelled=false;const hung=new ReadableStream({cancel(){cancelled=true}});await assert.rejects(readBoundedWorkflowClientOutput(hung,{timeoutMs:5}),/timed out/);assert.equal(cancelled,true);
 const huge=new ReadableStream({start(c){c.enqueue(new Uint8Array(16777217))}});await assert.rejects(readBoundedWorkflowClientOutput(huge),/size/);
 const uncooperative=new ReadableStream({cancel(){return new Promise(()=>{})}});await assert.rejects(readBoundedWorkflowClientOutput(uncooperative,{timeoutMs:5}),/timed out/);
 let sent=0;const fragmented=new ReadableStream({pull(c){c.enqueue(new Uint8Array(1));if(++sent===1025)c.close()}});await assert.rejects(readBoundedWorkflowClientOutput(fragmented),/chunk count/);
});
