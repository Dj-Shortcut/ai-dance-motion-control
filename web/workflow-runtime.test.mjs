import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowHeldBytes,hasWorkflow} from './workflow-runtime.mjs';
import {WORKFLOW_RESULT_LIMIT} from './workflow-fal-adapter.mjs';
const stream=chunks=>new ReadableStream({start(c){for(const b of chunks)c.enqueue(b);c.close()}});
test('known private object sizes are bounded before a read and preserve exact single-buffer bytes',async()=>{
 let reads=0;const neverRead={getReader(){reads++;throw Error('Must not read')}};
 for(const n of [0,31,WORKFLOW_RESULT_LIMIT+1,Number.MAX_SAFE_INTEGER])await assert.rejects(workflowHeldBytes(neverRead,WORKFLOW_RESULT_LIMIT,n),{code:'workflow_body_too_large'});
 assert.equal(reads,0);const bytes=Uint8Array.from({length:80},(_,i)=>i);
 assert.deepEqual(await workflowHeldBytes(stream([bytes.subarray(0,40),bytes.subarray(40)]),100,80),bytes);
 await assert.rejects(workflowHeldBytes(stream([bytes]),100,81),{code:'workflow_body_size_changed'});
 await assert.rejects(workflowHeldBytes(stream([bytes]),100,79),{code:'workflow_body_too_large'});
});
test('untrusted chunks cannot exceed count/byte limits or share mutable cross-thread buffers',async()=>{
 await assert.rejects(workflowHeldBytes(stream([new Uint8Array(11)]),10),{code:'workflow_body_too_large'});
 await assert.rejects(workflowHeldBytes(stream(Array.from({length:1025},()=>new Uint8Array(1))),2000),{code:'workflow_body_too_large'});
 if(typeof SharedArrayBuffer!=='undefined')await assert.rejects(workflowHeldBytes(stream([new Uint8Array(new SharedArrayBuffer(40))]),100),{code:'workflow_body_too_large'});
});
test('any persisted workflow marker is claimed, including null/malformed versions, while unrelated legacy quotes remain unrelated',()=>{
 for(const workflow of [null,{},false,{version:'old'}])assert.equal(hasWorkflow({input:{workflow}}),true);
 for(const q of [null,{}, {input:{}},{input:{data:{quality:'human-recast'}}}])assert.ok(!hasWorkflow(q));
});
