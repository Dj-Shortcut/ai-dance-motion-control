// Initial, local preparation only. The resulting AAC becomes the new canonical
// source; post-cleanup composition must still copy its packets exactly.
import {CleanupError} from './cleanup-contract.mjs';
const fail=message=>{throw new CleanupError('audio',message)};
const live=signal=>{if(signal?.aborted)throw new CleanupError('canceled','Geluidsvoorbereiding geannuleerd.');};
const framesPerAacPacket=1024,maxPackets=2048,maxPcmBytes=16*1024*1024;
const view=value=>value instanceof ArrayBuffer?new Uint8Array(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):new Uint8Array();
function layout(sampleRate,channels){if(![8000,11025,12000,16000,22050,24000,32000,44100,48000,64000,88200,96000].includes(sampleRate)||![1,2].includes(channels))fail('Dit geluidsformaat kan niet veilig lokaal worden voorbereid.');}
function ticks(value,rate){const n=Math.round(value*rate);if(!Number.isSafeInteger(n)||Math.abs(value*rate-n)>1e-5)fail('Het oorspronkelijke geluid heeft geen eenduidige sampleklok.');return n;}
export function aacPacketsAreCopyable(packets,sampleRate){
 if(!Array.isArray(packets)||!packets.length||packets.length>maxPackets)return false;
 try{let end=null;for(const p of packets){const start=ticks(p.timestamp,sampleRate),duration=ticks(p.duration,sampleRate);if(duration<=0||end!==null&&start!==end)return false;end=start+duration;}return true;}catch{return false;}
}

// AudioSampleSink smooths sub-frame timestamp gaps. AAC-LC with frameLengthFlag0
// decodes1024 frames/access unit; use the original encoded packet clock to place
// that PCM, rather than accepting the sink's smoothed timestamps as provenance.
export async function normalizedAacPcm({packets,samples,sampleRate,numberOfChannels,endSeconds,signal}={}){
 layout(sampleRate,numberOfChannels);live(signal);
 if(!Array.isArray(packets)||!packets.length||packets.length>maxPackets||!samples?.[Symbol.asyncIterator]||!Number.isFinite(endSeconds)||endSeconds<3||endSeconds>15)fail('Het oorspronkelijke geluid kon niet volledig worden gelezen.');
 const targetFrames=Math.floor(endSeconds*sampleRate+1e-6),decodedFrames=packets.length*framesPerAacPacket;
 if(decodedFrames*numberOfChannels*4>maxPcmBytes||targetFrames*numberOfChannels*4>maxPcmBytes)fail('Dit geluid overschrijdt de lokale verwerkingsgrens.');
 let packetBytes=0,previous=-Infinity;for(const p of packets){packetBytes+=p.data?.byteLength??0;if(!Number.isFinite(p.timestamp)||p.timestamp<-.25||p.timestamp<previous||!Number.isFinite(p.duration)||p.duration<=0||p.duration>.15||!p.data?.byteLength||packetBytes>8*1024*1024)fail('De oorspronkelijke AAC-klok kon niet veilig worden voorbereid.');ticks(p.timestamp,sampleRate);ticks(p.duration,sampleRate);previous=p.timestamp;}
 const decoded=new Float32Array(decodedFrames*numberOfChannels);let count=0,blocks=0;
 for await(const sample of samples){try{live(signal);if(++blocks>maxPackets||sample.sampleRate!==sampleRate||sample.numberOfChannels!==numberOfChannels||!Number.isSafeInteger(sample.numberOfFrames)||sample.numberOfFrames<1||sample.numberOfFrames>16384||count+sample.numberOfFrames>decodedFrames)fail('De AAC-decoder gaf een andere hoeveelheid geluid terug.');const part=decoded.subarray(count*numberOfChannels,(count+sample.numberOfFrames)*numberOfChannels);sample.copyTo(part,{format:'f32',planeIndex:0});if(part.some(x=>!Number.isFinite(x)||Math.abs(x)>16))fail('Het gedecodeerde geluid bevat ongeldige samples.');count+=sample.numberOfFrames;}finally{sample.close();}}
 if(count!==decodedFrames)fail('Niet alle oorspronkelijke AAC-frames konden worden gelezen.');live(signal);
 const pcm=new Float32Array(targetFrames*numberOfChannels),covered=new Uint8Array(targetFrames);let copied=0,priming=0,boundary=0,metadataTrim=0,lastEnd=-Infinity;
 for(let i=0;i<packets.length;i++){
  live(signal);const start=ticks(packets[i].timestamp,sampleRate),logical=ticks(packets[i].duration,sampleRate);
  if(start<lastEnd)fail('Overlappende AAC-packets kunnen niet veilig worden voorbereid.');lastEnd=start+logical;
  const frames=Math.min(framesPerAacPacket,logical),skip=Math.min(frames,Math.max(0,-start)),available=frames-skip,destination=Math.max(0,start),n=Math.max(0,Math.min(available,targetFrames-destination));
  priming+=skip;boundary+=available-n;metadataTrim+=Math.max(0,framesPerAacPacket-logical);
  if(n){pcm.set(decoded.subarray((i*framesPerAacPacket+skip)*numberOfChannels,(i*framesPerAacPacket+skip+n)*numberOfChannels),destination*numberOfChannels);covered.fill(1,destination,destination+n);copied+=n;}
 }
 decoded.fill(0);const filledSilenceFrames=targetFrames-covered.reduce((n,x)=>n+x,0);live(signal);
 return {data:pcm,sampleRate,numberOfChannels,frameCount:targetFrames,receipt:{version:'rig-local-aac-normalize-v1',reencoded:true,encoderUsed:true,packetBytesModified:true,originalPacketCount:packets.length,decodedPcmFrames:count,outputPcmFrames:targetFrames,copiedPcmFrames:copied,filledSilenceFrames,trimmedPrimingFrames:priming,trimmedBoundaryFrames:boundary,metadataTrimFrames:metadataTrim,sampleRate,channels:numberOfChannels,videoEndSeconds:endSeconds,audioEndSeconds:targetFrames/sampleRate}};
}

