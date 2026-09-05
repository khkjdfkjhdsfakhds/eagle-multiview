'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/web-shim.js'), 'utf8');
function harness(clipboard) {
  const calls = []; const window = {addEventListener(){}};
  vm.runInNewContext(source, { window, navigator: {clipboard}, document: {},
    location: { protocol: 'http:', host: 'fixture', replace(){} },
    WebSocket: class {static CONNECTING=0;static OPEN=1;},
    FileReader: class {readAsDataURL(){this.result='data:image/png;base64,AA==';this.onload();}},
    setTimeout(){return 1;}, clearTimeout(){}, console,
    fetch: async (url, options) => {calls.push(JSON.parse(options.body));return {status:200,json:async()=>({ok:true,result:{counts:{completed:1}}})};}
  });
  return {api:window.eagleMV,calls};
}
test('Web thumbnail clipboard uses visiting device bytes and never host clipboard RPC', async () => {
  const h=harness({read:async()=>[{types:['image/png'],getType:async()=>({type:'image/png',size:1})}]});
  await h.api.thumbnailOperation({operation:'clipboard',ids:['sample'],libraryPath:'/fixture'});
  assert.equal(h.calls[0].method,'item:thumbnail-operation');
  assert.equal(h.calls[0].args[0].imageData,'data:image/png;base64,AA==');
  assert.equal(h.calls[0].args[0].libraryPath,'/fixture');
});
test('Web denied or absent image clipboard does not send a write', async () => {
  for(const clipboard of [undefined,{read:async()=>{throw Error('denied');}},{read:async()=>[]}]) {
    const h=harness(clipboard);
    await assert.rejects(h.api.thumbnailOperation({operation:'clipboard',ids:['a'],libraryPath:'/fixture'}));
    assert.equal(h.calls.length,0);
  }
});

test('cancel during device clipboard preparation prevents a later thumbnail write', async () => {
  let release;
  const h=harness({read:()=>new Promise(resolve=>{release=resolve;})});
  const pending=h.api.thumbnailOperation({requestId:'prepare',operation:'clipboard',ids:['a'],libraryPath:'/fixture'});
  await h.api.cancelThumbnailOperation({requestId:'prepare'});
  release([{types:['image/png'],getType:async()=>({type:'image/png',size:1})}]);
  const result=await pending;
  assert.equal(result.canceled,true);
  assert.equal(h.calls.filter(x=>x.method==='item:thumbnail-operation').length,0);
});
