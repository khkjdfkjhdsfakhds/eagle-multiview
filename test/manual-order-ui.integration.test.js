'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
test('manual image order spans more than 3000 items, synchronizes two renderers and survives restart; native export stays available', {timeout:65000},async()=>{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const {stdout}=await promisify(execFile)(require('electron'),['--disable-logging',require.resolve('../test-support/manual-order-probe.cjs')],{env,timeout:60000,maxBuffer:4*1024*1024});
  assert.match(stdout,/MANUAL_ORDER_UI_OK/);
});
test('default and name-sorted partially loaded views reorder directly without a mode or modifier', {timeout:30000},async()=>{
  const env={...process.env,EAGLEMV_PARTIAL_ORDER:'1'};delete env.ELECTRON_RUN_AS_NODE;
  const {stdout}=await promisify(execFile)(require('electron'),['--disable-logging',require.resolve('../test-support/manual-order-probe.cjs')],{env,timeout:25000,maxBuffer:4*1024*1024});
  assert.match(stdout,/PARTIAL_ORDER_UI_OK/);
});
