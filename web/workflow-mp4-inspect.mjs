// Deliberately narrow inspection of held workflow bytes. Container evidence only:
// this does not decode H264, recognize a mask, or prove any visual result.
const LIMITS=Object.freeze({input:16*1024*1024,result:64*1024*1024,mask:2*1024*1024});
const MAX_BOXES=512,MAX_MOOV=512*1024,MAX_VIDEO=481,MAX_AUDIO=2048;
const encoder=new TextEncoder();
const fail=message=>{throw Error('Workflow MP4: '+message)};
const abs=value=>value<0n?-value:value;
function gcd(a,b){a=abs(a);while(b){const c=a%b;a=b;b=c}return a||1n}
function rational(n,d=1n){if(d<=0n)fail('invalid rational');const g=gcd(n,d);return {n:n/g,d:d/g}}
const add=(a,b)=>rational(a.n*b.d+b.n*a.d,a.d*b.d);
const sub=(a,b)=>rational(a.n*b.d-b.n*a.d,a.d*b.d);
const compare=(a,b)=>a.n*b.d<b.n*a.d?-1:a.n*b.d>b.n*a.d?1:0;
const repr=a=>`${a.n}/${a.d}`;
const number=a=>Number(a.n)/Number(a.d);
const hash=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof data==='string'?encoder.encode(data):data)),v=>v.toString(16).padStart(2,'0')).join('');

