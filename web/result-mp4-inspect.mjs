// Bounded ISO-BMFF structural validation for generated results. This verifies
// container/track/sample structure, not video decoding or visual correctness.
const MAX=64*1024*1024,MAX_BOXES=20000,MAX_SAMPLES=1000000;
// Top-level boxes have already been parsed in ascending file order and do not
// overlap. Binary search prevents a chunk/fragment times mdat quadratic scan.
function mediaContains(mdats,begin,end,after=0,onCompare){
 let low=0,high=mdats.length;
 while(low<high){if(onCompare)onCompare();const middle=Math.floor((low+high)/2);if(mdats[middle].start<=begin)low=middle+1;else high=middle}
 const m=mdats[low-1];return !!m&&m.p>=after&&begin>=m.start&&end<=m.end;
}
export const resultMp4Testing={mediaContains};
export function inspectResultMp4(data){
 if(!(data instanceof Uint8Array)||data.length<32||data.length>MAX)throw Error('Invalid result size');
 const v=new DataView(data.buffer,data.byteOffset,data.byteLength);let visited=0,totalSamples=0;
 const u32=p=>{if(p<0||p+4>data.length)throw Error('Truncated MP4');return v.getUint32(p)};
 const string=(p,n)=>String.fromCharCode(...data.subarray(p,p+n));
 const boxes=(start,end)=>{const out=[];let p=start;while(p<end){if(++visited>MAX_BOXES||p+8>end)throw Error('Invalid MP4 boxes');let size=u32(p),header=8;if(size===1){if(p+16>end)throw Error('Truncated MP4 box');const n=v.getBigUint64(p+8);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Oversized MP4 box');size=Number(n);header=16}else if(size===0)size=end-p;if(size<header||p+size>end)throw Error('Truncated MP4 box');out.push({type:string(p+4,4),p,start:p+header,end:p+size});p+=size}return out};
 const one=(list,type)=>{const x=list.filter(b=>b.type===type);if(x.length!==1)throw Error('Missing or duplicate '+type);return x[0]};
 const child=b=>boxes(b.start,b.end),need=(b,n)=>{if(b.end-b.start<n)throw Error('Truncated '+b.type)};
 const table=(b,width)=>{need(b,8);const n=u32(b.start+4);if(n>MAX_SAMPLES||b.start+8+n*width!==b.end)throw Error('Invalid '+b.type);return n};
 const top=boxes(0,data.length),ftyp=one(top,'ftyp'),moov=one(top,'moov'),mdats=top.filter(b=>b.type==='mdat'&&b.end>b.start);need(ftyp,8);if(!mdats.length||moov.end-moov.start>8*1024*1024)throw Error('Missing media');
 const root=child(moov),fragments=top.filter(b=>b.type==='moof');let validVideo=0;
 for(const trak of root.filter(b=>b.type==='trak')){
  const tc=child(trak),mc=child(one(tc,'mdia')),handler=one(mc,'hdlr');need(handler,12);if(string(handler.start+8,4)!=='vide')continue;
  const tkhd=one(tc,'tkhd');need(tkhd,24);const version=data[tkhd.start],idOffset=version===0?12:version===1?20:-1;if(idOffset<0||tkhd.start+idOffset+4>tkhd.end)throw Error('Invalid track header');const trackId=u32(tkhd.start+idOffset);if(!trackId)throw Error('Invalid track id');
  const mdhd=one(mc,'mdhd');need(mdhd,20);const mdver=data[mdhd.start],scaleAt=mdver===0?12:mdver===1?20:-1;if(scaleAt<0||mdhd.start+scaleAt+4>mdhd.end||!u32(mdhd.start+scaleAt))throw Error('Invalid media timescale');
  const stbl=child(one(child(one(mc,'minf')),'stbl')),stsd=one(stbl,'stsd');need(stsd,16);const descriptions=u32(stsd.start+4);if(!descriptions||descriptions>100)throw Error('Invalid descriptions');const entries=boxes(stsd.start+8,stsd.end);if(entries.length!==descriptions)throw Error('Invalid descriptions');
  const configs={avc1:'avcC',avc3:'avcC',hvc1:'hvcC',hev1:'hvcC',av01:'av1C',vp09:'vpcC'};let videoDescription=false;
  for(const entry of entries){const config=configs[entry.type];if(!config)continue;if(entry.end-entry.start<78)throw Error('Truncated video description');const width=v.getUint16(entry.p+32),height=v.getUint16(entry.p+34);if(!width||!height||width>16384||height>16384)throw Error('Invalid video dimensions');const codec=child({start:entry.start+78,end:entry.end}).find(x=>x.type===config);if(!codec||codec.end-codec.start<4)throw Error('Missing video codec configuration');videoDescription=true}
  if(!videoDescription)throw Error('Unsupported video track');
  const stsz=one(stbl,'stsz');need(stsz,12);const fixed=u32(stsz.start+4),count=u32(stsz.start+8);if(count>MAX_SAMPLES||stsz.end!==stsz.start+12+(fixed?0:count*4))throw Error('Invalid sample sizes');
  if(count){
   totalSamples+=count;if(totalSamples>MAX_SAMPLES)throw Error('Too many total samples');
   const stts=one(stbl,'stts'),times=table(stts,8);let timed=0;for(let i=0;i<times;i++){const n=u32(stts.start+8+8*i),duration=u32(stts.start+12+8*i);if(!n||!duration)throw Error('Invalid sample time');timed+=n;if(timed>MAX_SAMPLES)throw Error('Too many samples')}if(timed!==count)throw Error('Missing sample timing');
   const sizes=new Uint32Array(count);for(let i=0;i<count;i++){const n=fixed||u32(stsz.start+12+i*4);if(!n||n>MAX)throw Error('Invalid sample');sizes[i]=n}
   const stsc=one(stbl,'stsc'),mapping=table(stsc,12);if(!mapping)throw Error('Missing chunks');const ranges=[];for(let i=0;i<mapping;i++){const at=stsc.start+8+i*12,first=u32(at),per=u32(at+4),desc=u32(at+8);if(!first||!per||desc<1||desc>descriptions||(i===0?first!==1:first<=ranges[i-1].first))throw Error('Invalid chunk map');ranges.push({first,per})}
   const offsetBoxes=stbl.filter(b=>b.type==='stco'||b.type==='co64');if(offsetBoxes.length!==1)throw Error('Missing chunk offsets');const offsets=offsetBoxes[0],wide=offsets.type==='co64',chunks=table(offsets,wide?8:4);if(!chunks||ranges.at(-1).first>chunks)throw Error('Invalid chunk offsets');let sample=0,mi=0;const chunkRanges=[];
   for(let i=0;i<chunks;i++){while(mi+1<ranges.length&&ranges[mi+1].first<=i+1)mi++;const pos=offsets.start+8+i*(wide?8:4),raw=wide?v.getBigUint64(pos):BigInt(u32(pos));if(raw>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Invalid chunk offset');const begin=Number(raw);let end=begin;for(let j=0;j<ranges[mi].per;j++){if(sample>=count)throw Error('Too many chunks');end+=sizes[sample++];if(end>data.length)throw Error('Missing sample data')}if(!mediaContains(mdats,begin,end))throw Error('Chunk outside media');chunkRanges.push([begin,end])}
   if(sample!==count)throw Error('Missing samples');chunkRanges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<chunkRanges.length;i++)if(chunkRanges[i][0]<chunkRanges[i-1][1])throw Error('Overlapping chunks');
  }else{
   if(!fragments.length)throw Error('Missing video samples');
   const mvex=one(root,'mvex'),trexs=child(mvex).filter(x=>x.type==='trex');let trexSize=0;
   for(const trex of trexs){need(trex,24);if(u32(trex.start+4)===trackId)trexSize=u32(trex.start+16)}
   let found=false;const fragmentRanges=[];
   for(const fragment of fragments){const children=child(fragment),trafs=children.filter(x=>x.type==='traf');for(const [trafIndex,traf] of trafs.entries()){
    const fields=child(traf),tfhd=one(fields,'tfhd');need(tfhd,8);if(u32(tfhd.start+4)!==trackId)continue;
    const flags=u32(tfhd.start)&0xffffff;let p=tfhd.start+8,base=null,defaultSize=trexSize;
    if(flags&1){if(p+8>tfhd.end)throw Error('Truncated fragment header');const raw=v.getBigUint64(p);if(raw>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Invalid fragment offset');base=Number(raw);p+=8}
    if(flags&2)p+=4;if(flags&8)p+=4;if(flags&16){if(p+4>tfhd.end)throw Error('Truncated fragment header');defaultSize=u32(p);p+=4}if(flags&32)p+=4;
    if(p!==tfhd.end)throw Error('Invalid fragment header');
    if(base===null&&((flags&0x020000)!==0||trafIndex===0))base=fragment.p;let runEnd=null;
    for(const trun of fields.filter(x=>x.type==='trun')){
     need(trun,8);const bits=u32(trun.start)&0xffffff,n=u32(trun.start+4);if(!n||n>MAX_SAMPLES)throw Error('Invalid fragment samples');totalSamples+=n;if(totalSamples>MAX_SAMPLES)throw Error('Too many total samples');
     const width=((bits&0x100)?4:0)+((bits&0x200)?4:0)+((bits&0x400)?4:0)+((bits&0x800)?4:0),prefix=8+((bits&1)?4:0)+((bits&4)?4:0);
     if(trun.start+prefix+n*width!==trun.end)throw Error('Truncated fragment table');
     let size=0;if(!(bits&0x200)){if(!defaultSize||defaultSize>MAX)throw Error('Invalid fragment sample');size=n*defaultSize;if(!Number.isSafeInteger(size)||size>MAX)throw Error('Oversized fragment')}
     else for(let i=0;i<n;i++){const at=trun.start+prefix+i*width+((bits&0x100)?4:0),bytes=u32(at);if(!bytes||bytes>MAX)throw Error('Invalid fragment sample');size+=bytes;if(size>MAX)throw Error('Oversized fragment')}
     let start;
     if(bits&1){if(base===null)throw Error('Unverifiable fragment base');start=base+v.getInt32(trun.start+8)}else{if(runEnd===null)throw Error('Missing fragment offset');start=runEnd}
     if(!mediaContains(mdats,start,start+size,fragment.end))throw Error('Fragment outside media');runEnd=start+size;fragmentRanges.push([start,runEnd]);
     found=true;
    }
   }}
   if(!found)throw Error('Missing video fragments');fragmentRanges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<fragmentRanges.length;i++)if(fragmentRanges[i][0]<fragmentRanges[i-1][1])throw Error('Overlapping fragments');
  }
  validVideo++;
 }
 if(!validVideo)throw Error('Missing video track');return {inspectionLevel:'container-only',fragmented:fragments.length>0};
}
