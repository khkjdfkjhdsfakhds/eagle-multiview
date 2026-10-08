'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {nativeSyncScript,cloneNativeStateScript,refreshFolderCoversScript,folderCoverItemId,projectSourceItemNativeState,projectTargetItemNativeState,itemNativeStateMatches,folderNativeStateMatches,moveRelative}=require('../lib/eagle-native-sync');
function scope() { return {libraryPath:'/fixture.library',folders:[{id:'a'},{id:'b'}],folderMappings:{F:{id:'F',children:[],covers:[]}},itemMappings:{I:{id:'I',folders:['F'],pinned:{Other:9},order:{Other:'6'}}},saveFolder(){},resetFolderCover(f){f.covers=[];},updateSidebarList(){},calculateImageBinding(){}}; }
test('native pins preserve unrelated fields and reject stale baselines',()=>{
 const s=scope(); const input={kind:'pins',libraryPath:s.libraryPath,folderId:'F',entries:[{id:'I',before:null,value:5}]};
 assert.equal(vm.runInNewContext(nativeSyncScript(input),{$bodyScope:s}),true);
 assert.deepEqual(s.itemMappings.I.pinned,{Other:9,F:5});
 assert.equal(vm.runInNewContext(nativeSyncScript(input),{$bodyScope:s}),false);
 input.entries=[{id:'I',before:5,value:null}];
 assert.equal(vm.runInNewContext(nativeSyncScript(input),{$bodyScope:s}),true);
 assert.deepEqual(s.itemMappings.I.pinned,{Other:9});
});
test('native cover set/reset reject stale state and library changes',()=>{
 const s=scope();const input={kind:'cover',libraryPath:s.libraryPath,folderId:'F',itemId:'I',before:null};
 assert.equal(vm.runInNewContext(nativeSyncScript(input),{$bodyScope:s}),true);assert.equal(s.folderMappings.F.coverId,'I');
 assert.equal(vm.runInNewContext(nativeSyncScript(input),{$bodyScope:s}),false);
 assert.equal(vm.runInNewContext(nativeSyncScript({...input,before:'I',itemId:null}),{$bodyScope:s}),true);
 s.libraryPath='/other.library';assert.equal(vm.runInNewContext(nativeSyncScript(input),{$bodyScope:s}),false);
});
test('folder reorder preserves nodes and rejects an intervening native drag',()=>{
 const s=scope(),first=s.folders[0];const input={kind:'folders',libraryPath:s.libraryPath,before:['a','b'],ids:['b','a']};
 assert.equal(vm.runInNewContext(nativeSyncScript(input),{$bodyScope:s}),true);assert.equal(s.folders[1],first);
 assert.equal(vm.runInNewContext(nativeSyncScript(input),{$bodyScope:s}),false);
 assert.deepEqual(moveRelative(['a','b','c','d'],['c'],'a','before'),['c','a','b','d']);
});
test('native item order is folder scoped and switches Eagle to manual order',()=>{
 const s=scope();const input={kind:'items',libraryPath:s.libraryPath,folderId:'F',entries:[{id:'I',before:null,value:'1234'}]};
 assert.equal(vm.runInNewContext(nativeSyncScript(input),{$bodyScope:s}),true);
 assert.deepEqual(s.itemMappings.I.order,{Other:'6',F:'1234'});
 assert.equal(s.folderMappings.F.orderBy,'MANUAL');assert.equal(s.folderMappings.F.sortIncrease,true);
});
test('copied items re-key native pins and order onto the copied folders only',()=>{
 const s=scope();
 s.folderMappings.G={id:'G',children:[],covers:[]};
 s.itemMappings.I.pinned={F:9,Elsewhere:4};s.itemMappings.I.order={F:'6',Elsewhere:'7'};
 s.itemMappings.C={id:'C',folders:['G'],pinned:{Elsewhere:1},order:{Elsewhere:'2'},covers:[]};
 const input={libraryPath:s.libraryPath,folders:[],items:[{sourceId:'I',targetId:'C',map:{F:'G'}}]};
 assert.equal(vm.runInNewContext(cloneNativeStateScript(input),{$bodyScope:s}),true);
 // The script builds copies with the script realm's Object prototype; compare
 // through JSON so the assertion does not depend on cross-realm identity.
 assert.deepEqual(JSON.parse(JSON.stringify(s.itemMappings.C.pinned)),{G:9});
 assert.deepEqual(JSON.parse(JSON.stringify(s.itemMappings.C.order)),{G:'6'});
 assert.equal(vm.runInNewContext(cloneNativeStateScript({...input,libraryPath:'/other.library'}),{$bodyScope:s}),false);
});
test('copied folders inherit native sort mode, icon colour and mapped cover',()=>{
 let saved=0,resets=0;
 const s=scope();
 s.saveFolder=()=>saved++;s.resetFolderCover=()=>resets++;
 s.folderMappings.S={id:'S',children:[],covers:[],orderBy:'MANUAL',sortIncrease:true,iconColor:'blue',coverId:'I'};
 s.folderMappings.G={id:'G',children:[],covers:[]};
 const script=cloneNativeStateScript({libraryPath:s.libraryPath,folders:[{sourceId:'S',targetId:'G',coverItemId:'C'}],items:[]});
 assert.equal(vm.runInNewContext(script,{$bodyScope:s}),true);
 const copied=JSON.parse(JSON.stringify(s.folderMappings.G));
 assert.equal(copied.orderBy,'MANUAL');assert.equal(copied.sortIncrease,true);
 assert.equal(copied.iconColor,'blue');assert.equal(copied.coverId,'C');
 assert.equal(resets,1);assert.equal(saved,1);
 // A source folder without a native sort mode must not leave one behind.
 s.folderMappings.Q={id:'Q',children:[],covers:[]};
 s.folderMappings.P={id:'P',children:[],covers:[]};
 assert.equal(vm.runInNewContext(cloneNativeStateScript({libraryPath:s.libraryPath,folders:[{sourceId:'Q',targetId:'P',coverItemId:null}],items:[]}),{$bodyScope:s}),true);
 assert.equal('orderBy' in s.folderMappings.P,false);
 assert.equal('coverId' in s.folderMappings.P,false);
});
test('native copy projections ignore folders outside the copied subtree',()=>{
 const source={order:{A:'1',B:'2'},pinned:{A:5,Elsewhere:9}};
 assert.deepEqual(JSON.parse(JSON.stringify(projectSourceItemNativeState(source,{A:'A2'}))),{pinned:{A2:5},order:{A2:'1'}});
 assert.equal(itemNativeStateMatches(source,{order:{A2:'1'},pinned:{A2:5}},{A:'A2'}),true);
 assert.equal(itemNativeStateMatches(source,{order:{A2:'1',Elsewhere:'2'},pinned:{A2:5}},{A:'A2'}),true);
 assert.equal(itemNativeStateMatches(source,{order:{A2:'1'},pinned:{A2:6}},{A:'A2'}),false);
 assert.deepEqual(JSON.parse(JSON.stringify(projectTargetItemNativeState({order:{A2:'1'}},{A:'A2'}))),{pinned:{},order:{A2:'1'}});
 assert.equal(folderNativeStateMatches({orderBy:'NAME',sortIncrease:false},{orderBy:'NAME',sortIncrease:false},{coverItemId:null}),true);
 assert.equal(folderNativeStateMatches({orderBy:'NAME',sortIncrease:true},{orderBy:'NAME',sortIncrease:false},{coverItemId:null}),false);
 assert.equal(folderNativeStateMatches({},{},{coverItemId:null}),true);
 assert.equal(folderNativeStateMatches({coverId:'I'},{coverId:'C'},{coverItemId:'C'}),true);
});
test('folder cover ids resolve from the explicit cover or the cached markup',()=>{
 assert.equal(folderCoverItemId({coverId:'I',covers:['<img src="file:///library/images/two.info/two_thumbnail.png">']}),'I');
 assert.equal(folderCoverItemId({covers:['<img class="sub-folder-cover" src="file:///library/images/two.info/two_thumbnail.png" style="aspect-ratio: 1;">']}),'two');
 assert.equal(folderCoverItemId({covers:[null,'<img src="file:///library/images/%E5%9B%BE.info/x_thumbnail.png">']}),'图');
 assert.equal(folderCoverItemId({covers:[],coverId:null}),null);
 assert.equal(folderCoverItemId(undefined),null);
});
test('cover refresh re-sorts the binding, persists it and rejects another library',()=>{
 const calls=[];
 const s=scope();
 s.saveFolder=()=>calls.push('save');
 s.calculateImageBinding=(params,callback)=>{calls.push(`bind:${params.ignoreSort}`);callback();};
 assert.equal(vm.runInNewContext(refreshFolderCoversScript({libraryPath:s.libraryPath}),{$bodyScope:s}),true);
 assert.deepEqual(calls,['bind:false','save']);
 s.libraryPath='/other.library';calls.length=0;
 assert.equal(vm.runInNewContext(refreshFolderCoversScript({libraryPath:'/fixture.library'}),{$bodyScope:s}),false);
 assert.deepEqual(calls,[]);
 const broken=scope();broken.saveFolder=undefined;
 assert.equal(vm.runInNewContext(refreshFolderCoversScript({libraryPath:broken.libraryPath}),{$bodyScope:broken}),false);
});