// SPS syntax/crop units checked against FFmpeg's primary H264 parameter reader:
// https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/h264_ps.c
// A small progressive8bit420 subset. Reject unfamiliar bitstreams rather than
// pricing against client-controlled stsd dimensions. This is not a decoder.
function rbsp(nal,max,partial=false){
 if(nal.length<2||nal.length>max||(nal[0]&128)!==0)fail('invalid AVC NAL');
 const result=[];let zeros=0;
 for(let i=1;i<nal.length;i++){
  const value=nal[i];if(zeros>=2&&value===3){if(i+1>=nal.length&&partial)break;if(i+1>=nal.length||nal[i+1]>3)fail('invalid AVC escaping');zeros=0;continue}
  result.push(value);zeros=value===0?zeros+1:0;
 }
 return new Uint8Array(result);
}
function bits(bytes){
 let position=0;
 const read=n=>{if(n>32||position+n>bytes.length*8)fail('truncated AVC bits');let value=0;for(let i=0;i<n;i++,position++)value=value*2+((bytes[position>>3]>>(7-(position&7)))&1);return value};
 const ue=()=>{let zeros=0;while(read(1)===0){if(++zeros>24)fail('oversized AVC Golomb')}return 2**zeros-1+read(zeros)};
 const se=()=>{const value=ue();return value&1?(value+1)/2:-(value/2)};
 return {read,ue,se};
}
function spsGeometry(nal,profile){
 if((nal[0]&31)!==7||(nal[0]&96)===0)fail('invalid SPS NAL');
 const b=bits(rbsp(nal,4096)),actualProfile=b.read(8);if(actualProfile!==profile)fail('SPS profile mismatch');
 const constraints=b.read(8),level=b.read(8),id=b.ue();if((constraints&3)!==0||!level||level>62||id>31)fail('unsupported SPS header');
 if([100,244].includes(profile)){
  if(b.ue()!==1||b.ue()!==0||b.ue()!==0)fail('unsupported SPS chroma or bit depth');
  b.read(1);if(b.read(1))fail('unsupported SPS scaling matrix');
 }
 if(b.ue()>12)fail('unsupported SPS frame number');const order=b.ue();
 if(order===0){if(b.ue()>12)fail('unsupported SPS picture order')}
 else if(order===1){b.read(1);b.se();b.se();const cycle=b.ue();if(cycle>16)fail('unsupported SPS order cycle');for(let i=0;i<cycle;i++)b.se()}
 else if(order!==2)fail('unsupported SPS picture order');
 if(b.ue()>16)fail('unsupported SPS reference count');b.read(1);
 const cols=b.ue()+1,rows=b.ue()+1;if(cols>240||rows>240||b.read(1)!==1)fail('unsupported SPS coded dimensions or interlacing');
 b.read(1);let left=0,right=0,top=0,bottom=0;
 if(b.read(1)){left=b.ue();right=b.ue();top=b.ue();bottom=b.ue()}
 if(left!==0||top!==0||2*right>15||2*bottom>15)fail('unsupported SPS crop');
 if(b.read(1)&&b.read(1)){
  const aspect=b.read(8);
  if(aspect===255){const x=b.read(16),y=b.read(16);if(!x||x!==y)fail('non-square SPS pixels')}
  else if(![0,1].includes(aspect))fail('non-square SPS pixels');
 }
 const width=cols*16-2*right,height=rows*16-2*bottom;
 return {id,width,height,macroblocks:cols*rows};
}
function ppsReference(nal,sps){
 if((nal[0]&31)!==8||(nal[0]&96)===0)fail('invalid PPS NAL');const b=bits(rbsp(nal,4096)),id=b.ue(),spsId=b.ue();
 if(id>255||!sps.has(spsId))fail('unknown PPS or SPS reference');b.read(1);b.read(1);if(b.ue()!==0)fail('unsupported PPS slice groups');return {id,spsId};
}
function checkAccessUnits(data,locations,sps,pps,parameterNals){
 for(const location of locations){
  let p=location.start,nals=0,firstSlices=0;
  while(p<location.end){
   if(++nals>128||p+4>location.end)fail('AVC NAL count or truncation');
   const size=(data[p]*16777216)+(data[p+1]*65536)+(data[p+2]*256)+data[p+3];p+=4;
   if(!size||p+size>location.end||(data[p]&128)!==0)fail('invalid AVC access unit');const type=data[p]&31;
   if(type===7||type===8){
    const known=parameterNals.some(nal=>nal.length===size&&nal.every((value,i)=>value===data[p+i]));
    if(!known)fail('in-band parameter changes are unsupported');
   }else if(type===1||type===5){
    const b=bits(rbsp(data.subarray(p,p+Math.min(size,128)),128,size>128)),first=b.ue(),sliceType=b.ue(),id=b.ue();
    if(sliceType>9||!pps.has(id))fail('unsupported AVC slice');
    // Multiple slices need full picture-header comparison. The preparation
    // contract intentionally accepts only one complete first slice per sample.
    if(first!==0||++firstSlices!==1)fail('multiple slices or pictures per sample');
   }else if(type===6){
    const bytes=rbsp(data.subarray(p,p+size),65536);let pos=0,messages=0;
    while(pos<bytes.length&&bytes[pos]!==128){
     if(++messages>16)fail('SEI message limit');let tag=0,length=0;
     while(pos<bytes.length&&bytes[pos]===255){tag+=255;pos++}if(pos>=bytes.length)fail('truncated SEI');tag+=bytes[pos++];
     while(pos<bytes.length&&bytes[pos]===255){length+=255;pos++}if(pos>=bytes.length)fail('truncated SEI');length+=bytes[pos++];
     if(tag!==5||length<16||pos+length>bytes.length)fail('unsupported timing or other SEI');pos+=length;
    }
    if(pos!==bytes.length-1||bytes[pos]!==128)fail('invalid SEI trailing bits');
   }else if(![9,12].includes(type))fail('unsupported AVC NAL type');
   p+=size;
  }
  if(firstSlices!==1)fail('sample does not contain exactly one picture');
 }
}

