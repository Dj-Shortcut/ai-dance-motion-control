// Local-test helpers. The identity used for UI storage comes from the verified
// backend session endpoint; requests re-check it with the exact bearer token.
const USER=/^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRIAL_KEY='rig-trial-continuation:v1',TRIAL_TTL=86400000;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const finite=value=>Number.isFinite(value)&&value>=0&&value<=604800;
const safeText=value=>typeof value==='string'&&!/(?:https?:\/\/|blob:|data:|file:\/\/|\bBearer\s)/i.test(value);
function validTrialDraft(raw){
 if(typeof raw!=='string'||raw.length>8192||new TextEncoder().encode(raw).byteLength>16384)return false;
 try{
  const value=JSON.parse(raw),d=value?.draft,now=Date.now(),id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x);
  const crop=c=>exact(c,['x','y','w','h'])&&Object.values(c).every(Number.isFinite)&&c.x>=0&&c.y>=0&&c.w>0&&c.h>0&&c.x+c.w<=100&&c.y+c.h<=100;
  const file=f=>exact(f,['name','type','size','lastModified'])&&safeText(f.name)&&f.name.length<=256&&safeText(f.type)&&f.type.length<=100&&Number.isSafeInteger(f.size)&&f.size>0&&Number.isFinite(f.lastModified)&&f.lastModified>=0;
  if(!exact(value,['version','token','createdAt','state','quoteId','jobId','draft'])||value.version!==1||!id(value.token)||!id(value.quoteId)||value.jobId!==null&&!id(value.jobId)||!['pending','accepted','completed'].includes(value.state)||!Number.isFinite(value.createdAt)||value.createdAt>now+60000||now-value.createdAt>=TRIAL_TTL)return false;
  if(!exact(d,['person','motion','mode','editQuality','quality','start','seconds','prompt','sound','steady','cleanup','frameTime','crops','mainSelection','faceRequired','angleCount'])||!file(d.person)||!file(d.motion)||!['motion','edit'].includes(d.mode)||!['standard','pro','edit-standard','human-recast'].includes(d.quality)||d.editQuality!==null&&!['edit-standard','human-recast'].includes(d.editQuality)||d.mode==='motion'&&!['standard','pro'].includes(d.quality)||d.mode==='edit'&&!['edit-standard','human-recast'].includes(d.quality)||!finite(d.start)||!Number.isInteger(d.seconds)||d.seconds<1||d.seconds>604800||typeof d.prompt!=='string'||d.prompt.length>1900||!['sound','steady','cleanup','faceRequired'].every(key=>typeof d[key]==='boolean')||!finite(d.frameTime)||!Number.isInteger(d.angleCount)||d.angleCount<0||d.angleCount>3||!exact(d.crops,['person','motion'])||!crop(d.crops.person)||!crop(d.crops.motion))return false;
  return d.mainSelection===null||exact(d.mainSelection,['time','crop'])&&(d.mainSelection.time===null||finite(d.mainSelection.time))&&crop(d.mainSelection.crop);
 }catch{return false;}
}
export async function prepareBoundUi({auth,browser}) {
  const response=await auth.api('/api/session');
  let body;try{body=await response.json()}catch{throw Error('Aanmelding kon niet worden gecontroleerd.');}
  const userId=body?.userId;
  if(!response.ok||!USER.test(userId||''))throw Error('Aanmelding kon niet worden gecontroleerd.');
  const prefix=`rig-user:${userId}:`,storage=browser.sessionStorage;
  let epoch=0,disposed=false;const pending=new Set();
  const check=expected=>{if(disposed || expected!==epoch)throw Error('De aanmelding is beëindigd.');};
  const scopedStorage={getItem:k=>{check(epoch);return storage.getItem(prefix+k);},setItem:(k,v)=>{check(epoch);return storage.setItem(prefix+k,v);},removeItem:k=>{check(epoch);return storage.removeItem(prefix+k);}};
  let draftLocal=null;try{const candidate=browser.localStorage;if(['getItem','setItem','removeItem'].every(key=>typeof candidate?.[key]==='function'))draftLocal=candidate;}catch{}
  const draftKey=prefix+TRIAL_KEY;
  const draftAllowed=key=>{check(epoch);if(key!==TRIAL_KEY)throw Error('Alleen proefvervolgmetadata kan hier bewaard worden.');};
  const removeDraft=()=>{try{browser.localStorage?.removeItem(draftKey);}catch{}try{storage.removeItem(draftKey);}catch{}};
  const draftStorage={
    getItem(key){
      draftAllowed(key);let value,target=draftLocal??storage;
      try{value=target.getItem(draftKey);}catch{draftLocal=null;target=storage;try{value=target.getItem(draftKey);}catch{return null;}}
      if(value===null)return null;
      if(!validTrialDraft(value)){try{target.removeItem(draftKey);}catch{}return null;}
      return value;
    },
    setItem(key,value){
      draftAllowed(key);if(!validTrialDraft(value))return false;
      if(draftLocal){try{draftLocal.setItem(draftKey,value);try{storage.removeItem(draftKey);}catch{}return true;}catch{try{draftLocal.removeItem(draftKey);}catch{}draftLocal=null;}}
      try{storage.setItem(draftKey,value);return true;}catch{return false;}
    },
    removeItem(key){draftAllowed(key);removeDraft();}
  };
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
  function dispose({logout=false}={}){
    if(disposed)return;if(logout===true)removeDraft();disposed=true;epoch++;for(const controller of pending)controller.abort();pending.clear();
    if(currentVideoUrl){browser.URL.revokeObjectURL(currentVideoUrl);currentVideoUrl=null;}
    const doc=browser.document;if(doc){const studio=doc.getElementById('rigStudio'),video=doc.getElementById('resultVideo'),link=doc.getElementById('export');if(studio)studio.hidden=true;if(video){try{video.pause?.()}catch{}video.removeAttribute('src');video.hidden=true;}if(link){link.removeAttribute('href');link.hidden=true;}}
  }
  return {userId,scopedStorage,draftStorage,request,openVideo,dispose,isActive:()=>!disposed};
}
