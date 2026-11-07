import {test} from 'node:test';import assert from 'node:assert/strict';
import {diagnoseMp4,diagnosticCodes} from './mp4-diagnostic.mjs';
test('malformed inputs remain bounded and cannot inject diagnostic output',()=>{
 for(const bytes of [new Uint8Array(0),new Uint8Array(64),new Uint8Array(17*1024*1024)]){
  const result=diagnoseMp4(bytes,'private filename, user data or provider error');
  assert.ok(result.includes('structure'));assert.ok(result.length<=12);assert.ok(result.every(x=>diagnosticCodes.includes(x)));assert.ok(!JSON.stringify(result).includes('private'));
 }
});
