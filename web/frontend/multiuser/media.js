'use strict';
// All media stays in the browser. This module never makes network requests.
(() => {
  const bounds = crop => {
    if (!crop || !['x','y','w','h'].every(k => Number.isFinite(crop[k]))) throw Error('Ongeldige uitsnede.');
    const {x,y,w,h} = crop;
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x+w > 100 || y+h > 100) throw Error('De uitsnede moet binnen het beeld vallen.');
    return crop;
  };
  const dimensions = (source, crop, maxW, maxH) => {
    bounds(crop);
    const width=source.videoWidth || source.naturalWidth || source.width;
    const height=source.videoHeight || source.naturalHeight || source.height;
    const sx=width*crop.x/100, sy=height*crop.y/100, sw=width*crop.w/100, sh=height*crop.h/100;
    if (!width || !height || sw < 64 || sh < 64) throw Error('De uitsnede moet minstens 64 × 64 pixels zijn.');
    const scale=Math.min(1,maxW/sw,maxH/sh);
    return {sx,sy,sw,sh,width:Math.max(2,Math.floor(sw*scale/2)*2),height:Math.max(2,Math.floor(sh*scale/2)*2)};
  };
  const paint = (canvas, source, crop, maxW, maxH) => {
    const d=dimensions(source,crop,maxW,maxH);
    if(canvas.width!==d.width) canvas.width=d.width;
    if(canvas.height!==d.height) canvas.height=d.height;
    canvas.getContext('2d').drawImage(source,d.sx,d.sy,d.sw,d.sh,0,0,d.width,d.height);
  };
  const blob = (canvas, type, quality) => new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('Afbeelding voorbereiden is mislukt.')),type,quality));
  async function prepareImage(source,crop) {
    const c=document.createElement('canvas');paint(c,source,crop,1280,1280);
    return {blob:await blob(c,'image/jpeg',0.93),name:'rig-persoon.jpg',type:'image/jpeg',width:c.width,height:c.height};
  }
  async function prepareImageFile(file) {
    // Decode only raster media through a fixed MIME URL, never a data URL or
    // active document. Source size is independent of the bounded working JPEG.
    const type=typeof file?.type==='string'?file.type.split(';',1)[0].trim().toLowerCase():'';
    let safe;
    switch(type){
      case 'image/jpeg':safe=new Blob([file],{type:'image/jpeg'});break;
      case 'image/png':safe=new Blob([file],{type:'image/png'});break;
      case 'image/webp':safe=new Blob([file],{type:'image/webp'});break;
      default:throw Error('Kies een JPG-, PNG- of WebP-afbeelding.');
    }
    const image=new Image(),url=URL.createObjectURL(safe);
    try {
      await new Promise((resolve,reject)=>{
        const cleanup=()=>{clearTimeout(timer);image.onload=null;image.onerror=null;};
        const timer=setTimeout(()=>{cleanup();reject(Error('Deze foto kon niet worden geopend. Probeer een andere foto.'));},30000);
        image.onload=()=>{cleanup();resolve();};
        image.onerror=()=>{cleanup();reject(Error('Deze foto kan niet worden geopend in je browser.'));};
        image.src=url;
      });
      return await prepareImage(image,{x:0,y:0,w:100,h:100});
    } finally {
      image.onload=null;image.onerror=null;image.src='';URL.revokeObjectURL(url);
    }
  }
  // MediaRecorder may generate fragmented MP4 where browsers initially expose
  // Infinity or zero duration. Seeking past the end asks the browser's demuxer
  // to discover the end. We still reject if it cannot determine a finite value.
  async function recordingDuration(check) {
    const usable = () => Number.isFinite(check.duration) && check.duration > 0;
    if (usable()) return check.duration;
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); for (const name of ['durationchange','timeupdate','seeked','error']) check.removeEventListener(name, onEvent); };
      const onEvent = (event) => {
        if (event.type === 'error') { cleanup(); reject(Error('De voorbereide MP4 kan niet worden gelezen.')); }
        else if (usable()) { const duration=check.duration; cleanup(); resolve(duration); }
      };
      for (const name of ['durationchange','timeupdate','seeked','error']) check.addEventListener(name, onEvent);
      timer=setTimeout(()=>{cleanup();reject(Error('De browser kan de duur van de voorbereide video niet bepalen.'));},10000);
      try { check.currentTime=1e7; } catch { cleanup(); reject(Error('De browser kan de duur van de voorbereide video niet bepalen.')); }
      // Some engines synchronously resolve the duration on seek.
      if (usable()) {const duration=check.duration;cleanup();resolve(duration);}
    });
  }
  async function validateRecording(recording, duration) {
    if (recording.size > 16 * 1024 * 1024) throw Error('De voorbereide video is groter dan 16 MB. Kies een korter fragment.');
    const url=URL.createObjectURL(recording), check=document.createElement('video');
    try { await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(Error('De voorbereide video kon niet worden gecontroleerd.'));},10000); function cleanup(){clearTimeout(timer);check.removeEventListener('loadedmetadata',done);check.removeEventListener('error',fail)} function done(){cleanup();resolve()} function fail(){cleanup();reject(Error('De voorbereide MP4 kan niet worden gelezen.'))}check.addEventListener('loadedmetadata',done);check.addEventListener('error',fail);check.preload='metadata';check.src=url;});
      const actual=await recordingDuration(check);
      if(Math.abs(actual-duration)>0.5) throw Error(`De voorbereide video duurt ${actual.toFixed(2)} s in plaats van ${duration.toFixed(2)} s. Probeer opnieuw of een andere browser.`);
      // The server requests 3.08 s for the 3 s minimum. Refuse a browser
      // recording without enough tail before sending it for transformation.
      if(duration===3 && actual<3.08) throw Error('Het fragment is te kort voorbereid. Probeer opnieuw of kies een langer fragment.');
      return actual;
    } finally {check.removeAttribute('src');check.load();URL.revokeObjectURL(url)}
  }
  function videoDimensions(video,crop,{minSide=0}={}) {
    if(![0,720].includes(minSide))throw Error('Ongeldige videovoorbereiding.');
    const portrait=crop.h*video.videoHeight>crop.w*video.videoWidth;
    const d=dimensions(video,crop,portrait?720:1280,portrait?1280:720);
    if(minSide&&Math.min(d.sw,d.sh)<minSide)throw Error('Kies voor videobewerking een video of uitsnede van minstens 720 × 720 pixels.');
    // Keep the complete chosen composition. Rounding a tall 742×1322 reel
    // inside 1280 produces 718×1280; add one pixel on each side rather than
    // dropping content or sending an input below the model's minimum.
    const width=Math.max(d.width,minSide),height=Math.max(d.height,minSide);
    return {...d,width,height,contentWidth:d.width,contentHeight:d.height,dx:(width-d.width)/2,dy:(height-d.height)/2};
  }
  async function prepareVideo(video,crop,start,duration,keepSound,onProgress=()=>{},options={}) {
    const maxDuration=options.maxDuration??30;
    if(![15,30].includes(maxDuration)||!Number.isFinite(start)||!Number.isFinite(duration)||start<0||duration<3||duration>maxDuration||start+duration>video.duration+0.001) throw Error(`Kies een geldig fragment van 3 tot ${[15,30].includes(maxDuration)?maxDuration:30} seconden binnen de video.`);
    if(document.visibilityState!=='visible'||!document.hasFocus()) throw Error('Houd RIG in beeld tijdens het voorbereiden van de video.');
    if(typeof MediaRecorder==='undefined'||typeof HTMLCanvasElement.prototype.captureStream!=='function') throw Error('Je browser kan de video niet lokaal voorbereiden.');
    const mime=['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4;codecs=avc1','video/mp4'].find(x=>MediaRecorder.isTypeSupported(x));
    if(!mime) throw Error('Deze browser kan geen geschikte MP4 maken. Probeer Safari of Chrome op een recente Mac.');
    if(keepSound && typeof video.captureStream!=='function') throw Error('Deze browser kan het geluid niet meenemen bij lokaal voorbereiden. Zet geluid uit of probeer een andere browser.');
    const canvas=document.createElement('canvas');const d=videoDimensions(video,crop,options);
    canvas.width=d.width;canvas.height=d.height;
    const paintFrame=()=>{const context=canvas.getContext('2d');if(d.dx||d.dy){context.fillStyle='#000';context.fillRect(0,0,d.width,d.height)}context.drawImage(video,d.sx,d.sy,d.sw,d.sh,d.dx,d.dy,d.contentWidth,d.contentHeight)};
    video.pause(); video.currentTime=start;
    await new Promise((resolve,reject)=>{if(!video.seeking && Math.abs(video.currentTime-start)<0.01 && video.readyState>=2)return resolve(); const timer=setTimeout(()=>{cleanup();reject(Error('Video zoeken duurde te lang.'));},8000);function cleanup(){clearTimeout(timer);video.removeEventListener('seeked',done);video.removeEventListener('error',bad)} function done(){cleanup();resolve()}function bad(){cleanup();reject(Error('Video kon niet worden gelezen.'))}video.addEventListener('seeked',done);video.addEventListener('error',bad)});
    // Paint before starting the recorder so the captured track starts with an
    // actual frame rather than an uninitialised canvas.
    paintFrame();
    let stream,sourceStream,recorder,animation,paddingTimer,checkVisibility,interrupt,stopped=false;
    try{
    stream=canvas.captureStream(30);
    if(keepSound){sourceStream=video.captureStream();for(const track of sourceStream.getAudioTracks())stream.addTrack(track);}
    // Keep longer clips inside the same 16 MB upload bound, reserving room
    // for audio, the MP4 container and encoder variation. Output is still
    // checked against the byte limit after recording; this is not a bypass.
    const videoBitsPerSecond=Math.min(6_000_000,Math.floor(16*1024*1024*8*0.85/duration-(keepSound?192_000:0)));
    const chunks=[];recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond});
    const done=new Promise((resolve,reject)=>{recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.onerror=()=>reject(Error('Video voorbereiden is mislukt.'));recorder.onstop=()=>{let b=new Blob(chunks,{type:recorder.mimeType||'video/mp4'});b.size?resolve(b):reject(Error('De voorbereide video is leeg.'))}});
    let started=performance.now(),paddingUntil=0,frozenFrame=null,failure=null,lastMediaTime=start,drawCount=0;
    const finish=()=>{if(stopped)return;stopped=true;video.pause();if(recorder.state!=='inactive')recorder.stop()};
    interrupt=()=>{failure='De voorbereiding werd onderbroken. Houd RIG in beeld en probeer opnieuw.';finish()};
    checkVisibility=()=>{if(document.visibilityState!=='visible'||!document.hasFocus())interrupt()};
    document.addEventListener('visibilitychange',checkVisibility);window.addEventListener('blur',interrupt);
    function draw(){
      if(stopped)return;
      if(document.visibilityState!=='visible'||!document.hasFocus()){interrupt();return}
      // At the 3s provider minimum keep re-drawing the last frame briefly. The
      // remote transformer can otherwise drop the last frame and emit <3s.
      if(paddingUntil){
        canvas.getContext('2d').drawImage(frozenFrame,0,0);
        if(performance.now()>=paddingUntil){finish();return;}
        animation=requestAnimationFrame(draw);return;
      }
      // If playback advances while painting stalls, a 9 s container can have
      // only a few seconds of actual motion. Refuse the incomplete recording.
      if(video.currentTime-lastMediaTime>0.4){interrupt();return}
      lastMediaTime=video.currentTime;drawCount++;
      const progress=(video.currentTime-start)/duration;onProgress(Math.max(0,Math.min(1,progress)));
      if(video.currentTime>=start+duration-0.025 || video.ended){
        video.pause();
        if(duration===3){frozenFrame=document.createElement('canvas');frozenFrame.width=d.width;frozenFrame.height=d.height;frozenFrame.getContext('2d').drawImage(canvas,0,0);paddingUntil=performance.now()+160;paddingTimer=setTimeout(finish,1000);animation=requestAnimationFrame(draw);return;}
        stopped=true;recorder.stop();return;
      }
      paintFrame();
      if(performance.now()-started>(duration+20)*1000){stopped=true;video.pause();recorder.stop();return;}
      animation=requestAnimationFrame(draw);
    }
    // Start painting before awaiting play(): a delayed play promise must not
    // leave the canvas unchanged while audio or the media clock advances.
    recorder.start(500);draw();await Promise.race([video.play(),done.then(()=>{throw Error(failure||'De voorbereiding werd onderbroken.')})]);const result=await done;if(failure)throw Error(failure);if(video.currentTime<start+duration-0.2||drawCount<duration*20)throw Error('De video is niet volledig voorbereid. Houd RIG in beeld en probeer opnieuw.');const actualDuration=await validateRecording(result,duration);return {blob:result,name:'rig-beweging.mp4',type:result.type,duration:actualDuration,width:d.width,height:d.height};
    }finally{
      stopped=true;if(checkVisibility)document.removeEventListener('visibilitychange',checkVisibility);if(interrupt)window.removeEventListener('blur',interrupt);clearTimeout(paddingTimer);if(animation!==undefined)cancelAnimationFrame(animation);
      try{video.pause()}catch{}
      if(recorder&&recorder.state!=='inactive')try{recorder.stop()}catch{}
      const tracks=new Set();for(const item of [stream,sourceStream])if(item)try{for(const track of item.getTracks())tracks.add(track)}catch{}
      for(const track of tracks)try{track.stop()}catch{}
    }
  }
  window.rigMedia={bounds,dimensions,paint,prepareImage,prepareImageFile,prepareVideo,recordingDuration,videoDimensions};
})();