export async function prepareCanonicalAac({codec,track,packets,decoderConfig,endSeconds,signal}={}){
 const {AudioSampleSink,AudioSampleSource,AudioSample,Output,Mp4OutputFormat,BufferTarget,Input,BlobSource,MP4,EncodedPacketSink}=codec??{};
 if([AudioSampleSink,AudioSampleSource,AudioSample,Output,Mp4OutputFormat,BufferTarget,Input,BlobSource,EncodedPacketSink].some(x=>typeof x!=='function')||!MP4)fail('Deze browser kan het geluid niet lokaal voorbereiden.');
 const description=view(decoderConfig?.description);layout(decoderConfig?.sampleRate,decoderConfig?.numberOfChannels);
 if(decoderConfig.codec!=='mp4a.40.2'||description.length<2||(description[0]>>3)!==2||(description[1]&7)!==0||!await track.canDecode())fail('Alleen ondersteund AAC-LC-geluid kan lokaal worden voorbereid.');live(signal);
 const normalized=await normalizedAacPcm({packets,samples:new AudioSampleSink(track).samples(),sampleRate:decoderConfig.sampleRate,numberOfChannels:decoderConfig.numberOfChannels,endSeconds,signal});
 const target=new BufferTarget();let actualConfig=null,input=null,output=new Output({format:new Mp4OutputFormat({fastStart:'in-memory'}),target});
 const source=new AudioSampleSource({codec:'aac',bitrate:256000,onEncoderConfig:config=>{actualConfig=config}}),stop=()=>{if(output)void output.cancel().catch(()=>{});input?.dispose();};signal?.addEventListener('abort',stop,{once:true});
 try{
  output.addAudioTrack(source);await output.start();
  for(let at=0;at<normalized.frameCount;at+=4096){live(signal);const end=Math.min(normalized.frameCount,at+4096),sample=new AudioSample({data:normalized.data.subarray(at*normalized.numberOfChannels,end*normalized.numberOfChannels),format:'f32',sampleRate:normalized.sampleRate,numberOfChannels:normalized.numberOfChannels,timestamp:at/normalized.sampleRate});try{await source.add(sample);}finally{sample.close();}}
  source.close();await output.finalize();output=null;live(signal);
  if(actualConfig?.codec!=='mp4a.40.2'||actualConfig.sampleRate!==normalized.sampleRate||actualConfig.numberOfChannels!==normalized.numberOfChannels||actualConfig.bitrate!==256000||!(target.buffer instanceof ArrayBuffer)||target.buffer.byteLength>2*1024*1024)fail('De gekozen hoogwaardige AAC-instellingen zijn niet beschikbaar.');
  input=new Input({formats:[MP4],source:new BlobSource(new Blob([target.buffer],{type:'video/mp4'}))});const audio=await input.getPrimaryAudioTrack(),config=await audio?.getDecoderConfig();live(signal);
  if(audio?.codec!=='aac'||config?.codec!=='mp4a.40.2'||config.sampleRate!==normalized.sampleRate||config.numberOfChannels!==normalized.numberOfChannels||!config.description)fail('Het nieuwe AAC-geluid kon niet worden gecontroleerd.');
  const canonical=[];for await(const packet of new EncodedPacketSink(audio).packets()){live(signal);if(canonical.length>=maxPackets)fail('Te veel opnieuw voorbereide AAC-packets.');const end=normalized.frameCount/normalized.sampleRate;if(packet.timestamp>=end)continue;const duration=Math.min(packet.duration,end-packet.timestamp);if(duration<=0)continue;canonical.push(duration===packet.duration?packet:packet.clone({duration}));}
  if(!canonical.length||!aacPacketsAreCopyable(canonical,config.sampleRate)||Math.abs(canonical.at(-1).timestamp+canonical.at(-1).duration-normalized.frameCount/normalized.sampleRate)>1e-9)fail('De nieuwe AAC-tijdlijn kon niet exact worden voorbereid.');
  return {packets:canonical,decoderConfig:config,...normalized.receipt,bitrate:256000,copiedPacketCount:canonical.length,sourcePacketCount:packets.length,droppedTailPackets:0,canonicalPacketCopyRequiredAfterPreparation:true};
 }finally{signal?.removeEventListener('abort',stop);normalized.data.fill(0);input?.dispose();if(output)await output.cancel().catch(()=>{});}
}
