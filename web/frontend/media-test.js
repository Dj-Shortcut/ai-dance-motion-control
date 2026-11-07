'use strict';
(()=>{
 const get=id=>document.getElementById(id),button=get('testSubmit'),message=get('testMessage');let active=false;
 button.addEventListener('click',async()=>{
  if(active)return;const f=get('testFile').files[0];if(!f){message.textContent='Kies eerst een bestand.';return;}
  if(!f.size||f.size>16*1024*1024){message.textContent='Kies een bestand van maximaal 16 MB.';return;}
  const image=['image/jpeg','image/png','image/webp'].includes(f.type),video=['video/mp4','video/quicktime','video/webm'].includes(f.type);
  if(!image&&!video){message.textContent='Dit bestandstype wordt niet ondersteund.';return;}
  const headers={'Content-Type':f.type,'X-Rig-Asset-Kind':video?'video':'image'};
  if(video){const n=Number(get('testDuration').value);if(!Number.isInteger(n)||n<3||n>20){message.textContent='Kies een videolengte van 3 tot 20 seconden.';return;}headers['X-Rig-Duration-Seconds']=String(n);headers['X-Rig-Keep-Sound']=String(get('testSound').checked===true);}
  active=true;button.disabled=true;message.textContent='Bestand wordt verwerkt en de tijdelijke opslag wordt gecontroleerd…';
  try{const r=await fetch('/api/media/test',{method:'POST',credentials:'same-origin',cache:'no-store',headers,body:f});let d;try{d=await r.json()}catch{throw Error('De test kon niet worden gecontroleerd.')}
   if(!r.ok||d.status!=='verified'||d.cleanup!=='ok')throw Error(d.error||'De test kon niet worden afgerond.');
   const duration=video&&Number.isFinite(d.durationSeconds)?` · ${d.durationSeconds.toFixed(2)} seconden`:'';message.textContent=`Test geslaagd: ${d.width} × ${d.height}${duration}. Het tijdelijke bestand is verwijderd.`;
  }catch(e){message.textContent=`${e.message||'De test is mislukt.'} Als opruimen niet bevestigd is, controleer de testopslag.`}
  finally{button.disabled=false;active=false;}
 });
})();
