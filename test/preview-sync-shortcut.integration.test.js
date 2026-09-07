'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
test('Shift+S works over open images, preserves editing, and displays a replaceable slow-fading sync notice', {timeout:25000},async()=>{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const {stdout}=await promisify(execFile)(require('electron'),['--disable-logging',require.resolve('../test-support/preview-sync-shortcut-probe.cjs')],{env,timeout:22000});
  const line=stdout.split('\n').find(row=>row.startsWith('PREVIEW_SYNC_RESULT '));assert.ok(line,stdout);
  const result=JSON.parse(line.slice('PREVIEW_SYNC_RESULT '.length));assert.equal(result.previewOpen,true);assert.ok(result.fading>0&&result.fading<1);
});
