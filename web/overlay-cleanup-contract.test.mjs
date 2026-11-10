import test from 'node:test';
import assert from 'node:assert/strict';
import {getOverlayCleanupPricePreflight,estimateOverlayCleanup,createOverlayCleanupPlan,overlayCleanupPayload,OVERLAY_CLEANUP_BILLING as B,OVERLAY_CLEANUP_MODEL as MODEL} from './overlay-cleanup-contract.mjs';
const source=()=>({inspectionLevel:'container-only',geometryVerified:'avc-sps',mime:'video/mp4',codec:'h264',sha256:'a'.repeat(64),timelineSha256:'c'.repeat(64),size:5682118,width:768,height:1344,frameCount:142,fpsNumerator:24,fpsDenominator:1,presentationPts:Array.from({length:142},(_,i)=>i===0?'0/1':`${i}/24`),hasAudio:true,audioPacketSha256:'d'.repeat(64),audio:{timelineSha256:'e'.repeat(64),codecConfigSha256:'f'.repeat(64)}});
const mask=()=>({...source(),sha256:'b'.repeat(64),size:23318,hasAudio:false});
const input=()=>({source:source(),mask:mask(),maskSourceSha256:'a'.repeat(64),billing:{...B},baseProviderEstimateUsdMicros:2700000});
const uploads=()=>({source:{verified:true,kind:'video',sha256:'a'.repeat(64),url:'https://v3b.fal.media/files/b/fixture/source.mp4'},mask:{verified:true,kind:'video',sha256:'b'.repeat(64),url:'https://v3b.fal.media/files/b/fixture/mask.mp4'}});

test('real 142-frame capability clip uses MP-frame billing, rounds conservatively, and adds to the existing 1080p base budget',()=>{
 const p=createOverlayCleanupPlan(input());assert.equal(p.pixelFrames,'146571264');assert.equal(p.billedMegapixels,147);assert.equal(p.providerEstimateUsdMicros,353903);assert.equal(p.combinedProviderEstimateUsdMicros,3053903);
 assert.equal(p.settings.generate_audio,false);assert.equal(p.settings.video_quality,'maximum');assert.equal(p.settings.num_inference_steps,30);
 const x=overlayCleanupPayload(p,uploads());assert.equal(x.num_frames,142);assert.equal(x.frames_per_second,24);assert.equal(x.enable_prompt_expansion,false);assert.equal(x.enable_safety_checker,true);
});
test('megapixel estimate uses every actual frame and never a per-second fallback or fractional-microdollar truncation',()=>{
 const a=estimateOverlayCleanup(source(),B),b=estimateOverlayCleanup({...source(),frameCount:143,presentationPts:[...source().presentationPts,'71/12']},B);assert.ok(b.providerEstimateUsdMicros>a.providerEstimateUsdMicros);
 const c=estimateOverlayCleanup({...source(),width:1000,height:1000,frameCount:9,presentationPts:source().presentationPts.slice(0,9)},B);assert.equal(c.providerEstimateUsdMicros,21668);
 for(const patch of [{unit:'second'},{unit:'megapixel'},{unitPrice:.001},{currency:'EUR'},{nanosPerMegapixel:2407000}])assert.throws(()=>estimateOverlayCleanup(source(),{...B,...patch}));
});
test('combined price cannot exceed or silently raise the current Fal job limit',()=>{
 assert.throws(()=>createOverlayCleanupPlan({...input(),baseProviderEstimateUsdMicros:5800000}));
 assert.throws(()=>createOverlayCleanupPlan({...input(),maxProviderUsdMicros:7000000}));
 assert.throws(()=>createOverlayCleanupPlan({...input(),maxProviderUsdMicros:3000000}));
});
test('wrong source, timing, geometry, audio-bearing mask and oversize originals stop before constructing a paid payload',()=>{
 for(const patch of [{timelineSha256:'d'.repeat(64)},{frameCount:141},{fpsNumerator:30},{width:720},{hasAudio:true},{size:2*1024*1024+1}])assert.throws(()=>createOverlayCleanupPlan({...input(),mask:{...mask(),...patch}}));
 assert.throws(()=>createOverlayCleanupPlan({...input(),maskSourceSha256:'d'.repeat(64)}));
 assert.throws(()=>createOverlayCleanupPlan({...input(),source:{...source(),size:16*1024*1024+1}}));
 assert.throws(()=>createOverlayCleanupPlan({...input(),source:{...source(),audio:null}}));
 assert.throws(()=>createOverlayCleanupPlan({...input(),source:{...source(),presentationPts:['1/24',...source().presentationPts.slice(1)]}}));
 for(const patch of [{frameCount:482},{frameCount:8},{fpsNumerator:29.97},{fpsDenominator:1001},{inspectionLevel:'browser'},{frameCount:NaN},{height:5000}])assert.throws(()=>estimateOverlayCleanup({...source(),...patch},B));
});
test('payload accepts only fixed quality, exact owned upload hashes and bounded temporary Fal video URLs',()=>{
 const p=createOverlayCleanupPlan(input());
 for(const url of ['https://attacker.invalid/video.mp4','https://v3b.fal.media.evil.invalid/files/b/x/a.mp4','https://v3b.fal.media/files/b/x/a.mp4?secret=x','http://v3b.fal.media/files/b/x/a.mp4','https://v3b.fal.media/files/b/x/a.jpg'])assert.throws(()=>overlayCleanupPayload(p,{...uploads(),mask:{...uploads().mask,url}}));
 assert.throws(()=>overlayCleanupPayload(p,{...uploads(),source:{...uploads().source,sha256:'d'.repeat(64)}}));
 for(const patch of [{model:'other/model'},{settings:{...p.settings,video_quality:'low'}},{settings:{...p.settings,sync_mode:true}},{prompt:'new prompt'},{frameCount:9999}])assert.throws(()=>overlayCleanupPayload({...p,...patch},uploads()));
});
test('fresh read-only pricing requires one exact endpoint and the reviewed billing dimensions',async()=>{
 let calls=0;
 const fetcher=async(url,o)=>{calls++;assert.equal(o.method,'GET');assert.equal(o.redirect,'manual');assert.equal(new URL(url).origin,'https://api.fal.ai');assert.equal(new URL(url).searchParams.get('endpoint_id'),MODEL);assert.ok(o.signal instanceof AbortSignal);return Response.json({prices:[{endpoint_id:MODEL,currency:'USD',unit:'megapixels',unit_price:.0024075}]})};
 assert.deepEqual(await getOverlayCleanupPricePreflight('fixture-key',fetcher),B);assert.equal(calls,1);
 for(const rows of [[],[{endpoint_id:MODEL,unit:'seconds',currency:'USD',unit_price:.0024075}],[{endpoint_id:MODEL,unit:'megapixels',currency:'USD',unit_price:.1}],[{endpoint_id:MODEL,unit:'megapixels',currency:'EUR',unit_price:.0024075}],Array(2).fill({endpoint_id:MODEL,unit:'megapixels',currency:'USD',unit_price:.0024075})])await assert.rejects(getOverlayCleanupPricePreflight('fixture-key',async()=>Response.json({prices:rows})));
});
