// Inactive server/browser boundary. Metadata proves container structure and
// packet identity, never that client-composited pixels have a visual property.
export const WORKFLOW_CLIENT_CONTRACT='rig-client-mask-compose-v1';
export const WORKFLOW_CLIENT_LIMITS=Object.freeze({source:16*1024*1024,clean:64*1024*1024,mask:2*1024*1024,output:16*1024*1024});
const SHA=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9_-]{1,100}$/,STEP=/^[a-z][a-z0-9-]{0,31}$/;
const exact=(o,k)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).length===k.length&&k.every(x=>Object.hasOwn(o,x));
const integer=(n,a,b)=>Number.isSafeInteger(n)&&n>=a&&n<=b;
export function validateWorkflowClientPlan(value,steps,baseStepId){
 if(!exact(value,['id','contract','beforeStepId','cleanFromStepId','source','mask','media'])||!STEP.test(value.id)||value.contract!==WORKFLOW_CLIENT_CONTRACT||value.beforeStepId!==baseStepId)throw Error('Invalid client processing plan');
 const base=steps.find(s=>s.id===baseStepId),clean=steps.find(s=>s.id===value.cleanFromStepId);
 if(!base||!clean||clean.kind!=='preclean'||base.dependsOn!==clean.id)throw Error('Client processing must precede the primary step');
 for(const ref of [value.source,value.mask])if(!exact(ref,['id','sha256'])||!ID.test(ref.id)||!SHA.test(ref.sha256))throw Error('Invalid client artifact binding');
 if(value.source.id===value.mask.id)throw Error('Distinct client input artifacts required');
 validateWorkflowClientMedia(value.media);
 return structuredClone(value);
}
export function validateWorkflowClientMedia(value){
 if(!exact(value,['width','height','frameCount','fpsNumerator','fpsDenominator','timelineSha256','hasAudio','audio'])||!integer(value.width,340,3840)||!integer(value.height,340,3840)||value.width%2||value.height%2||!integer(value.frameCount,9,481)||![24,25,30].includes(value.fpsNumerator)||value.fpsDenominator!==1||!SHA.test(value.timelineSha256)||typeof value.hasAudio!=='boolean')throw Error('Invalid client media clock');
 if(value.hasAudio){if(!exact(value.audio,['packetSha256','timelineSha256','codecConfigSha256'])||!Object.values(value.audio).every(s=>SHA.test(s)))throw Error('Invalid original audio binding');}
 else if(value.audio!==null)throw Error('Unexpected original audio binding');
 return structuredClone(value);
}
export function workflowClientMedia(inspection){
 const value={width:inspection.width,height:inspection.height,frameCount:inspection.frameCount,fpsNumerator:inspection.fpsNumerator,fpsDenominator:inspection.fpsDenominator,timelineSha256:inspection.timelineSha256,hasAudio:inspection.hasAudio,audio:inspection.hasAudio?{packetSha256:inspection.audio?.packetSha256,timelineSha256:inspection.audio?.timelineSha256,codecConfigSha256:inspection.audio?.codecConfigSha256}:null};
 return validateWorkflowClientMedia(value);
}
export function validateWorkflowClientInspection(inspection,expected,{role,sha256}={}){
 validateWorkflowClientMedia(expected);
 if(!Object.hasOwn(WORKFLOW_CLIENT_LIMITS,role)||!inspection||inspection.inspectionLevel!=='container-only'||inspection.mime!=='video/mp4'||inspection.codec!=='h264'||!SHA.test(inspection.sha256||'')||sha256&&inspection.sha256!==sha256||!integer(inspection.size,32,WORKFLOW_CLIENT_LIMITS[role]))throw Error('Client artifact bytes do not match');
 for(const key of ['width','height','frameCount','fpsNumerator','fpsDenominator','timelineSha256'])if(inspection[key]!==expected[key])throw Error('Client artifact clock does not match');
 // Browser normalization promises CFR beginning at zero. The timeline hash also
 // binds all PTS/durations; do not infer the first PTS from a frame count.
 if(!Array.isArray(inspection.presentationPts)||inspection.presentationPts.length!==expected.frameCount||inspection.presentationPts[0]!=='0/1')throw Error('Client processing requires a zero-start timeline');
 if(role==='source'||role==='output'){
  if(inspection.hasAudio!==expected.hasAudio)throw Error('Client artifact audio does not match');
  if(expected.hasAudio&&['packetSha256','timelineSha256','codecConfigSha256'].some(k=>inspection.audio?.[k]!==expected.audio[k]))throw Error('Original audio packets or timing changed');
 }else if(inspection.hasAudio)throw Error('Clean and mask artifacts must be silent');
 return inspection;
}
