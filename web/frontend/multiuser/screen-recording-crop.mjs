import {CleanupError,pixelRect} from './cleanup-contract.mjs';
// Source-video screen recordings only. Never call this for a portrait/photo.
// Pixel evidence proposes a crop; this function never edits media or applies it.
export function proposeScreenRecordingCrop({frames,width,height,protectedBounds=null,maxTrimFraction=.2}){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<32||height<32||!Array.isArray(frames)||frames.length<3||frames.length>12||frames.some(frame=>!(frame instanceof Uint8ClampedArray)||frame.length!==width*height*4)||typeof maxTrimFraction!=='number'||maxTrimFraction<=0||maxTrimFraction>.25)throw new CleanupError('crop-evidence','Gebruik minstens drie geldige beelden uit de bronvideo.');
 const protectedRect=protectedBounds===null?null:pixelRect(protectedBounds,width,height);if(protectedBounds&&!protectedRect)throw new CleanupError('crop-evidence','Het te behouden beeldgebied is niet geldig.');
 const total=width*height,active=new Uint8Array(total),motion=new Uint8Array(total);
 for(let i=0;i<total;i++){const p=i*4;let bright=0,change=0;for(const frame of frames){if(Math.max(frame[p],frame[p+1],frame[p+2])>=24)bright++;change=Math.max(change,Math.abs(frame[p]-frames[0][p]),Math.abs(frame[p+1]-frames[0][p+1]),Math.abs(frame[p+2]-frames[0][p+2]));}active[i]=bright>=Math.max(2,Math.ceil(frames.length/2))?1:0;motion[i]=change>=24?1:0;}
 // Components below a static browser bar can reveal a complete embedded video
 // rectangle even when the screen's outer corners contain coloured chrome.
 // Ignore full-width UI and require a dark exterior on all sides. The two
 // long parallel edges must be strong; short ends may contain dark scene
 // content. A static candidate needs exceptionally strong four-edge evidence
 // plus separate browser chrome. Ambiguous candidates always abstain.
 const seen=new Uint8Array(total),queue=new Int32Array(total),candidates=[];let hasWideChrome=false;
 for(let seed=0;seed<total;seed++){
  if(!active[seed]||seen[seed])continue;let head=0,tail=1,minX=seed%width,maxX=minX,minY=Math.floor(seed/width),maxY=minY,count=0,changed=0;queue[0]=seed;seen[seed]=1;
  while(head<tail){const i=queue[head++],x=i%width,y=Math.floor(i/width);count++;changed+=motion[i];minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);for(const next of [x>0?i-1:-1,x+1<width?i+1:-1,y>0?i-width:-1,y+1<height?i+width:-1])if(next>=0&&active[next]&&!seen[next]){seen[next]=1;queue[tail++]=next;}}
  const w=maxX-minX+1,h=maxY-minY+1,area=w*h,aspect=w/h;if(w>width*.82&&minY<height*.25&&maxY<height*.4&&count/area>.6)hasWideChrome=true;
  if(w<width*.12||w>width*.82||h<height*.35||h>height*.97||area<total*.05||area>total*.78||aspect<.3||aspect>2.5||count/area<.6)continue;
  const thickness=Math.max(1,Math.min(4,Math.round(Math.min(w,h)*.012))),ratios=[];
  for(const side of ['left','right','top','bottom']){let black=0,n=0;for(let d=1;d<=thickness;d++){const horizontal=side==='top'||side==='bottom',a=horizontal?minX+2:minY+2,b=horizontal?maxX-2:maxY-2;for(let k=a;k<=b;k++){const x=horizontal?k:side==='left'?minX-d:maxX+d,y=horizontal?(side==='top'?minY-d:maxY+d):k;if(x<0||x>=width||y<0||y>=height)continue;n++;if(!active[y*width+x])black++;}}ratios.push(n?black/n:0);}
  if(ratios.some(r=>r<.94))continue;
  const contrasts=[];
  for(const side of ['left','right','top','bottom']){let sharp=0,n=0;const horizontal=side==='top'||side==='bottom',length=horizontal?w:h;for(let k=3;k<length-3;k++){let supported=0;for(const frame of frames){let inside=0;const ox=horizontal?minX+k:side==='left'?minX-2:maxX+2,oy=horizontal?(side==='top'?minY-2:maxY+2):minY+k;if(ox<0||ox>=width||oy<0||oy>=height)continue;const op=(oy*width+ox)*4,outside=Math.max(frame[op],frame[op+1],frame[op+2]);for(let depth=0;depth<3;depth++){const ix=horizontal?minX+k:side==='left'?minX+depth:maxX-depth,iy=horizontal?(side==='top'?minY+depth:maxY-depth):minY+k,p=(iy*width+ix)*4;inside=Math.max(inside,frame[p],frame[p+1],frame[p+2]);}if(inside-outside>=24)supported++;}n++;if(supported>=Math.max(2,Math.ceil(frames.length/2)))sharp++;}contrasts.push(n?sharp/n:0);}
  const longEdges=h>=w?[0,1]:[2,3],shortEdges=h>=w?[2,3]:[0,1];if(longEdges.some(i=>contrasts[i]<.75)||shortEdges.some(i=>contrasts[i]<.35))continue;
  const staticCandidate=changed/count<.015;if(staticCandidate&&(Math.min(...contrasts)<.9||Math.min(...ratios)<.98||count/area<.85))continue;
  let consistent=true;for(const frame of frames){let x0=width,y0=height,x1=-1,y1=-1;for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){const p=(y*width+x)*4;if(Math.max(frame[p],frame[p+1],frame[p+2])>=24){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}}if(x1<0||Math.max(Math.abs(x0-minX),Math.abs(x1-maxX),Math.abs(y0-minY),Math.abs(y1-maxY))>Math.max(2,Math.min(w,h)*.025)){consistent=false;break;}}
  if(!consistent)continue;
  const rect={x:minX,y:minY,w,h};if(protectedRect&&(rect.x>protectedRect.x||rect.y>protectedRect.y||rect.x+rect.w<protectedRect.x+protectedRect.w||rect.y+rect.h<protectedRect.y+protectedRect.h))continue;
  candidates.push({rect,area,staticCandidate,sharpEdges:Math.min(...contrasts),darkRing:Math.min(...ratios),fill:count/area,motion:changed/count});
 }
 for(let i=candidates.length-1;i>=0;i--)if(candidates[i].staticCandidate&&!hasWideChrome)candidates.splice(i,1);
 if(candidates.length===1){const {rect,darkRing,sharpEdges,fill,motion,staticCandidate}=candidates[0];return {proposal:{x:rect.x*100/width,y:rect.y*100/height,w:rect.w*100/width,h:rect.h*100/height},confidence:staticCandidate ? 0.9 : 0.94,basis:staticCandidate?'one stable sharp rectangle inside dark surroundings and separate browser chrome; static content requires preview':'one stable moving rectangle inside a dark surrounding region across every sampled screen-recording frame',evidence:{darkRingCoverage:darkRing,straightEdgeContrastCoverage:sharpEdges,componentFill:fill,motionFraction:motion,staticCandidate,sampledFrames:frames.length},requiresPreview:true,applied:false,subjectDetected:false};}
 if(candidates.length>1)return {proposal:null,confidence:0,basis:'more than one plausible moving video rectangle; adjust manually',requiresPreview:true,applied:false,subjectDetected:false};
 if(hasWideChrome)return {proposal:null,confidence:0,basis:'browser chrome found but no certain straight video rectangle; adjust manually',requiresPreview:true,applied:false,subjectDetected:false};
 const dark=(x,y)=>frames.every(frame=>{const p=(y*width+x)*4;return frame[p]<18&&frame[p+1]<18&&frame[p+2]<18;});
 const darkRow=y=>{let count=0;for(let x=0;x<width;x++)if(dark(x,y))count++;return count/width>=.995;};
 const darkCol=x=>{let count=0;for(let y=0;y<height;y++)if(dark(x,y))count++;return count/height>=.995;};
 const xLimit=Math.floor(width*maxTrimFraction),yLimit=Math.floor(height*maxTrimFraction);let top=0,bottom=height,left=0,right=width;
 while(top<yLimit&&darkRow(top))top++;while(bottom>height-yLimit&&darkRow(bottom-1))bottom--;while(left<xLimit&&darkCol(left))left++;while(right>width-xLimit&&darkCol(right-1))right--;
 const hasVisibleContent=r=>{let seen=0,total=0;for(let y=r.y;y<r.y+r.h;y+=2)for(let x=r.x;x<r.x+r.w;x+=2){total++;if(!dark(x,y))seen++;}return total>0&&seen/total>.05;};
 const protects=r=>!protectedRect||r.x<=protectedRect.x&&r.y<=protectedRect.y&&r.x+r.w>=protectedRect.x+protectedRect.w&&r.y+r.h>=protectedRect.y+protectedRect.h;
 let candidate={x:left,y:top,w:right-left,h:bottom-top};const trimmed=left>0||top>0||right<width||bottom<height;
 if(trimmed&&hasVisibleContent(candidate)&&candidate.w>=width*.5&&candidate.h>=height*.5&&protects(candidate))return {proposal:{x:left*100/width,y:top*100/height,w:candidate.w*100/width,h:candidate.h*100/height},confidence:.9,basis:'near-black borders across every supplied source-video frame',requiresPreview:true,applied:false,subjectDetected:false};
 // Static chrome is only a low-confidence observation: a wall or a still face
 // is also static. Never infer a person/dog or the true video rectangle from it.
 const staticRow=y=>{let stable=0;for(let x=0;x<width;x++){const p=(y*width+x)*4;let okay=true;for(let f=1;f<frames.length;f++)if(Math.max(Math.abs(frames[f][p]-frames[0][p]),Math.abs(frames[f][p+1]-frames[0][p+1]),Math.abs(frames[f][p+2]-frames[0][p+2]))>8){okay=false;break;}if(okay)stable++;}return stable/width>=.99;};
 let staticTop=0,staticBottom=height;while(staticTop<yLimit&&staticRow(staticTop))staticTop++;while(staticBottom>height-yLimit&&staticRow(staticBottom-1))staticBottom--;
 candidate={x:0,y:staticTop,w:width,h:staticBottom-staticTop};
 const middleMotion=frames.some((frame,index)=>index>0&&frame.some((value,p)=>p%4!==3&&Math.abs(value-frames[0][p])>16));
 if(protectedRect&&middleMotion&&(staticTop>0||staticBottom<height)&&protects(candidate)&&candidate.h>=height*.5)return {proposal:{x:0,y:staticTop*100/height,w:100,h:candidate.h*100/height},confidence:.45,basis:'static edge bands; may be browser/player chrome OR real video content',requiresPreview:true,applied:false,subjectDetected:false};
 return {proposal:null,confidence:0,basis:protectedRect&&!protects(candidate)?'proposed edges overlap protected content':'no reliable screen-recording video rectangle; adjust manually',requiresPreview:true,applied:false,subjectDetected:false};
}

