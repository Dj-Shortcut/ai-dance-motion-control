// Server-only, inactive provider contract. This does not expose a route, enable
// cleanup, attest client pixels, or dispatch a paid request. Callers must first
// resolve owned bytes and run the trusted workflow MP4 inspector.
import {providerJSON} from './provider-response.mjs';

export const OVERLAY_CLEANUP_MODEL='fal-ai/ltx-2.3-quality/inpaint';
export const OVERLAY_CLEANUP_QUEUE_FAMILY='fal-ai/ltx-2.3-quality';
export const OVERLAY_CLEANUP_CONTRACT='overlay-cleanup-ltx-quality-v1';
export const OVERLAY_CLEANUP_BILLING=Object.freeze({
 id:'ltx-quality-inpaint-megapixels-20261110',endpoint:OVERLAY_CLEANUP_MODEL,
 currency:'USD',unit:'megapixels',unitPrice:0.0024075,
 // Integer nanodollars avoid rounding this half-microdollar unit down.
 nanosPerMegapixel:2407500,estimateRounding:'ceil-total-megapixels'
});
export const OVERLAY_CLEANUP_SETTINGS=Object.freeze({
 num_inference_steps:30,video_strength:1,guidance_scale:1,
 generate_audio:false,enable_prompt_expansion:false,
 enable_safety_checker:true,video_quality:'maximum',
 video_write_mode:'balanced',sync_mode:false
});
const PROMPT='Remove the masked text, letters, subtitles, logos, watermarks, social-media icons, reaction counters and player controls. Reconstruct the matching background behind them. Preserve the original person, face, hands, real objects, body movement, camera framing, camera movement and scene timing. Do not add any text, icons or new objects.';
const HASH=/^[a-f0-9]{64}$/;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(a,b)=>object(a)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(b).every(k=>Object.hasOwn(a,k)&&Object.is(a[k],b[k]));
export const validOverlayCleanupSettings=x=>exact(x,OVERLAY_CLEANUP_SETTINGS);

export async function getOverlayCleanupPricePreflight(key,fetchImpl=fetch){
 if(typeof key!=='string'||!key||key.length>1024||/[\r\n]/.test(key))throw Error('Cleanup pricing unavailable');
 const signal=AbortSignal.timeout(10000),url=new URL('https://api.fal.ai/v1/models/pricing');
 url.searchParams.set('endpoint_id',OVERLAY_CLEANUP_MODEL);
 const response=await fetchImpl(url.href,{method:'GET',redirect:'manual',signal,headers:{Authorization:`Key ${key}`,Accept:'application/json'}});
 if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw Error('Cleanup pricing unavailable');
 const body=await providerJSON(response,{signal,limit:65536});
 const matches=Array.isArray(body?.prices)?body.prices.filter(x=>x?.endpoint_id===OVERLAY_CLEANUP_MODEL):[];
 if(matches.length!==1||matches[0].unit!=='megapixels'||matches[0].currency!=='USD'||matches[0].unit_price!==OVERLAY_CLEANUP_BILLING.unitPrice)throw Error('Cleanup billing requires review');
 return {...OVERLAY_CLEANUP_BILLING};
}

function geometry(media){
 if(!object(media)||media.inspectionLevel!=='container-only'||media.geometryVerified!=='avc-sps'||media.mime!=='video/mp4'||media.codec!=='h264'||!HASH.test(media.sha256||'')||!HASH.test(media.timelineSha256||'')||!Number.isSafeInteger(media.size)||media.size<32||media.size>64*1024*1024||!Number.isSafeInteger(media.width)||!Number.isSafeInteger(media.height)||media.width<340||media.height<340||media.width>3840||media.height>3840||!Number.isSafeInteger(media.frameCount)||media.frameCount<9||media.frameCount>481||![24,25,30].includes(media.fpsNumerator)||media.fpsDenominator!==1||typeof media.hasAudio!=='boolean'||!Array.isArray(media.presentationPts)||media.presentationPts.length!==media.frameCount||media.presentationPts[0]!=='0/1')throw Error('Cleanup media requires exact verified timing');
 return {width:media.width,height:media.height,frameCount:media.frameCount,fpsNumerator:media.fpsNumerator,fpsDenominator:1};
}

