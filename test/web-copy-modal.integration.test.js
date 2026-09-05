'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

let resultPromise;
async function probe(){
  if(!resultPromise)resultPromise=(async()=>{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const {stdout}=await promisify(execFile)(require('electron'),['--disable-logging',require.resolve('../test-support/web-copy-modal-probe.cjs')],{env,timeout:25000});
  const line=stdout.split('\n').find(row=>row.startsWith('WEB_COPY_MODAL '));assert.ok(line,stdout);
  return JSON.parse(line.slice('WEB_COPY_MODAL '.length));
  })();
  return resultPromise;
}
test('Web copy cancellation closes only its modal and preserves the underlying preview and focus', {timeout:30000}, async()=>{
  const result=await probe();
  assert.equal(result.escape.before.secure,false);
  assert.equal(result.escape.before.text,'https://example.test/fixture');
  assert.deepEqual(result.escape.after,{preview:'text-1',previewOpen:true,editor:'original',dialog:false,focus:'copyURLButton',unhandled:[]});
  assert.deepEqual(result.cancelButton,{dialog:false,focus:'copyURLButton',unhandled:[]});
});
test('Web copy modal traps keyboard focus and prevents background rating, navigation and deletion',async()=>{
  const result=await probe();assert.deepEqual(result.tabs,[true,true,true,true,true,true]);
  assert.equal(result.shortcuts.length,15);
  for(const row of result.shortcuts)assert.deepEqual(row,{key:row.key,preview:'text-1',dialog:true,selected:['text-1'],focus:'已手动复制',slideshow:false});
  assert.deepEqual(result.space,{preview:'text-1',dialog:false,focus:'copyURLButton',unhandled:[]});
  assert.deepEqual(result.gridDelete,{dialog:true,trashOpen:false,selected:['text-1']});
  assert.deepEqual(result.mutations,[]);
  assert.deepEqual(result.popups,[]);
});
test('Every visible Web text-copy entry treats cancellation quietly and reports success only after confirmation', async()=>{
  const result=await probe();
  const expected=[['#0c2238',['已复制颜色 #0c2238']],['合成正向提示词',['提示词已复制']],['合成负向提示词',['提示词已复制']],['Synthetic image',[]]];
  assert.equal(result.entries.length,4);
  result.entries.forEach((entry,index)=>{
    assert.deepEqual(entry.pending,{text:expected[index][0],toasts:[]},entry.selector);
    assert.deepEqual(entry.canceled,{dialog:false,selected:['image-1'],unhandled:[],toasts:[],focusRestored:true},entry.selector);
    assert.deepEqual(entry.completed,{dialog:false,unhandled:[],toasts:expected[index][1],focusRestored:true},entry.selector);
  });
});
