import {CleanupError,DETECTOR_VERSION} from './cleanup-contract.mjs';
// Thin, pinned Tesseract7 worker-protocol adapter. Owning the native Worker
// immediately makes cancellation also terminate initialization/download work.
// This internal protocol is versioned with the vendored 7.0.0 worker/hash.
export const OCR_ASSETS=Object.freeze({worker:'/multiuser/ocr/v7/worker.min.js',core:'/multiuser/ocr/v7/core',lang:'/multiuser/ocr/v7/eng-best-int',workerSha256:'576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d',languageSha256:'5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747'});
export function createOcrClient({WorkerClass=globalThis.Worker,signal,onProgress=()=>{},timeoutMs=30000}={}){
 if(typeof WorkerClass!=='function')throw new CleanupError('unsupported','Je browser kan lokale tekstherkenning niet uitvoeren.');
 const native=new WorkerClass(OCR_ASSETS.worker,{name:'rig-local-text-ocr-v1'}),workerId='rig-text-mask-v1',pending=new Map();let sequence=0,closed=false;
 function close(reason=new CleanupError('canceled','Tekstherkenning geannuleerd.')){if(closed)return;closed=true;native.terminate();signal?.removeEventListener('abort',abort);for(const p of pending.values()){clearTimeout(p.timer);p.reject(reason);}pending.clear();}
 const abort=()=>close();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)close();
 native.addEventListener('error',()=>close(new CleanupError('ocr','Lokale tekstherkenning kon niet worden gestart.')));
 native.addEventListener('message',event=>{const m=event.data;if(m?.workerId!==workerId)return;const p=pending.get(m.jobId);if(!p||m.action!==p.action)return;if(m.status==='progress'){if(typeof m.data?.progress==='number'){try{onProgress(Math.max(0,Math.min(1,m.data.progress)));}catch(error){close(error);}}return;}clearTimeout(p.timer);pending.delete(m.jobId);if(m.status==='resolve')p.resolve(m.data);else if(m.status==='reject')p.reject(new CleanupError('ocr','Dit beeld kon niet lokaal op tekst worden gecontroleerd.'));else p.reject(new CleanupError('ocr','Tekstherkenning gaf geen geldig antwoord.'));});
 function call(action,payload,limit=timeoutMs){if(closed)return Promise.reject(new CleanupError('canceled','Tekstherkenning geannuleerd.'));return new Promise((resolve,reject)=>{const jobId='mask-'+(++sequence),timer=setTimeout(()=>close(new CleanupError('timeout','Lokale tekstherkenning duurde te lang.')),limit);pending.set(jobId,{action,timer,resolve,reject});try{native.postMessage({workerId,jobId,action,payload});}catch{close(new CleanupError('ocr','Tekstherkenning kon niet worden gestart.'));}});}
 const ready=(async()=>{await call('load',{options:{lstmOnly:true,corePath:OCR_ASSETS.core,logging:false}},120000);await call('loadLanguage',{langs:'eng',options:{langPath:OCR_ASSETS.lang,gzip:true,cacheMethod:'none'}},120000);await call('initialize',{langs:'eng',oem:1,config:{}});await call('setParameters',{params:{tessedit_pageseg_mode:'11',preserve_interword_spaces:'1'}});})();
 // Consume a cancellation before the first recognize() call; callers still
 // observe the same rejection when awaiting ready/recognize.
 ready.catch(()=>{});
 return {version:DETECTOR_VERSION,ready,close,async recognize(image){await ready;if(!(image instanceof Blob)||image.type!=='image/png'||image.size<1||image.size>16*1024*1024)throw new CleanupError('image','Het controlebeeld is niet geldig.');const bytes=new Uint8Array(await image.arrayBuffer());if(signal?.aborted||closed)throw new CleanupError('canceled','Tekstherkenning geannuleerd.');return call('recognize',{image:bytes,options:{},output:{blocks:true,text:false,hocr:false,tsv:false}});}};
}
