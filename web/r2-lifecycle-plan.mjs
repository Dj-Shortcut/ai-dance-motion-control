// Pure planning only: never talks to Cloudflare or modifies a bucket.
// Cloudflare lifecycle PUT replaces the complete rule list. Read current rules
// first and preserve them unchanged. Do not apply this plan as a blind PUT.
const ID='rig-inputs-expire-after-24-hours',PREFIX='rig-inputs/',SECONDS=86400;
const newRule=()=>({id:ID,enabled:true,conditions:{prefix:PREFIX},deleteObjectsTransition:{condition:{type:'Age',maxAge:SECONDS}}});
export function planInputExpiry({bucket,rules}){
 if(bucket!=='rig-test-private'||!Array.isArray(rules)||rules.length>=1000)throw Error('unexpected bucket or rules');
 if(rules.some(x=>!x||typeof x!=='object'||typeof x.id!=='string'))throw Error('invalid rules');
 const existing=rules.filter(x=>x.id===ID);if(existing.length>1)throw Error('duplicate rule');
 if(existing.length){const r=existing[0];if(r.enabled!==true||r.conditions?.prefix!==PREFIX||r.deleteObjectsTransition?.condition?.type!=='Age'||r.deleteObjectsTransition.condition.maxAge!==SECONDS||r.abortMultipartUploadsTransition||r.storageClassTransitions?.length)throw Error('conflicting existing rule');return {rules:structuredClone(rules),changed:false};}
 return {rules:[...structuredClone(rules),newRule()],changed:true};
}
