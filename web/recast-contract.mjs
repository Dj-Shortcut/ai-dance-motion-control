// Fixed, owner-validation contract. A client cannot select another tier/model.
export const RECAST_QUALITY='human-recast';
export const RECAST_MODEL='minimax/h3-max/recast';
export const RECAST_QUEUE_FAMILY='minimax/h3-max';
export const RECAST_PROVIDER_CONTRACT='human-recast-v1';
export const RECAST_RESOLUTION='768P';
export const RECAST_MIN_DURATION=5;
export const RECAST_MAX_DURATION=15;
export const RECAST_SETTINGS=Object.freeze({resolution:RECAST_RESOLUTION,enhance_realism:true,enable_safety_checker:true});
export function validRecastSettings(value){
 return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===3&&value.resolution===RECAST_RESOLUTION&&value.enhance_realism===true&&value.enable_safety_checker===true;
}
export function validRecastVideo(video){
 return video?.durationVerified===true&&Number.isFinite(video.durationSeconds)&&video.durationSeconds>=RECAST_MIN_DURATION&&video.durationSeconds<=RECAST_MAX_DURATION;
}