export function estimateOverlayCleanup(media,billing){
 const g=geometry(media);
 if(!exact(billing,OVERLAY_CLEANUP_BILLING))throw Error('Cleanup billing requires review');
 const pixels=BigInt(g.width)*BigInt(g.height)*BigInt(g.frameCount);
 // Conservative quote convention. The API states megapixels but does not
 // expose the final billed rounding; this is not actual Fal usage reconciliation.
 const billedMegapixels=(pixels+999999n)/1000000n;
 const micros=(billedMegapixels*BigInt(billing.nanosPerMegapixel)+999n)/1000n;
 if(micros<=0n||micros>6000000n)throw Error('Cleanup exceeds provider budget');
 return {providerEstimateUsdMicros:Number(micros),billedMegapixels:Number(billedMegapixels),pixelFrames:pixels.toString(),billing:{...billing}};
}

export function createOverlayCleanupPlan({source,mask,maskSourceSha256,billing,baseProviderEstimateUsdMicros,maxProviderUsdMicros=6000000}){
 const g=geometry(source),m=geometry(mask);
 if(source.size>16*1024*1024||mask.size>2*1024*1024||mask.hasAudio||maskSourceSha256!==source.sha256||mask.timelineSha256!==source.timelineSha256||Object.keys(g).some(k=>g[k]!==m[k]))throw Error('Cleanup mask does not match owned source');
 if(!Number.isSafeInteger(baseProviderEstimateUsdMicros)||baseProviderEstimateUsdMicros<=0||!Number.isSafeInteger(maxProviderUsdMicros)||maxProviderUsdMicros<=0||maxProviderUsdMicros>6000000)throw Error('Invalid combined provider budget');
 const audio=source.hasAudio?{packetSha256:source.audioPacketSha256,timelineSha256:source.audio?.timelineSha256,decoderConfigSha256:source.audio?.codecConfigSha256}:null;
 if(audio&&Object.values(audio).some(v=>!HASH.test(v||'')))throw Error('Original audio requires verified packets, timing and codec configuration');
 const estimate=estimateOverlayCleanup(source,billing),combined=baseProviderEstimateUsdMicros+estimate.providerEstimateUsdMicros;
 if(!Number.isSafeInteger(combined)||combined>maxProviderUsdMicros)throw Error('Combined processing exceeds provider budget');
 return {contract:OVERLAY_CLEANUP_CONTRACT,model:OVERLAY_CLEANUP_MODEL,queueFamily:OVERLAY_CLEANUP_QUEUE_FAMILY,
  sourceSha256:source.sha256,maskSha256:mask.sha256,timelineSha256:source.timelineSha256,audio,...g,
  settings:{...OVERLAY_CLEANUP_SETTINGS},prompt:PROMPT,...estimate,combinedProviderEstimateUsdMicros:combined};
}

function temporaryFalUrl(value){
 try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='v3b.fal.media'&&!u.port&&!u.username&&!u.password&&!u.hash&&!u.search&&/^\/files\/b\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.mp4$/.test(u.pathname)}catch{return false}
}
export function overlayCleanupPayload(plan,{source,mask}){
 // These descriptors must come from owned server uploads after the combined
 // price and temporary-link consent. A browser cannot supply provider URLs.
 if(!object(plan)||plan.contract!==OVERLAY_CLEANUP_CONTRACT||plan.model!==OVERLAY_CLEANUP_MODEL||plan.queueFamily!==OVERLAY_CLEANUP_QUEUE_FAMILY||plan.prompt!==PROMPT||!validOverlayCleanupSettings(plan.settings)||!HASH.test(plan.sourceSha256||'')||!HASH.test(plan.maskSha256||'')||!HASH.test(plan.timelineSha256||'')||!Number.isSafeInteger(plan.frameCount)||plan.frameCount<9||plan.frameCount>481||![24,25,30].includes(plan.fpsNumerator)||plan.fpsDenominator!==1)throw Error('Cleanup contract requires a new quote');
 for(const [asset,sha]of [[source,plan.sourceSha256],[mask,plan.maskSha256]])if(!object(asset)||asset.verified!==true||asset.kind!=='video'||asset.sha256!==sha||!temporaryFalUrl(asset.url))throw Error('Cleanup transfer does not match confirmed media');
 return {video_url:source.url,mask_video_url:mask.url,prompt:plan.prompt,num_frames:plan.frameCount,frames_per_second:plan.fpsNumerator,...plan.settings};
}
