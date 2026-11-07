// Strict, deliberately narrow ISO-BMFF inspection of held output bytes.
// Does not decode H.264 or prove the provider's bill. Not connected to RIG.
const MAX=16*1024*1024, MAX_MOOV=256*1024, MAX_BOXES=256, MAX_SAMPLES=1800;
export function inspectMp4(data){
 if(!(data instanceof Uint8Array)||data.byteLength<32||data.byteLength>MAX)throw Error('invalid MP4 size');
 const view=new DataView(data.buffer,data.byteOffset,data.byteLength);let boxesSeen=0;
 const u32=p=>{if(p<0||p+4>data.length)throw Error('truncated MP4');return view.getUint32(p)};
 const u16=p=>{if(p<0||p+2>data.length)throw Error('truncated MP4');return view.getUint16(p)};
 const str=(p,n)=>String.fromCharCode(...data.subarray(p,p+n));
 const boxes=(start,end)=>{const out=[];let p=start;while(p<end){if(++boxesSeen>MAX_BOXES||p+8>end)throw Error('bad MP4 boxes');const n=u32(p);if(n<8||p+n>end)throw Error('bad MP4 box length');out.push({type:str(p+4,4),p,start:p+8,end:p+n,size:n});p+=n}if(p!==end)throw Error('bad MP4 boxes');return out};
 const one=(list,type)=>{const a=list.filter(b=>b.type===type);if(a.length!==1)throw Error('missing or duplicate '+type);return a[0]};
 const child=(box)=>boxes(box.start,box.end);
 const need=(b,n)=>{if(b.end-b.start<n)throw Error('truncated '+b.type)};
 const table=(b,width,max=MAX_SAMPLES)=>{need(b,8);const count=u32(b.start+4);if(count>max||b.start+8+count*width!==b.end)throw Error('invalid '+b.type);return count};
 const top=boxes(0,data.length);one(top,'ftyp');const moov=one(top,'moov'),mdat=one(top,'mdat');if(moov.size>MAX_MOOV||top.some(b=>b.type==='moof'))throw Error('unsupported MP4');
 const root=child(moov),mvhd=one(root,'mvhd');need(mvhd,20);if(data[mvhd.start]!==0)throw Error('unsupported movie header');const movieScale=u32(mvhd.start+12);if(!movieScale)throw Error('bad timescale');
 const tracks=root.filter(b=>b.type==='trak');if(!tracks.length||tracks.length>2)throw Error('unsupported tracks');let video=null,audio=0;
 for(const trak of tracks){
  const tc=child(trak),mdia=one(tc,'mdia'),mc=child(mdia),hdlr=one(mc,'hdlr');need(hdlr,12);const kind=str(hdlr.start+8,4);
  if(kind==='soun'){audio++;continue}if(kind!=='vide'||video)throw Error('unsupported tracks');
  const mdhd=one(mc,'mdhd');need(mdhd,20);if(data[mdhd.start]!==0)throw Error('unsupported media header');const scale=u32(mdhd.start+12),mediaDuration=u32(mdhd.start+16);if(!scale||!mediaDuration)throw Error('bad media duration');
  const minf=child(one(mc,'minf')),stbl=child(one(minf,'stbl'));
  const dinf=child(one(minf,'dinf')),dref=one(dinf,'dref');need(dref,20);if(u32(dref.start+4)!==1||u32(dref.start+8)!==12||str(dref.start+12,4)!=='url '||u32(dref.start+16)!==1||dref.size!==28)throw Error('external data reference');
  const stsd=one(stbl,'stsd');need(stsd,44);if(u32(stsd.start+4)!==1)throw Error('unsupported sample descriptions');const entry=stsd.start+8,entrySize=u32(entry),codec=str(entry+4,4);if(entrySize<86||entry+entrySize!==stsd.end||!['avc1','avc3'].includes(codec))throw Error('unsupported codec');
  const width=u16(entry+32),height=u16(entry+34);const tkhd=one(tc,'tkhd');need(tkhd,8);if(u32(tkhd.end-8)!==width*65536||u32(tkhd.end-4)!==height*65536)throw Error('inconsistent dimensions');if(width<340||height<340||width>1280||height>1280)throw Error('invalid dimensions');
  const stts=one(stbl,'stts'),times=table(stts,8);let count=0,duration=0,maxDelta=0;
  // Variable-rate encoders can emit a pair of frames very close together or
  // hold a frame for longer during a brief stall. These individual intervals
  // are not the clip frame rate. Keep them nonzero and bounded while enforcing
  // the supported average, total duration and sample-count limits below.
  for(let i=0;i<times;i++){const n=u32(stts.start+8+i*8),delta=u32(stts.start+12+i*8);if(!n||!delta||delta>scale)throw Error('unsupported frame rate');maxDelta=Math.max(maxDelta,delta);count+=n;duration+=n*delta;if(count>MAX_SAMPLES||!Number.isSafeInteger(duration))throw Error('sample limit')}
  // Some encoders write a slightly different media-header duration and
  // sample-time total. A bounded discrepancy can be handled conservatively:
  // validate both, and later price against the longest verified duration.
  if(Math.abs(duration-mediaDuration)>scale/10)throw Error('duration metadata mismatch');
  if(duration/scale<3||mediaDuration/scale<3){
   const error=Error('video duration below minimum');
   // Only numeric timing fields from the validated bounded sample table.
   if(count>0&&count<=MAX_SAMPLES&&duration>0)error.rigDurationMetrics={sampleDurationSeconds:duration/scale,mediaHeaderDurationSeconds:mediaDuration/scale,frameCount:count};
   throw error;
  }
  if(duration/scale>30||mediaDuration/scale>30)throw Error('video duration above maximum');
  // Cloudflare can preserve variable input timing. Use the actual sample
  // durations, not a hard-coded 30 fps, while keeping processing bounded.
  const fps=count*scale/duration;if(!Number.isFinite(fps)||fps<20||fps>60)throw Error('unsupported frame rate');
  const stsz=one(stbl,'stsz');need(stsz,12);const fixed=u32(stsz.start+4),n=u32(stsz.start+8);if(n!==count||stsz.end!==stsz.start+12+(fixed?0:4*n))throw Error('invalid sample sizes');
  const sizes=[];for(let i=0;i<n;i++){const x=fixed||u32(stsz.start+12+4*i);if(!x||x>MAX)throw Error('invalid sample');sizes.push(x)}
  const stsc=one(stbl,'stsc'),sc=table(stsc,12);if(!sc)throw Error('missing chunks');const map=[];for(let i=0;i<sc;i++){const p=stsc.start+8+12*i,first=u32(p),per=u32(p+4),desc=u32(p+8);if(!first||!per||per>MAX_SAMPLES||desc!==1||(i===0?first!==1:first<=map[i-1].first))throw Error('invalid chunks');map.push({first,per})}
  const offsets=stbl.filter(b=>b.type==='stco'||b.type==='co64');if(offsets.length!==1)throw Error('invalid offsets');const off=offsets[0],wide=off.type==='co64',num=table(off,wide?8:4);if(!num||map.at(-1).first>num)throw Error('invalid chunks');
  let sample=0,mi=0;const ranges=[];for(let i=0;i<num;i++){while(mi+1<map.length&&map[mi+1].first<=i+1)mi++;let pos;if(wide){const raw=view.getBigUint64(off.start+8+i*8);if(raw>BigInt(Number.MAX_SAFE_INTEGER))throw Error('invalid offset');pos=Number(raw)}else pos=u32(off.start+8+i*4);const begin=pos;for(let j=0;j<map[mi].per;j++){if(sample>=n)throw Error('sample overflow');pos+=sizes[sample++]}if(begin<mdat.start||pos>mdat.end||pos<=begin)throw Error('missing media data');ranges.push([begin,pos])}
  if(sample!==n)throw Error('missing samples');ranges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])throw Error('overlapping chunks');
  let presentationDuration=duration/scale;
  const edit=tc.filter(b=>b.type==='edts');if(edit.length>1)throw Error('duplicate edits');
  if(edit.length){
   const elst=one(child(edit[0]),'elst');need(elst,8);
   const version=data[elst.start],entries=u32(elst.start+4),width=version===0?12:version===1?20:0;
   if(!width||entries<1||entries>2||elst.end!==elst.start+8+entries*width)throw Error('unsupported edits');
   let total=0,empty=0;
   for(let i=0;i<entries;i++){
    const p=elst.start+8+i*width;let segment,start;
    if(version===0){segment=u32(p);start=view.getInt32(p+4)}
    else{
     const a=view.getBigUint64(p),b=view.getBigInt64(p+8);
     if(a>BigInt(Number.MAX_SAFE_INTEGER)||b>BigInt(Number.MAX_SAFE_INTEGER)||b<BigInt(Number.MIN_SAFE_INTEGER))throw Error('unsupported edits');
     segment=Number(a);start=Number(b);
    }
    const rate=p+(version===0?8:16);
    if(!segment||u16(rate)!==1||u16(rate+2)!==0)throw Error('unsupported edits');
    // Only a short initial empty edit followed by one normal edit is allowed.
    if(entries===2&&i===0){if(start!==-1||segment/movieScale>0.25)throw Error('unsupported edits');empty=segment}
    else{
     if(start<0||start>=mediaDuration)throw Error('unsupported edits');
     // Allow a small composition delay for reordered frames, but not an edit
     // extending well past the verified media or pretending missing frames exist.
     if(start/scale+segment/movieScale>Math.max(duration,mediaDuration)/scale+0.251001)throw Error('unsupported edits');
    }
    total+=segment;if(!Number.isSafeInteger(total))throw Error('unsupported edits');
   }
   presentationDuration=total/movieScale;
   // Compare the playable media against its sample timeline. A bounded empty
   // initial edit is presentation time, not an extra decoded media sample.
   // It remains included in the 3–30 second limit and conservative price.
   const playableDuration=(total-empty)/movieScale;
   if(Math.abs(playableDuration-duration/scale)>maxDelta/scale+1/movieScale+1e-9||presentationDuration<3||presentationDuration>30)throw Error('unsupported edits');
  }
  // Bill against the more conservative verified value, never rounded down.
  video={mime:'video/mp4',codec:'h264',width,height,fps,frameCount:count,sampleDurationSeconds:duration/scale,durationSeconds:Math.max(duration/scale,mediaDuration/scale,presentationDuration),inspectionLevel:'container-only'};
 }
 if(!video||audio>1)throw Error('missing video');return {...video,hasAudio:audio===1};
}
