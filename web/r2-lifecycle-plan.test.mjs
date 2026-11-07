import {test} from 'node:test';import assert from 'node:assert/strict';import {planInputExpiry} from './r2-lifecycle-plan.mjs';
test('adds only the scoped 24-hour rule while preserving default multipart expiry',()=>{
 const prior=[{id:'Default Multipart Abort Rule',enabled:true,conditions:{prefix:''},abortMultipartUploadsTransition:{condition:{type:'Age',maxAge:604800}}}];const plan=planInputExpiry({bucket:'rig-test-private',rules:prior});assert.equal(plan.changed,true);assert.deepEqual(plan.rules[0],prior[0]);assert.equal(plan.rules[1].conditions.prefix,'rig-inputs/');assert.equal(plan.rules[1].deleteObjectsTransition.condition.maxAge,86400);assert.equal(prior.length,1);assert.equal(planInputExpiry({bucket:'rig-test-private',rules:plan.rules}).changed,false);
});
test('refuses wrong bucket or a conflicting or duplicate rule',()=>{
 assert.throws(()=>planInputExpiry({bucket:'leaderbot-images',rules:[]}));const other={id:'rig-inputs-expire-after-24-hours',enabled:true,conditions:{prefix:''},deleteObjectsTransition:{condition:{type:'Age',maxAge:86400}}};assert.throws(()=>planInputExpiry({bucket:'rig-test-private',rules:[other]}));assert.throws(()=>planInputExpiry({bucket:'rig-test-private',rules:[other,other]}));
});
