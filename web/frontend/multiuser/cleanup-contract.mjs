export const CLEANUP_VERSION='rig-local-text-mask-v1';
export const SOURCE_VERSION='rig-owned-cleanup-source-v1';
export const DETECTOR_VERSION='tesseract7-eng-best-int-psm11-v1';
export const MAX_BYTES=16*1024*1024;
export const MAX_MASK_BYTES=2*1024*1024;
const SHA=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export class CleanupError extends Error{constructor(code,message){super(message);this.name='CleanupError';this.code=code;}}
const fail=(code,message)=>{throw new CleanupError(code,message);};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const int=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const exactKeys=(object,keys)=>object&&Object.getPrototypeOf(object)===Object.prototype&&Object.keys(object).length===keys.length&&keys.every(key=>Object.hasOwn(object,key));
export function freeze(value){if(value&&typeof value==='object'&&!(value instanceof Blob)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
export function crop(value){if(!value||!['x','y','w','h'].every(k=>finite(value[k]))||value.x<0||value.y<0||value.w<=0||value.h<=0||value.x+value.w>100||value.y+value.h>100)fail('crop','Kies een uitsnede binnen het beeld.');return {x:value.x,y:value.y,w:value.w,h:value.h};}
export function selection(value){
 const keys=['revision','sourceToken','portraitToken','startSeconds','selectedSeconds','crop','quality','keepSound','prompt'];
 if(!exactKeys(value,keys)||!int(value.revision,0,Number.MAX_SAFE_INTEGER)||!UUID.test(value.sourceToken)||!UUID.test(value.portraitToken)||!finite(value.startSeconds)||value.startSeconds<0||value.startSeconds>604800||!int(value.selectedSeconds,3,30)||!['standard','pro','edit-standard','human-recast'].includes(value.quality)||typeof value.keepSound!=='boolean'||typeof value.prompt!=='string'||!value.prompt.trim()||value.prompt.length>1900)fail('selection','Je selectie is niet compleet. Kies je beelden en beschrijving opnieuw.');
 if(['edit-standard','human-recast'].includes(value.quality)&&value.selectedSeconds>15||value.quality==='human-recast'&&(value.selectedSeconds<6||!value.keepSound))fail('selection','Deze duur of geluidskeuze past niet bij je videotype.');
 return freeze({...value,crop:crop(value.crop)});
}
export function sourceManifest(value){
 const keys=['version','id','sha256','size','width','height','rotation','hasAudio','clock'];
 if(!exactKeys(value,keys)||value.version!==SOURCE_VERSION||!UUID.test(value.id)||!SHA.test(value.sha256)||!int(value.size,32,MAX_BYTES)||!int(value.width,340,2160)||!int(value.height,340,2160)||value.width*value.height>4194304||value.width%2||value.height%2||value.rotation!==0||typeof value.hasAudio!=='boolean')fail('source','De privéwerkclip kon niet worden gecontroleerd.');
 const c=value.clock;if(!exactKeys(c,['timescale','firstPts','frameDelta','frameCount'])||!int(c.timescale,1,1000000000)||c.firstPts!==0||!int(c.frameDelta,1,c.timescale)||!int(c.frameCount,9,481)||![24,25,30].includes(c.timescale/c.frameDelta)||c.frameCount*c.frameDelta/c.timescale>15.05)fail('clock','Deze bron heeft geen ondersteunde, vaste beeldklok voor tekstverwijdering.');
 return freeze({...value,clock:{...c}});
}
export function manualRegions(regions=[]){if(!Array.isArray(regions)||regions.length>16)fail('regions','Markeer maximaal 16 vaste tekst- of icoonvakken.');return freeze(regions.map(value=>{if(!exactKeys(value,['x','y','w','h']))fail('regions','Een markering is niet geldig.');const r=crop(value);if(r.w*r.h>5000)fail('regions','Een markering bedekt meer dan de helft van het beeld. Maak het vak kleiner.');return r;}));}
export function options(value){if(!exactKeys(value,['detectText','manualRegions','paddingPixels','temporalPaddingFrames'])||typeof value.detectText!=='boolean'||!int(value.paddingPixels,0,12)||!int(value.temporalPaddingFrames,0,2))fail('options','De maskerinstellingen zijn niet geldig.');const regions=manualRegions(value.manualRegions);if(!value.detectText&&!regions.length)fail('empty','Kies tekstherkenning of markeer een tekst- of icoonvak.');return freeze({...value,manualRegions:regions});}
export const stableJson=value=>JSON.stringify(value);
export async function sha256(bytes){const buffer=bytes instanceof Blob?await bytes.arrayBuffer():bytes;return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),x=>x.toString(16).padStart(2,'0')).join('');}
export const hashJson=value=>sha256(new TextEncoder().encode(stableJson(value)));
export function verifySourceBytes(blob,manifest){if(!(blob instanceof Blob)||blob.type!=='video/mp4'||blob.size!==manifest.size)fail('source','De exacte privéwerkclip ontbreekt.');}
export function expectedClock(manifest){const c=manifest.clock;return Array.from({length:c.frameCount},(_,index)=>({timestamp:(c.firstPts+index*c.frameDelta)/c.timescale,duration:c.frameDelta/c.timescale}));}
export function checkClock(actual,manifest,{epsilon=1e-10}={}){const expected=expectedClock(manifest);if(!Array.isArray(actual)||actual.length!==expected.length||actual.some((frame,index)=>!finite(frame.timestamp)||!finite(frame.duration)||Math.abs(frame.timestamp-expected[index].timestamp)>epsilon||Math.abs(frame.duration-expected[index].duration)>epsilon))fail('clock','De bron en het masker hebben niet exact dezelfde beeldklok.');return true;}
export function pixelRect(value,width,height,padding=0){if(!value||!['x','y','w','h'].every(k=>finite(value[k]))||value.w<2||value.h<2||value.x<0||value.y<0||value.x+value.w>width||value.y+value.h>height)return null;const x=Math.max(0,Math.floor(value.x-padding)),y=Math.max(0,Math.floor(value.y-padding)),right=Math.min(width,Math.ceil(value.x+value.w+padding)),bottom=Math.min(height,Math.ceil(value.y+value.h+padding));return {x,y,w:right-x,h:bottom-y};}
export function percentToPixels(value,width,height){return pixelRect({x:value.x*width/100,y:value.y*height/100,w:value.w*width/100,h:value.h*height/100},width,height);}
export function boxesFromOcr(data,width,height){const boxes=[];for(const block of data?.blocks||[])for(const paragraph of block.paragraphs||[])for(const line of paragraph.lines||[]){const words=line.words||[],eligible=words.some(word=>word.confidence>=30&&/[\p{L}\p{N}]/u.test(word.text||''));if(!eligible)continue;for(const word of words){if(boxes.length>=256)fail('coverage','Er zijn te veel tekstvakken om dit fragment veilig voor te bereiden.');if(!/\S/u.test(word.text||''))continue;const b=word.bbox,box=b&&pixelRect({x:b.x0,y:b.y0,w:b.x1-b.x0,h:b.y1-b.y0},width,height);if(box&&box.w*box.h<=width*height*.2&&box.h<=height*.16)boxes.push(box);}}return boxes;}
export function frameRegions(detections,manifest,config){const {width,height,clock}=manifest,fixed=config.manualRegions.map(r=>percentToPixels(r,width,height)).filter(Boolean);if(!Array.isArray(detections)||detections.length!==clock.frameCount)fail('clock','Niet alle beelden zijn voorbereid.');return detections.map((_,index)=>{const rects=[...fixed];for(let j=Math.max(0,index-config.temporalPaddingFrames);j<=Math.min(detections.length-1,index+config.temporalPaddingFrames);j++){if(!Array.isArray(detections[j])||detections[j].length>256)fail('coverage','De tekstvakken zijn niet geldig.');for(const value of detections[j]){const r=pixelRect(value,width,height,config.paddingPixels);if(r)rects.push(r);}}if(rects.length>800)fail('coverage','Het masker bevat te veel vakken.');return [...new Map(rects.map(r=>[`${r.x},${r.y},${r.w},${r.h}`,r])).values()];});}
export function rectangleUnionArea(rectangles,width,height){
 if(!Array.isArray(rectangles)||rectangles.length>800||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)fail('coverage','De maskervakken zijn niet geldig.');
 const events=[];
 for(let index=0;index<rectangles.length;index++){const r=rectangles[index];if(!r||!['x','y','w','h'].every(k=>Number.isSafeInteger(r[k]))||r.x<0||r.y<0||r.w<=0||r.h<=0||r.x+r.w>width||r.y+r.h>height)fail('coverage','Een maskervak valt buiten de bronvideo.');events.push({x:r.x,index,add:true},{x:r.x+r.w,index,add:false});}
 events.sort((a,b)=>a.x-b.x);const active=new Map();let area=0,previous=events[0]?.x??0;
 const verticalUnion=()=>{const spans=[...active.values()].sort((a,b)=>a.y-b.y);let length=0,start=0,end=0;for(const r of spans){if(r.y>end){length+=end-start;start=r.y;end=r.y+r.h;}else end=Math.max(end,r.y+r.h);}return length+end-start;};
 for(let i=0;i<events.length;){const x=events[i].x;area+=(x-previous)*verticalUnion();while(i<events.length&&events[i].x===x){const e=events[i++];if(e.add)active.set(e.index,rectangles[e.index]);else active.delete(e.index);}previous=x;}
 return area;
}
export function assertCoverage(frames,manifest){if(!Array.isArray(frames)||frames.length!==manifest.clock.frameCount)fail('clock','Het masker mist beelden.');let area=0;for(const rectangles of frames){const covered=rectangleUnionArea(rectangles,manifest.width,manifest.height);if(covered>manifest.width*manifest.height*.9)fail('coverage','Het masker bedekt te veel van het beeld. Controleer je markeringen.');area+=covered;}if(!area)fail('empty','Er is geen tekst gevonden. Markeer eventueel zelf een tekst of icoon.');}
