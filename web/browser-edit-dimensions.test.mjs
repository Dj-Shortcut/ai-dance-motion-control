import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const window={};vm.runInNewContext(await readFile(new URL('./frontend/multiuser/media.js',import.meta.url),'utf8'),{window});
const full={x:0,y:0,w:100,h:100};
test('the real cropped reel retains its complete composition and clears the model minimum',()=>{
 const d=window.rigMedia.videoDimensions({videoWidth:742,videoHeight:1322},full,{minSide:720});
 assert.equal(d.width,720);assert.equal(d.height,1280);assert.equal(d.contentWidth,718);assert.equal(d.contentHeight,1280);assert.equal(d.dx,1);assert.equal(d.dy,0);
 assert.equal(d.sw,742);assert.equal(d.sh,1322);
});
test('portrait, landscape and square editing outputs fit the private normalizer without rescaling below 720',()=>{
 for(const [width,height] of [[1080,1920],[1920,1080],[1080,1080],[1322,742],[720,1280]]){
  const d=window.rigMedia.videoDimensions({videoWidth:width,videoHeight:height},full,{minSide:720});
  assert.ok(d.width>=720&&d.height>=720);assert.ok(d.width<=1280&&d.height<=1280);assert.equal(d.width%2,0);assert.equal(d.height%2,0);
  assert.ok(d.contentWidth+2*d.dx===d.width&&d.contentHeight+2*d.dy===d.height);
 }
});
test('an insufficient edit source fails before recording while ordinary motion sizing remains unchanged',()=>{
 const source={videoWidth:640,videoHeight:1138};
 assert.throws(()=>window.rigMedia.videoDimensions(source,full,{minSide:720}),/720/);
 assert.throws(()=>window.rigMedia.videoDimensions({videoWidth:1280,videoHeight:720},{x:0,y:0,w:50,h:100},{minSide:720}),/720/);
 const d=window.rigMedia.videoDimensions(source,full);assert.equal(d.width,640);assert.equal(d.height,1138);assert.equal(d.dx,0);assert.equal(d.dy,0);
});
