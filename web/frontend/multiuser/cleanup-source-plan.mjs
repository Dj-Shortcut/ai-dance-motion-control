import {CleanupError} from './cleanup-contract.mjs';
const fail=message=>{throw new CleanupError('source-clock',message);};
export function exactWorkingSourcePlan(packets,{selectedSeconds,frameRate}={}){
 if(!Array.isArray(packets)||packets.length<3||packets.length>1000||packets.some(p=>!Number.isFinite(p.timestamp)||!Number.isFinite(p.duration)||p.timestamp<0||p.duration<=0||p.duration>1))fail('De lokale werkclip heeft geen bruikbare beeldklok.');
 const ordered=[...packets].sort((a,b)=>a.timestamp-b.timestamp);if(Math.abs(ordered[0].timestamp)>1e-9||ordered.some((p,i)=>i&&p.timestamp<=ordered[i-1].timestamp))fail('De lokale werkclip begint niet op een eenduidig beeld.');
 const availableDuration=Math.max(...ordered.map(p=>p.timestamp+p.duration)),average=ordered.length/availableDuration;if(availableDuration<3||availableDuration>15.55||average<20||average>35)fail('Gebruik een lokaal voorbereid fragment van 3 tot 15 seconden.');
 if(selectedSeconds!==undefined&&(!Number.isInteger(selectedSeconds)||selectedSeconds<3||selectedSeconds>15))fail('Kies een fragment van 3 tot 15 seconden.');if(frameRate!==undefined&&![24,25,30].includes(frameRate))fail('Deze vaste beeldsnelheid is niet beschikbaar.');
 const exactCfr=[24,25,30].find(fps=>ordered.every((p,i)=>Math.abs(p.timestamp-i/fps)<1e-10&&Math.abs(p.duration-1/fps)<1e-10));
 const fps=frameRate??exactCfr??30,limit=Math.min(availableDuration,selectedSeconds??15);let count=Math.floor(limit*fps+1e-7);while(count/fps>limit+1e-9)count--;
 if(count<3*fps||count>15*fps)fail('Er zijn niet genoeg echte beelden voor dit fragment. Kies een langer fragment.');
 return Object.freeze({frameRate:fps,frameCount:count,durationSeconds:count/fps,availableDurationSeconds:availableDuration,selectedSeconds:selectedSeconds??null,frameRateBasis:frameRate?'explicit-locked':exactCfr?'retain-input-cfr':'working-clip-30',sourcePacketCount:ordered.length,timestamps:Object.freeze(Array.from({length:count},(_,i)=>i/fps))});
}
export function completeAacPackets(packets,endSeconds){
 if(!Array.isArray(packets)||!packets.length||packets.length>2048||!Number.isFinite(endSeconds)||endSeconds<3||endSeconds>15)fail('Het oorspronkelijke AAC-geluid kon niet worden gecontroleerd.');let bytes=0,previous=-Infinity,previousEnd=-Infinity;
 for(const p of packets){bytes+=p.data?.byteLength??0;if(!Number.isFinite(p.timestamp)||!Number.isFinite(p.duration)||p.timestamp<-.25||p.timestamp<previous||p.timestamp+p.duration<previousEnd-1e-9||p.duration<=0||p.duration>.15||!p.data?.byteLength||bytes>8*1024*1024)fail('Het oorspronkelijke AAC-geluid heeft geen bruikbare klok.');previous=p.timestamp;previousEnd=p.timestamp+p.duration;}
 // Keep codec priming exactly as encoded. Drop only tail packets; do not
 // fabricate a shorter duration for a payload or add audio after video ends.
 const kept=packets.filter(p=>p.timestamp+p.duration<=endSeconds+1e-9);if(!kept.some(p=>p.timestamp+p.duration>0))fail('Er blijft geen volledig AAC-geluid binnen dit fragment over.');
 return {packets:kept,sourcePacketCount:packets.length,copiedPacketCount:kept.length,droppedTailPackets:packets.length-kept.length,sourceEndSeconds:Math.max(...packets.map(p=>p.timestamp+p.duration)),audioEndSeconds:Math.max(...kept.map(p=>p.timestamp+p.duration)),videoEndSeconds:endSeconds,encoderUsed:false,packetBytesModified:false};
}