export async function inspectWorkflowMp4(data,{role='input'}={}){
 if(!Object.hasOwn(LIMITS,role)||!(data instanceof Uint8Array)||typeof SharedArrayBuffer!=='undefined'&&data.buffer instanceof SharedArrayBuffer||data.byteLength<32||data.byteLength>LIMITS[role])fail('invalid role or size');
 const view=new DataView(data.buffer,data.byteOffset,data.byteLength);let seen=0;
 const need=(box,n)=>{if(n<0||box.start+n>box.end)fail('truncated '+box.type)};
 const u16=p=>{if(p<0||p+2>data.length)fail('truncated integer');return view.getUint16(p)};
 const u32=p=>{if(p<0||p+4>data.length)fail('truncated integer');return view.getUint32(p)};
 const i32=p=>{if(p<0||p+4>data.length)fail('truncated integer');return view.getInt32(p)};
 const wide=(p,signed=false)=>{if(p<0||p+8>data.length)fail('truncated integer');return signed?view.getBigInt64(p):view.getBigUint64(p)};
 const text=(p,n)=>String.fromCharCode(...data.subarray(p,p+n));
 const boxes=(start,end)=>{
  const result=[];let p=start;
  while(p<end){
   if(++seen>MAX_BOXES||p+8>end)fail('box limit or truncation');
   let size=u32(p),header=8;
   if(size===1){if(p+16>end)fail('truncated extended box');const value=wide(p+8);if(value>BigInt(data.length))fail('oversized box');size=Number(value);header=16}
   if(size<header||p+size>end)fail('invalid box length');
   result.push({type:text(p+4,4),p,start:p+header,end:p+size,size});p+=size;
  }
  return result;
 };
 const child=box=>boxes(box.start,box.end);
 const one=(list,type)=>{const found=list.filter(box=>box.type===type);if(found.length!==1)fail('missing or duplicate '+type);return found[0]};
 const full=(box,versions=[0])=>{need(box,4);if(!versions.includes(data[box.start])||(u32(box.start)&0xffffff)!==0)fail('unsupported '+box.type+' version or flags')};
 const table=(box,width,max)=>{full(box);need(box,8);const count=u32(box.start+4);if(!count||count>max||box.start+8+count*width!==box.end)fail('invalid '+box.type);return count};
 const top=boxes(0,data.length),ftyp=one(top,'ftyp'),moov=one(top,'moov'),mdat=one(top,'mdat');
 need(ftyp,8);if((ftyp.end-ftyp.start)%4||moov.size>MAX_MOOV||mdat.start===mdat.end||top.some(box=>['moof','mfra'].includes(box.type)))fail('unsupported or fragmented layout');
 const root=child(moov);if(root.some(box=>box.type==='mvex'))fail('fragmented movie');
 const mvhd=one(root,'mvhd');full(mvhd,[0,1]);need(mvhd,data[mvhd.start]===0?20:32);
 const movieScale=BigInt(u32(mvhd.start+(data[mvhd.start]===0?12:20)));
 if(movieScale<1000n||movieScale>1000000000n)fail('unsupported movie timescale');
 const movieDuration=data[mvhd.start]===0?BigInt(u32(mvhd.start+16)):wide(mvhd.start+24);
 const tracks=root.filter(box=>box.type==='trak');if(!tracks.length||tracks.length>2)fail('unsupported track count');
 const chunkRanges=[],ids=new Set();let video=null,audio=null;

 function edits(tc,scale,total,kind){
  const found=tc.filter(box=>box.type==='edts');if(found.length>1)fail('duplicate edits');
  if(!found.length)return {lead:rational(0n),start:0n,length:rational(total,scale),explicit:false};
  const entries=child(found[0]);if(entries.length!==1)fail('unsupported edits');
  const box=one(entries,'elst');full(box,[0,1]);need(box,8);
  const version=data[box.start],count=u32(box.start+4),width=version===0?12:20;
  if(count<1||count>2||box.start+8+count*width!==box.end)fail('unsupported edits');
  let lead=rational(0n),start=null,length=null;
  for(let i=0;i<count;i++){
   const p=box.start+8+i*width,segment=version===0?BigInt(u32(p)):wide(p),mediaStart=version===0?BigInt(i32(p+4)):wide(p+8,true),rate=p+(version===0?8:16);
   if(!segment||u16(rate)!==1||u16(rate+2)!==0)fail('unsupported edit rate or duration');
   if(count===2&&i===0){if(mediaStart!==-1n||segment*4n>movieScale)fail('unsupported empty edit');lead=rational(segment,movieScale)}
   else{if(mediaStart<0n)fail('negative edit start');start=mediaStart;length=rational(segment,movieScale)}
  }
  if(start===null||!length||compare(length,rational(31n))>0)fail('unsupported edits');
  if(lead.n*scale%lead.d!==0n)fail('empty edit is not aligned to track ticks');
  // AAC may trim codec priming; video composition time may extend beyond DTS.
  if(kind==='soun'&&compare(add(rational(start,scale),length),add(rational(total,scale),rational(1n,movieScale)))>0)fail('audio edit exceeds media');
  return {lead,start,length,explicit:true};
 }

 function sampleLocations(stbl,count,max){
  const stsz=one(stbl,'stsz');full(stsz);need(stsz,12);const fixed=u32(stsz.start+4),samples=u32(stsz.start+8);
  if(samples!==count||stsz.start+12+(fixed?0:4*count)!==stsz.end)fail('invalid sample sizes');
  const sizes=[];for(let i=0;i<count;i++){const n=fixed||u32(stsz.start+12+i*4);if(!n||n>LIMITS[role])fail('invalid sample size');sizes.push(n)}
  const stsc=one(stbl,'stsc'),mapping=table(stsc,12,max),map=[];
  for(let i=0;i<mapping;i++){
   const p=stsc.start+8+i*12,first=u32(p),per=u32(p+4);
   if((i===0?first!==1:first<=map[i-1].first)||!per||per>count||u32(p+8)!==1)fail('unsupported chunk mapping');
   map.push({first,per});
  }
  const found=stbl.filter(box=>box.type==='stco'||box.type==='co64');if(found.length!==1)fail('invalid chunk offsets');
  const offsets=found[0],isWide=offsets.type==='co64',chunks=table(offsets,isWide?8:4,max);
  if(map.at(-1).first>chunks)fail('chunk mapping outside table');
  const result=[];let index=0,mi=0;
  for(let i=0;i<chunks;i++){
   while(mi+1<map.length&&map[mi+1].first<=i+1)mi++;
   const p=offsets.start+8+i*(isWide?8:4),raw=isWide?wide(p):BigInt(u32(p));if(raw>BigInt(data.length))fail('chunk outside file');
   let position=Number(raw);const begin=position;
   for(let j=0;j<map[mi].per;j++){
    if(index>=count||position<mdat.start||position+sizes[index]>mdat.end)fail('sample outside media');
    result.push({start:position,end:position+sizes[index]});position+=sizes[index++];
   }
   chunkRanges.push([begin,position]);
  }
  if(index!==count)fail('missing samples');return {sizes,locations:result};
 }

 function aacConfig(entry){
  need(entry,28);if(u16(entry.p+16)!==0)fail('unsupported audio sample entry');
  const channels=u16(entry.p+24),sampleRate=u32(entry.p+32)/65536;
  if(![1,2].includes(channels)||![8000,11025,12000,16000,22050,24000,32000,44100,48000,64000,88200,96000].includes(sampleRate)||u16(entry.p+26)!==16)fail('unsupported AAC layout');
  const esds=one(boxes(entry.p+36,entry.end),'esds');full(esds);need(esds,6);
  function descriptor(at,end){
   if(at+2>end)fail('truncated AAC descriptor');const tag=data[at++];let length=0,done=false;
   for(let i=0;i<4;i++){if(at>=end)fail('truncated AAC length');const value=data[at++];length=length*128+(value&127);if(!(value&128)){done=true;break}}
   if(!done||at+length>end)fail('invalid AAC descriptor');return {tag,start:at,end:at+length};
  }
  const es=descriptor(esds.start+4,esds.end);if(es.tag!==3||es.end!==esds.end||es.end-es.start<3||data[es.start+2]!==0)fail('unsupported AAC ES descriptor');
  const decoder=descriptor(es.start+3,es.end);if(decoder.tag!==4||decoder.end-decoder.start<13||data[decoder.start]!==0x40||(data[decoder.start+1]>>2)!==5)fail('unsupported AAC decoder');
  const config=descriptor(decoder.start+13,decoder.end);if(config.tag!==5||config.end!==decoder.end||config.end-config.start<2||config.end-config.start>8)fail('unsupported AAC config');
  const b0=data[config.start],b1=data[config.start+1],object=b0>>3,frequency=((b0&7)<<1)|(b1>>7),layout=(b1>>3)&15;
  const rates=[96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
  const extra=data.subarray(config.start+2,config.end);
  if(object!==2||rates[frequency]!==sampleRate||layout!==channels||(b1&7)!==0||extra.length&&!(extra.length===3&&extra[0]===0x56&&extra[1]===0xe5&&extra[2]===0))fail('unsupported AAC codec configuration');
  // The sole optional following ES descriptor is SLConfig predefined=2.
  if(decoder.end<es.end){const sl=descriptor(decoder.end,es.end);if(sl.tag!==6||sl.end!==es.end||sl.end-sl.start!==1||data[sl.start]!==2)fail('unsupported AAC SL configuration')}
  return {sampleRate,channels,bytes:data.subarray(config.start,config.end)};
 }

 for(const trak of tracks){
  const tc=child(trak),tkhd=one(tc,'tkhd');need(tkhd,4);const version=data[tkhd.start];
  if(![0,1].includes(version)||(u32(tkhd.start)&0xfffff8)!==0||(u32(tkhd.start)&1)!==1)fail('unsupported track header');
  need(tkhd,version===0?84:96);const id=u32(tkhd.start+(version===0?12:20));if(!id||ids.has(id))fail('invalid track ID');ids.add(id);
  const matrix=tkhd.start+(version===0?40:52),identity=[65536,0,0,0,65536,0,0,0,1073741824];
  if(identity.some((value,i)=>u32(matrix+i*4)!==value))fail('unsupported rotation or transform');
  const tkDuration=version===0?BigInt(u32(tkhd.start+20)):wide(tkhd.start+28);
  const mc=child(one(tc,'mdia')),hdlr=one(mc,'hdlr');full(hdlr);need(hdlr,12);const kind=text(hdlr.start+8,4);
  if(!['vide','soun'].includes(kind)||kind==='vide'&&video||kind==='soun'&&audio)fail('unsupported tracks');
  const mdhd=one(mc,'mdhd');full(mdhd,[0,1]);const mv=data[mdhd.start];need(mdhd,mv===0?24:36);
  const scale=BigInt(u32(mdhd.start+(mv===0?12:20))),mediaDuration=mv===0?BigInt(u32(mdhd.start+16)):wide(mdhd.start+24);
  if(!scale||!mediaDuration)fail('invalid media timescale or duration');
  const minf=child(one(mc,'minf')),dref=one(child(one(minf,'dinf')),'dref');full(dref);need(dref,8);
  const references=boxes(dref.start+8,dref.end);if(u32(dref.start+4)!==1||references.length!==1||references[0].type!=='url '||references[0].end-references[0].start!==4||u32(references[0].start)!==1)fail('external data reference');
  const stbl=child(one(minf,'stbl')),allowed=['stsd','stts','stsc','stsz','stco','co64','ctts',...(kind==='vide'?['stss','sdtp']:['sgpd','sbgp'])];
  if(stbl.some(box=>!allowed.includes(box.type)))fail('unsupported sample table');
  const stsd=one(stbl,'stsd');full(stsd);need(stsd,8);const descriptions=boxes(stsd.start+8,stsd.end);
  if(u32(stsd.start+4)!==1||descriptions.length!==1)fail('unsupported sample descriptions');const entry=descriptions[0];need(entry,8);if(entry.start!==entry.p+8)fail('extended sample entries are unsupported');if(u16(entry.p+14)!==1)fail('external sample reference');
  let width,height,config,avc;
  if(kind==='vide'){
   if(entry.type!=='avc1')fail('unsupported video codec');need(entry,78);width=u16(entry.p+32);height=u16(entry.p+34);
   if(width<340||height<340||width>3840||height>3840||width%2||height%2||u32(tkhd.end-8)!==width*65536||u32(tkhd.end-4)!==height*65536)fail('unsupported dimensions');
   const entryChildren=boxes(entry.p+86,entry.end);if(entryChildren.some(box=>box.type==='sinf'))fail('protected video sample entry');
   if(entryChildren.some(box=>['clap','sv3d','st3d'].includes(box.type)))fail('unsupported video presentation');
   const aspect=entryChildren.filter(box=>box.type==='pasp');if(aspect.length>1)fail('duplicate pixel aspect');
   if(aspect.length){const box=aspect[0];need(box,8);if(box.end-box.start!==8||!u32(box.start)||u32(box.start)!==u32(box.start+4))fail('non-square container pixels')}
   const codec=one(entryChildren,'avcC');need(codec,7);const profiles=role==='mask'?[66,77,88,100,244]:[66,77,88,100];if(data[codec.start]!==1||!profiles.includes(data[codec.start+1])||(data[codec.start+4]&3)!==3)fail('unsupported AVC configuration');
   let p=codec.start+6;const spsCount=data[codec.start+5]&31;if(!spsCount||spsCount>4)fail('invalid AVC SPS');avc={sps:new Map(),pps:new Map(),parameterNals:[]};
   for(let i=0;i<spsCount;i++){
    if(p+2>codec.end)fail('truncated AVC SPS');const n=u16(p);p+=2;if(!n||p+n>codec.end)fail('invalid AVC SPS');
    const geometry=spsGeometry(data.subarray(p,p+n),data[codec.start+1]);
    if(geometry.width!==width||geometry.height!==height||avc.sps.has(geometry.id))fail('SPS dimensions disagree with sample entry');
    avc.sps.set(geometry.id,geometry);avc.parameterNals.push(data.subarray(p,p+n));p+=n;
   }
   if(p>=codec.end)fail('missing AVC PPS');const ppsCount=data[p++];if(!ppsCount||ppsCount>4)fail('invalid AVC PPS');
   for(let i=0;i<ppsCount;i++){
    if(p+2>codec.end)fail('truncated AVC PPS');const n=u16(p);p+=2;if(!n||p+n>codec.end)fail('invalid AVC PPS');
    const reference=ppsReference(data.subarray(p,p+n),avc.sps);if(avc.pps.has(reference.id))fail('duplicate PPS');avc.pps.set(reference.id,reference.spsId);avc.parameterNals.push(data.subarray(p,p+n));p+=n;
   }
   if(p!==codec.end){if(![100,244].includes(data[codec.start+1])||p+4!==codec.end||(data[p]&3)!==1||(data[p+1]&7)!==0||(data[p+2]&7)!==0||data[p+3]!==0)fail('unsupported AVC extension')}
  }else{if(entry.type!=='mp4a')fail('unsupported audio codec');config=aacConfig(entry);if(scale!==BigInt(config.sampleRate)||u32(tkhd.end-8)!==0||u32(tkhd.end-4)!==0)fail('inconsistent audio sample rate or dimensions')}
  const max=kind==='vide'?MAX_VIDEO:MAX_AUDIO,stts=one(stbl,'stts'),entries=table(stts,8,max),durations=[];
  let total=0n;
  for(let i=0;i<entries;i++){
   const p=stts.start+8+i*8,n=u32(p),delta=BigInt(u32(p+4));if(!n||!delta||durations.length+n>max||delta>scale)fail('invalid sample timing');
   for(let j=0;j<n;j++)durations.push(delta);total+=BigInt(n)*delta;
  }
  if(kind==='vide'&&durations.length<9||total>scale*31n)fail('sample count or duration limit');
  const {sizes,locations}=sampleLocations(stbl,durations.length,max),ctts=stbl.filter(box=>box.type==='ctts');if(ctts.length>1)fail('duplicate composition table');
  if(kind==='vide'){
   checkAccessUnits(data,locations,avc.sps,avc.pps,avc.parameterNals);
   const sync=stbl.filter(box=>box.type==='stss');if(sync.length>1)fail('duplicate sync table');
   if(sync.length){const count=table(sync[0],4,max);let previous=0;for(let i=0;i<count;i++){const sample=u32(sync[0].start+8+i*4);if(sample<=previous||sample>durations.length)fail('invalid sync table');previous=sample}}
   const dependency=stbl.filter(box=>box.type==='sdtp');if(dependency.length>1)fail('duplicate dependency table');if(dependency.length){full(dependency[0]);if(dependency[0].end-dependency[0].start!==4+durations.length)fail('invalid dependency table')}
  }
  const offsets=[];
  if(ctts.length){
   const box=ctts[0];full(box,[0,1]);need(box,8);const count=u32(box.start+4);
   if(!count||count>max||box.start+8+count*8!==box.end)fail('invalid composition table');
   for(let i=0;i<count;i++){
    const p=box.start+8+i*8,n=u32(p),offset=BigInt(data[box.start]===1?i32(p+4):u32(p+4));
    if(!n||offsets.length+n>durations.length||abs(offset)>scale*2n||kind==='soun'&&offset!==0n)fail('unsupported composition offsets');
    for(let j=0;j<n;j++)offsets.push(offset);
   }
   if(offsets.length!==durations.length)fail('incomplete composition table');
  }else for(let i=0;i<durations.length;i++)offsets.push(0n);
  const edit=edits(tc,scale,total,kind),presentation=[],sampleDurations=[];let dts=0n;
  for(let i=0;i<durations.length;i++){
   presentation.push(add(edit.lead,rational(dts+offsets[i]-edit.start,scale)));sampleDurations.push(rational(durations[i],scale));dts+=durations[i];
  }
  const presentedEnd=add(edit.lead,edit.length),rounding=rational(1n,movieScale);
  if(abs(tkDuration*presentedEnd.d-presentedEnd.n*movieScale)>presentedEnd.d)fail('track duration disagrees with presentation');
  if(kind==='vide'){
   const delta=durations[0];if(durations.some(value=>value!==delta)||![24n,25n,30n].includes(scale/delta)||scale%delta!==0n||mediaDuration!==total)fail('unsupported video frame rate or media duration');
   const ordered=presentation.map((pts,i)=>({pts,duration:sampleDurations[i],sample:i})).sort((a,b)=>compare(a.pts,b.pts));
   for(let i=0;i<ordered.length;i++)if(compare(ordered[i].pts,add(edit.lead,rational(BigInt(i)*delta,scale)))!==0)fail('nonuniform presentation timeline');
   const exactDuration=rational(total,scale);if(compare(rational(abs(edit.length.n*exactDuration.d-exactDuration.n*edit.length.d),edit.length.d*exactDuration.d),rounding)>0)fail('video edit changes frame coverage');
   video={width,height,fpsNumerator:Number(scale/delta),fpsDenominator:1,frameCount:ordered.length,durationSeconds:number(add(edit.lead,exactDuration)),presentedDurationSeconds:number(presentedEnd),presentationPts:ordered.map(item=>repr(item.pts)),sampleDurations:ordered.map(item=>repr(item.duration)),end:presentedEnd};
  }else{
   if(mediaDuration!==total&&mediaDuration!==total-edit.start)fail('audio media duration mismatch');
   const sgpd=stbl.filter(box=>box.type==='sgpd'),sbgp=stbl.filter(box=>box.type==='sbgp');let roll=null;
   if(sgpd.length||sbgp.length){
    if(sgpd.length!==1||sbgp.length!==1)fail('unsupported audio sample groups');
    const description=sgpd[0],group=sbgp[0];full(description,[1]);full(group);
    if(description.end-description.start!==18||text(description.start+4,4)!=='roll'||u32(description.start+8)!==2||u32(description.start+12)!==1||u16(description.start+16)!==65535||text(group.start+4,4)!=='roll')fail('unsupported AAC roll group');
    need(group,12);const count=u32(group.start+8);let firstDistance=-1;
    if(count===1){if(group.end-group.start!==20||u32(group.start+12)!==durations.length||u32(group.start+16)!==1)fail('unsupported AAC roll group')}
    else if(count===2){
     if(group.end-group.start!==28||durations.length<2||u32(group.start+12)!==1||u32(group.start+16)!==0||u32(group.start+20)!==durations.length-1||u32(group.start+24)!==1)fail('unsupported AAC roll group');
     firstDistance=0;
    }else fail('unsupported AAC roll group');
    // MediaBunny correctly gives the first packet no predecessor. FFmpeg also
    // groups that packet with roll=-1. These descriptions are equivalent only
    // when the edit fully discards that first codec-priming packet. Never erase
    // a preroll difference for an audible or partially audible first packet.
    const firstDiscarded=compare(add(presentation[0],sampleDurations[0]),edit.lead)<=0;
    roll={distance:-1,sampleCount:durations.length,firstSampleDistance:firstDiscarded?0:firstDistance};
   }
   let audioBytes=0;const packetDigests=[];
   for(const location of locations){audioBytes+=location.end-location.start;if(audioBytes>8*1024*1024)fail('audio byte limit');packetDigests.push(await hash(data.subarray(location.start,location.end)))}
   // MOV edit duration is converted to the media sample clock with nearest
   // rounding (FFmpeg mov.c get_edit_list_entry -> av_rescale). Different movie
   // timescales may represent the same exact audible sample window.
   const editLengthSamples=(edit.length.n*scale*2n+edit.length.d)/(edit.length.d*2n);
   if(editLengthSamples<=0n)fail('empty AAC presentation');
   const audioEnd=add(edit.lead,rational(editLengthSamples,scale));
   const codecConfigSha256=await hash('RIG-AAC-CONFIG-V2\n'+JSON.stringify({audioSpecificConfigSha256:await hash(config.bytes),roll}));
   audio={codec:'aac',sampleRate:config.sampleRate,channels:config.channels,sampleCount:locations.length,codecConfigSha256,packetDigests,presentationPts:presentation.map(repr),sampleDurations:sampleDurations.map(repr),presentedDurationSeconds:number(audioEnd),end:audioEnd};
   audio.packetSha256=await hash('RIG-AAC-PACKETS-V1\n'+JSON.stringify({sizes,digests:packetDigests}));
   audio.timelineSha256=await hash('RIG-AAC-TIMELINE-V2\n'+JSON.stringify({pts:audio.presentationPts,durations:audio.sampleDurations,presentedEnd:repr(audioEnd)}));
  }
 }
 if(!video||role==='mask'&&audio)fail('missing video or audio in mask');
 chunkRanges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<chunkRanges.length;i++)if(chunkRanges[i][0]<chunkRanges[i-1][1])fail('overlapping track media');
 const longest=audio&&compare(audio.end,video.end)>0?audio.end:video.end;
 if(compare(rational(abs(movieDuration*longest.d-longest.n*movieScale),movieScale*longest.d),rational(1n,movieScale))>0)fail('movie duration disagrees with tracks');
 if(audio&&compare(audio.end,add(video.end,rational(1n,BigInt(video.fpsNumerator))))>0)fail('audio extends beyond video');
 const timelineSha256=await hash('RIG-VIDEO-TIMELINE-V1\n'+JSON.stringify({width:video.width,height:video.height,fps:[video.fpsNumerator,video.fpsDenominator],pts:video.presentationPts,durations:video.sampleDurations}));
 delete video.end;if(audio)delete audio.end;
 return {mime:'video/mp4',codec:'h264',inspectionLevel:'container-only',geometryVerified:'avc-sps',sha256:await hash(data),size:data.length,...video,timelineSha256,hasAudio:!!audio,audioPacketSha256:audio?.packetSha256??null,audio};
}