// Read a few thumbnail frames from a separate local decoder. The selected UI
// video's playhead, crop and File stay untouched. No media leaves the device.
export async function sampleScreenRecordingFile(file,{signal,onProgress=()=>{},documentRef=globalThis.document,urlApi=globalThis.URL}={}){
 const type=typeof file?.type==='string'?file.type.split(';',1)[0].trim().toLowerCase():'';
 if(!['video/mp4','video/quicktime','video/webm'].includes(type)||!(file instanceof Blob)||!file.size)throw new CleanupError('video','Kies een MP4-, MOV- of WebM-bronvideo.');
 if(!documentRef?.createElement||!urlApi?.createObjectURL)throw new CleanupError('unsupported','Je browser kan geen uitsnede voorstellen. Gebruik de handmatige uitsnede.');
 const video=documentRef.createElement('video'),canvas=documentRef.createElement('canvas'),safe=new Blob([file],{type}),url=urlApi.createObjectURL(safe);video.muted=true;video.playsInline=true;video.preload='auto';
 const active=()=>{if(signal?.aborted)throw new CleanupError('canceled','De uitsnedecontrole is geannuleerd.');};
 const wait=(event,start,ready)=>new Promise((resolve,reject)=>{let timer;const cleanup=()=>{clearTimeout(timer);video.removeEventListener(event,done);video.removeEventListener('error',bad);signal?.removeEventListener('abort',canceled);};const done=()=>{cleanup();resolve();},bad=()=>{cleanup();reject(new CleanupError('video','De bronvideo kon niet voor een voorstel worden gelezen. Gebruik de handmatige uitsnede.'));},canceled=()=>{cleanup();reject(new CleanupError('canceled','De uitsnedecontrole is geannuleerd.'));};video.addEventListener(event,done,{once:true});video.addEventListener('error',bad,{once:true});signal?.addEventListener('abort',canceled,{once:true});timer=setTimeout(bad,15000);try{active();start();if(ready())done();}catch(error){cleanup();reject(error);}});
 try{
  await wait('loadedmetadata',()=>{video.src=url;},()=>Number.isFinite(video.duration)&&video.duration>0&&video.videoWidth>0);active();
  if(!Number.isFinite(video.duration)||video.duration<=0||video.videoWidth<64||video.videoHeight<64)throw new CleanupError('video','Deze bronvideo is niet geschikt voor een automatisch voorstel.');
  const sourceWidth=video.videoWidth,sourceHeight=video.videoHeight,scale=Math.min(1,960/sourceWidth,600/sourceHeight);canvas.width=Math.max(32,Math.round(sourceWidth*scale));canvas.height=Math.max(32,Math.round(sourceHeight*scale));const context=canvas.getContext('2d',{willReadFrequently:true}),frames=[],sampleTimes=[.08,.26,.52].map(fraction=>Math.min(video.duration-.001,Math.max(0,video.duration*fraction)));
  for(let index=0;index<sampleTimes.length;index++){active();const time=sampleTimes[index];await wait('seeked',()=>{video.currentTime=time;},()=>!video.seeking&&video.readyState>=2&&Math.abs(video.currentTime-time)<.01);active();context.drawImage(video,0,0,canvas.width,canvas.height);const data=context.getImageData(0,0,canvas.width,canvas.height).data;frames.push(new Uint8ClampedArray(data));onProgress((index+1)/sampleTimes.length);}
  active();return {frames,width:canvas.width,height:canvas.height,sourceWidth,sourceHeight,sourceDuration:video.duration,sampleTimes};
 }finally{try{video.pause();video.removeAttribute('src');video.load();}catch{}canvas.width=canvas.height=1;urlApi.revokeObjectURL(url);}
}

export async function suggestScreenRecordingCrop(file,options={}){
 const samples=await sampleScreenRecordingFile(file,options);if(options.signal?.aborted)throw new CleanupError('canceled','De uitsnedecontrole is geannuleerd.');const proposal=proposeScreenRecordingCrop(samples);return {...proposal,sampleInfo:{times:samples.sampleTimes,width:samples.width,height:samples.height,sourceWidth:samples.sourceWidth,sourceHeight:samples.sourceHeight}};
}
