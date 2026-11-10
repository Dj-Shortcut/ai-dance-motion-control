// Fixed public software assets only. User files never enter this manifest.
const prefix='/multiuser/ocr/v7/';
const code='text/javascript; charset=utf-8';
const entries=[
 ['worker.min.js',code,150000],
 ['core/tesseract-core-lstm.wasm.js',code,100000],
 ['core/tesseract-core-simd-lstm.wasm.js',code,100000],
 ['core/tesseract-core-relaxedsimd-lstm.wasm.js',code,100000],
 // Emscripten resolves its binary relative to the worker's own URL.
 ['tesseract-core-lstm.wasm','application/wasm',3000000],
 ['tesseract-core-simd-lstm.wasm','application/wasm',3000000],
 ['tesseract-core-relaxedsimd-lstm.wasm','application/wasm',3000000],
 ['eng-best-int/eng.traineddata.gz','application/octet-stream',3000000],
 ['NOTICE.txt','text/plain; charset=utf-8',100000]
];
export const CLEANUP_STATIC_ASSETS=Object.freeze(Object.fromEntries(entries.map(([name,type,max])=>[prefix+name,Object.freeze({type,max,worker:name==='worker.min.js'})])));
export const OCR_WORKER_POLICY="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'";
