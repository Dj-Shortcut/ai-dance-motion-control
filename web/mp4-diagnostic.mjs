// Read-only, bounded, coarse diagnosis of a rejected private transcode.
// Never used to accept media or determine price. No user data or raw error
// strings are returned; the result contains fixed category names only.
const reasons={
 'unsupported edits':'edit','unsupported edit layout':'edit_layout','duplicate edits':'edit_layout',
 'unsupported edit start':'edit_start','unsupported edit rate':'edit_rate',
 'unsupported edit timing':'edit_timing','unsupported edit duration':'edit_duration',
 'unsupported codec':'codec','unsupported sample descriptions':'codec',
 'unsupported tracks':'tracks','missing video':'tracks',
 'unsupported movie header':'header','unsupported media header':'header','bad timescale':'header',
 'invalid MP4 size':'structure','truncated MP4':'structure','bad MP4 boxes':'structure',
 'bad MP4 box length':'structure','unsupported MP4':'structure','external data reference':'structure',
 'sample limit':'samples','invalid sample sizes':'samples','invalid sample':'samples',
 'missing chunks':'samples','invalid chunks':'samples','invalid offsets':'samples','invalid offset':'samples',
 'sample overflow':'samples','missing media data':'samples','missing samples':'samples','overlapping chunks':'samples',
 'unsupported frame rate':'fps','duration metadata mismatch':'duration',
 'video duration below minimum':'duration','video duration above maximum':'duration',
 'bad media duration':'duration','invalid dimensions':'dimensions','inconsistent dimensions':'dimensions',
 'Unverified transformed video':'verification'
};
export const diagnosticCodes=Object.freeze(['structure','header','tracks','codec','dimensions','fps','duration','samples','edit','edit_layout','edit_start','edit_rate','edit_timing','edit_duration','verification']);
export function diagnoseMp4(data,reason){
 const codes=new Set();const mark=x=>{if(diagnosticCodes.includes(x))codes.add(x)};
 if(Object.hasOwn(reasons,reason))mark(reasons[reason]);
 else if(typeof reason==='string'&&/^(?:missing or duplicate|truncated|invalid) (?:ftyp|moov|mdat|mvhd|mdia|hdlr|mdhd|minf|stbl|dinf|dref|stsd|tkhd|stts|stsz|stsc|stco|co64|elst)$/.test(reason))mark('structure');
 try{
  if(!(data instanceof Uint8Array)||data.length<32||data.length>16*1024*1024)throw 0;
  const v=new DataView(data.buffer,data.byteOffset,data.byteLength);let seen=0;
  const u32=p=>{if(p<0||p+4>data.length)throw 0;return v.getUint32(p)},i32=p=>{if(p<0||p+4>data.length)throw 0;return v.getInt32(p)},u16=p=>{if(p<0||p+2>data.length)throw 0;return v.getUint16(p)};
  const str=(p,n)=>String.fromCharCode(...data.subarray(p,p+n));
  const boxes=(a,b)=>{const out=[];while(a<b){if(++seen>256||a+8>b)throw 0;const n=u32(a);if(n<8||a+n>b)throw 0;out.push({type:str(a+4,4),start:a+8,end:a+n,size:n});a+=n}return out};
  const unique=(a,t)=>{const b=a.filter(x=>x.type===t);if(b.length!==1)throw 0;return b[0]},children=b=>boxes(b.start,b.end),need=(b,n)=>{if(b.end-b.start<n)throw 0};
  const top=boxes(0,data.length);unique(top,'ftyp');const moov=unique(top,'moov');unique(top,'mdat');if(moov.size>256*1024||top.some(b=>b.type==='moof'))mark('structure');
  const root=children(moov),mvhd=unique(root,'mvhd');need(mvhd,20);const movieScale=u32(mvhd.start+12);if(data[mvhd.start]!==0||!movieScale)mark('header');
  const tracks=root.filter(x=>x.type==='trak');if(!tracks.length||tracks.length>2)mark('tracks');let videos=0,audios=0;
  for(const track of tracks){
   const tc=children(track),mdia=unique(tc,'mdia'),mc=children(mdia),hdlr=unique(mc,'hdlr');need(hdlr,12);const kind=str(hdlr.start+8,4);
   if(kind==='soun'){audios++;continue}if(kind!=='vide'){mark('tracks');continue}videos++;
   const mdhd=unique(mc,'mdhd');need(mdhd,20);const scale=u32(mdhd.start+12),mediaDuration=u32(mdhd.start+16);if(data[mdhd.start]!==0||!scale||!mediaDuration){mark('header');continue}
   const minf=children(unique(mc,'minf')),stbl=children(unique(minf,'stbl')),stsd=unique(stbl,'stsd');need(stsd,44);const entry=stsd.start+8;
   if(u32(stsd.start+4)!==1||!['avc1','avc3'].includes(str(entry+4,4)))mark('codec');
   const width=u16(entry+32),height=u16(entry+34);if(width<340||height<340||width>1280||height>1280)mark('dimensions');
   const stts=unique(stbl,'stts');need(stts,8);const times=u32(stts.start+4);if(times>1800||stts.start+8+times*8!==stts.end)throw 0;
   let count=0,duration=0,maxDelta=0;for(let i=0;i<times;i++){const n=u32(stts.start+8+i*8),delta=u32(stts.start+12+i*8);if(!n||!delta||delta>scale)mark('fps');count+=n;duration+=n*delta;maxDelta=Math.max(maxDelta,delta);if(count>1800||!Number.isSafeInteger(duration))throw 0}
   if(!duration||count*scale/duration<20||count*scale/duration>60)mark('fps');
   if(Math.abs(duration-mediaDuration)>scale/10||Math.min(duration,mediaDuration)/scale<3||Math.max(duration,mediaDuration)/scale>30)mark('duration');
   const edits=tc.filter(x=>x.type==='edts');if(edits.length>1)mark('edit_layout');
   for(const edit of edits.slice(0,2)){
    const es=children(edit).filter(x=>x.type==='elst');if(es.length!==1){mark('edit_layout');continue}const elst=es[0];if(elst.end-elst.start<20){mark('edit_layout');continue}
    if(data[elst.start]!==0||u32(elst.start+4)!==1||elst.end!==elst.start+20){mark('edit_layout');continue}
    if(i32(elst.start+12)<0||i32(elst.start+12)>=mediaDuration)mark('edit_start');
    if(u16(elst.start+16)!==1||u16(elst.start+18)!==0)mark('edit_rate');
    if(movieScale){const p=u32(elst.start+8)/movieScale;if(Math.abs(p-duration/scale)>maxDelta/scale+1/movieScale+1e-9)mark('edit_timing');if(p<3||p>30)mark('edit_duration')}
   }
  }
  if(videos!==1||audios>1)mark('tracks');
 }catch{mark('structure')}
 return [...codes].slice(0,12);
}
