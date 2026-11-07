// Local-test helpers. The identity used for UI storage comes from the verified
// backend session endpoint; requests re-check it with the exact bearer token.
export async function prepareBoundUi({auth,browser}) {
  const response=await auth.api('/api/session');
  let body;try{body=await response.json()}catch{throw Error('Aanmelding kon niet worden gecontroleerd.');}
  const userId=body?.userId;
  if(!response.ok||!/^u-[0-9a-f-]{36}$/.test(userId||''))throw Error('Aanmelding kon niet worden gecontroleerd.');
  const prefix=`rig-user:${userId}:`,storage=browser.sessionStorage;
  let epoch=0,disposed=false;const pending=new Set();
  const check=expected=>{if(disposed || expected!==epoch)throw Error('De aanmelding is beëindigd.');};
  const scopedStorage={getItem:k=>{check(epoch);return storage.getItem(prefix+k);},setItem:(k,v)=>{check(epoch);return storage.setItem(prefix+k,v);},removeItem:k=>{check(epoch);return storage.removeItem(prefix+k);}};
  async function request(path,options={}) {
    const start=epoch;check(start);const controller=new AbortController();pending.add(controller);
    const relay=()=>controller.abort();options.signal?.addEventListener('abort',relay,{once:true});
    if(options.signal?.aborted)controller.abort();
    try{const res=await auth.api(path,{...options,signal:controller.signal},userId);if(disposed||start!==epoch||controller.signal.aborted){if(res.body)void res.body.cancel().catch(()=>{});throw Error('De aanmelding is beëindigd.');}return res;}
    finally{pending.delete(controller);options.signal?.removeEventListener('abort',relay);}
  }
  let currentVideoUrl=null,videoController=null,videoSequence=0;
  async function openVideo(path){
    if(!/^\/api\/generations\/[A-Za-z0-9_-]{1,100}\/video$/.test(path))throw Error('Ongeldig resultaat.');
    const start=epoch;check(start);if(videoController)videoController.abort();
    const sequence=++videoSequence,controller=new AbortController();videoController=controller;pending.add(controller);
    const checkVideo=()=>{check(start);if(sequence!==videoSequence||controller.signal.aborted)throw Error('Het resultaat is niet meer actueel.');};
    let reader,res;const cancel=()=>{if(reader)void reader.cancel().catch(()=>{});else if(res?.body)void res.body.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
    try{
      res=await request(path,{cache:'no-store',signal:controller.signal});checkVideo();
      if(!res.ok || !/^video\/mp4(?:;|$)/i.test(res.headers.get('content-type')||'') || !res.body)throw Error('Het resultaat kon niet worden geladen.');
      reader=res.body.getReader();const chunks=[];let size=0;
      for(;;){const {value,done}=await reader.read();checkVideo();if(done)break;size+=value.byteLength;if(size>100*1024*1024)throw Error('Het resultaat is te groot.');chunks.push(value);}
      checkVideo();const next=browser.URL.createObjectURL(new Blob(chunks,{type:'video/mp4'}));
      if(disposed || start!==epoch || sequence!==videoSequence || controller.signal.aborted){browser.URL.revokeObjectURL(next);throw Error('De aanmelding is beëindigd.');}
      if(currentVideoUrl)browser.URL.revokeObjectURL(currentVideoUrl);
      currentVideoUrl=next;return next;
    }catch(e){if(reader)await reader.cancel().catch(()=>{});else if(res?.body)void res.body.cancel().catch(()=>{});throw e;}
    finally{pending.delete(controller);if(videoController===controller)videoController=null;controller.signal.removeEventListener('abort',cancel);}
  }
  function dispose(){
    if(disposed)return;disposed=true;epoch++;for(const controller of pending)controller.abort();pending.clear();
    if(currentVideoUrl){browser.URL.revokeObjectURL(currentVideoUrl);currentVideoUrl=null;}
    const doc=browser.document;if(doc){const studio=doc.getElementById('rigStudio'),video=doc.getElementById('resultVideo'),link=doc.getElementById('export');if(studio)studio.hidden=true;if(video){try{video.pause?.()}catch{}video.removeAttribute('src');video.hidden=true;}if(link){link.removeAttribute('href');link.hidden=true;}}
  }
  return {userId,scopedStorage,request,openVideo,dispose,isActive:()=>!disposed};
}
