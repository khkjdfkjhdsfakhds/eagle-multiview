'use strict';
// Root coordinator runs this serially. Product code and real API are never edited/called.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-interaction-audit-'));
app.setPath('userData', data);
app.setPath('cache', path.join(data, 'cache'));
// Keep the audit process alive between isolated scenario windows.
app.on('window-all-closed', () => {});
const sourceRoot = process.env.EAGLEMV_AUDIT_SOURCE_ROOT || path.resolve(__dirname, '..');
const { TextDraftStore } = require(path.join(sourceRoot, 'lib/text-draft-store'));
const draftStore = new TextDraftStore(path.join(data, 'drafts'));
ipcMain.handle('audit:text-draft', (_event, operation, payload) => draftStore[operation](payload));
const helpers = `
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => { for (let n=0;n<250;n++) { if (predicate()) return; await wait(20); } throw new Error('audit condition timed out'); };
const pane = index => document.querySelectorAll('.content-pane')[index];
const click = element => { if (!element) throw new Error('missing click target'); element.dispatchEvent(new MouseEvent('click', {bubbles:true})); };
const dblclick = element => { click(element); element.dispatchEvent(new MouseEvent('dblclick', {bubbles:true})); };
const split = async () => { click(document.querySelector('#paneLayoutButton')); click(document.querySelector('#paneLayoutPopover [data-layout="vertical2"]')); await until(() => window.state.panes.length === 2 && window.state.panes.every(p => !p.loading && p.items.length)); };
const snapshot = () => window.state.panes.map(p => ({id:p.id, preview:p.previewId, textDirty:p.textSession?.dirty || false, textContent:p.textSession?.content || null, selected:[...p.selected], count:p.items.length, slideshowTimer:Boolean(p.slideshow.timer)}));
await until(() => window.state?.library && window.state.panes.length && window.state.panes.every(p => !p.loading && p.items.length));
`;
const scenarios = {
  inspectorResolvedConflict: `
click(pane(0).querySelector('[data-id="item-1"]'));
window.__audit.externalItemChange('item-1',{annotation:'outside note'});
const input=document.querySelector('#itemAnnotation');input.focus();input.value='local draft';input.dispatchEvent(new Event('input',{bubbles:true}));input.setSelectionRange(3,3);
await until(()=>document.querySelector('[data-draft-action="overwrite"]'));
window.confirm=()=>true;document.querySelector('[data-draft-action="overwrite"]').click();
await until(()=>window.__audit.calls.filter(call=>call.kind==='mutate').length===2&&!window.state.inspectorSaving);await wait(450);
return {dirty:window.state.inspectorDirty,stored:window.__audit.snapshotItem('item-1').annotation,value:input.value,focused:document.activeElement===input,caret:input.selectionStart,stale:!document.querySelector('#staleBanner').classList.contains('hidden'),conflictButtons:!!document.querySelector('[data-draft-action="overwrite"]')};`,
  inspectorResolvedThenLateConflict: `
click(pane(0).querySelector('[data-id="item-1"]'));
window.__audit.externalItemChange('item-1',{annotation:'outside note'});
const input=document.querySelector('#itemAnnotation');input.value='local draft';input.dispatchEvent(new Event('input',{bubbles:true}));
await until(()=>document.querySelector('[data-draft-action="overwrite"]'));
window.__audit.mutationDelay=true;window.confirm=()=>true;document.querySelector('[data-draft-action="overwrite"]').click();
await until(()=>window.__audit.calls.filter(call=>call.kind==='mutate').length===2);
const name=document.querySelector('#itemName');name.focus();name.value='late local name';name.dispatchEvent(new Event('input',{bubbles:true}));name.setSelectionRange(2,2);
window.__audit.externalItemChange('item-1',{name:'outside name'});window.__audit.mutationDelay=false;window.__audit.resolveMutation();
await until(()=>window.__audit.calls.filter(call=>call.kind==='mutate').length===3&&!window.state.inspectorSaving);await wait(50);
return {dirty:window.state.inspectorDirty,storedName:window.__audit.snapshotItem('item-1').name,storedAnnotation:window.__audit.snapshotItem('item-1').annotation,name:name.value,focused:document.activeElement===name,caret:name.selectionStart,stale:!document.querySelector('#staleBanner').classList.contains('hidden'),conflictButtons:!!document.querySelector('[data-draft-action="overwrite"]'),forces:window.__audit.calls.filter(call=>call.kind==='mutate').map(call=>Boolean(call.force))};`,
  inspectorOwnSaveEcho: `
click(pane(0).querySelector('[data-id="item-1"]'));window.__audit.ackReadbackTime={ack:1788595267432,readback:1788595609033};
const input=document.querySelector('#itemAnnotation');input.focus();input.value='own annotation';input.dispatchEvent(new Event('input',{bubbles:true}));input.setSelectionRange(4,4);
await until(()=>window.__audit.calls.some(call=>call.kind==='mutate'));await until(()=>!window.state.inspectorSaving);await wait(450);
return {value:input.value,stored:window.__audit.snapshotItem('item-1').annotation,dirty:window.state.inspectorDirty,stale:!document.querySelector('#staleBanner').classList.contains('hidden'),focused:document.activeElement===input,caret:input.selectionStart};`,
  inspectorPollEchoAndExternalConflict: `
click(pane(0).querySelector('[data-id="item-1"]'));
const input=document.querySelector('#itemAnnotation');input.focus();
const stale=()=>!document.querySelector('#staleBanner').classList.contains('hidden');
window.__audit.externalItemChange('item-1',{lastModified:1788595609033});await window.__audit.pollSelectedItem();await wait(50);
const timeOnlyStale=stale();
window.__audit.externalItemChange('item-1',{tags:['outside tag']});await window.__audit.pollSelectedItem();await wait(50);
const externalTagsStale=stale();
input.value='own note';input.dispatchEvent(new Event('input',{bubbles:true}));
await until(()=>window.__audit.calls.some(call=>call.kind==='mutate'));await until(()=>!window.state.inspectorSaving);await wait(50);
const accepted={stale:stale(),tags:[...window.state.draftTags],dirty:window.state.inspectorDirty};
window.__audit.externalItemChange('item-1',{annotation:'outside note'});await window.__audit.pollSelectedItem();await wait(50);
const externalNoteStale=stale();
input.value='local draft';input.dispatchEvent(new Event('input',{bubbles:true}));input.setSelectionRange(3,3);
await until(()=>window.__audit.calls.filter(call=>call.kind==='mutate').length===2);await until(()=>!window.state.inspectorSaving);
return {timeOnlyStale,externalTagsStale,accepted,externalNoteStale,conflict:!!document.querySelector('[data-draft-action="overwrite"]'),dirty:window.state.inspectorDirty,value:input.value,stored:window.__audit.snapshotItem('item-1').annotation,focused:document.activeElement===input,caret:input.selectionStart};`,
  inspectorLateIntentNoRemote: `
click(pane(0).querySelector('[data-id="item-1"]'));window.__audit.mutationDelay=true;
const name=document.querySelector('#itemName');name.value='first name';name.dispatchEvent(new Event('input',{bubbles:true}));
await until(()=>window.__audit.calls.some(call=>call.kind==='mutate'));
const annotation=document.querySelector('#itemAnnotation');annotation.value='late user annotation';annotation.dispatchEvent(new Event('input',{bubbles:true}));
name.value='Item 001';name.dispatchEvent(new Event('input',{bubbles:true}));
window.__audit.mutationDelay=false;window.__audit.resolveMutation();await until(()=>!window.state.inspectorSaving);
return {item:window.__audit.snapshotItem('item-1'),patches:window.__audit.calls.filter(call=>call.kind==='mutate').map(call=>call.patch),dirty:window.state.inspectorDirty};`,
  inspectorExplicitFieldRevert: `
click(pane(0).querySelector('[data-id="item-1"]'));window.__audit.mutationDelay=true;
const name=document.querySelector('#itemName');name.value='first name';name.dispatchEvent(new Event('input',{bubbles:true}));
await until(()=>window.__audit.calls.some(call=>call.kind==='mutate'));
window.__audit.externalItemChange('item-1',{url:'https://example.com/remote',star:4});
const url=document.querySelector('#itemURL');url.focus();url.value='temporary';url.dispatchEvent(new Event('input',{bubbles:true}));url.value='';url.dispatchEvent(new Event('input',{bubbles:true}));
window.__audit.mutationDelay=false;window.__audit.resolveMutation();await until(()=>!window.state.inspectorSaving);
const reverted=window.__audit.snapshotItem('item-1').url;
const displayAfterRevert=url.value;const dirtyAfterRevert=window.state.inspectorDirty;
url.value='https://example.com/user  ';url.dispatchEvent(new Event('input',{bubbles:true}));url.setSelectionRange(5,5);
await until(()=>window.__audit.calls.some(call=>call.kind==='mutate'&&call.patch.url==='https://example.com/user'));await until(()=>!window.state.inspectorSaving);
return {reverted,displayAfterRevert,dirtyAfterRevert,patches:window.__audit.calls.filter(call=>call.kind==='mutate').map(call=>call.patch),value:url.value,caret:url.selectionStart,star:window.__audit.snapshotItem('item-1').star};`,
  importDuplicateFailures: `
const messages=[];
for(const result of [{count:1,ready:1,duplicateFailed:1,rejected:[]},{count:0,ready:0,duplicateFailed:2,rejected:[]},{count:0,ready:0,duplicateFailed:0,rejected:[]}]){
  window.__audit.importResult=result;await window.__audit.emit('onImportRequest');
  await until(()=>!window.state.importing);messages.push(document.querySelector('#toast').textContent);
}
return messages;`,
  textStoreLifecycle: `
dblclick(pane(0).querySelector('[data-id="text-1"]')); await until(()=>pane(0).querySelector('#textEditor'));
let editor=pane(0).querySelector('#textEditor');
for(let n=0;n<11;n++){editor.value='saved text '+n;editor.dispatchEvent(new Event('input',{bubbles:true}));}
click(pane(0).querySelector('#saveTextButton')); await until(()=>!window.state.textSession.dirty&&!window.state.textSession.saving);
const previousId=window.state.textSession.draftId;
await window.eagleMV.getTextDraft(window.state.textSession);
document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
dblclick(pane(0).querySelector('[data-id="text-1"]')); await until(()=>pane(0).querySelector('#textEditor'));
editor=pane(0).querySelector('#textEditor');window.__audit.textSaveMode='fail';editor.value='new lifecycle draft';editor.dispatchEvent(new Event('input',{bubbles:true}));
await wait(650);
const session=window.state.textSession;
const record=await window.eagleMV.getTextDraft({libraryPath:session.libraryPath,id:session.id,draftId:session.draftId});
const puts=window.__audit.calls.filter(call=>call.kind==='draft-put');const removes=window.__audit.calls.filter(call=>call.kind==='draft-remove');
return {previousId,draftId:session.draftId,record,putKeys:Object.keys(puts.at(-1)).filter(key=>key!=='kind').sort(),removeKeys:Object.keys(removes.at(-1)).filter(key=>key!=='kind').sort()};`,
  inspectorRemoteRebase: `
click(pane(0).querySelector('[data-id="item-1"]'));
window.__audit.externalItemChange('item-1',{annotation:'remote annotation',tags:['remote tag'],star:4,url:'https://example.com/remote'});
const name=document.querySelector('#itemName'); name.focus(); name.value='user name  '; name.dispatchEvent(new Event('input',{bubbles:true}));name.setSelectionRange(3,3);
await until(()=>window.__audit.calls.some(call=>call.kind==='mutate')); await until(()=>!window.state.inspectorSaving); await wait(600);
return {item:window.__audit.snapshotItem('item-1'),patches:window.__audit.calls.filter(call=>call.kind==='mutate').map(call=>call.patch),annotation:document.querySelector('#itemAnnotation').value,tags:window.state.draftTags,star:document.querySelector('#itemRating').value,url:document.querySelector('#itemURL').value,name:name.value,caret:name.selectionStart};`,
  inspectorRemoteLateIntent: `
click(pane(0).querySelector('[data-id="item-1"]')); window.__audit.mutationDelay=true;
const name=document.querySelector('#itemName'); name.value='first name'; name.dispatchEvent(new Event('input',{bubbles:true}));
await until(()=>window.__audit.calls.some(call=>call.kind==='mutate'));
window.__audit.externalItemChange('item-1',{annotation:'remote annotation',url:'https://example.com/remote'});
const annotation=document.querySelector('#itemAnnotation'); annotation.focus(); annotation.value='late user annotation'; annotation.dispatchEvent(new Event('input',{bubbles:true})); annotation.setSelectionRange(3,3);
name.value='Item 001'; name.dispatchEvent(new Event('input',{bubbles:true}));
window.__audit.mutationDelay=false; window.__audit.resolveMutation(); await until(()=>!window.state.inspectorSaving);
return {item:window.__audit.snapshotItem('item-1'),patches:window.__audit.calls.filter(call=>call.kind==='mutate').map(call=>call.patch),requests:window.__audit.calls.filter(call=>call.kind==='mutate'),caret:annotation.selectionStart,focused:document.activeElement===annotation,annotation:annotation.value,dirty:window.state.inspectorDirty,conflict:document.querySelector('#staleBanner').textContent,confirmations:window.__audit.confirmations.length};`,
  webHttpBootstrap: `
return {secure:window.isSecureContext,uuid:typeof crypto.randomUUID,randomValues:typeof crypto.getRandomValues,loaded:window.state.items.length,platform:window.eagleMV.platform};`,
  inspectorRestartRecovery: `
click(pane(0).querySelector('[data-id="item-1"]')); window.__audit.failIds=['item-1'];
const editor=document.querySelector('#itemAnnotation'); editor.value='metadata retained after exit'; editor.dispatchEvent(new Event('input',{bubbles:true}));
await wait(550); window.confirm=message=>{ window.__audit.confirmations.push(message); return true; };
await window.__audit.emit('onRequestClose');
return {confirmed:window.__audit.calls.some(c=>c.kind==='confirm-close')};`,
  textRestartRecovery: `
dblclick(pane(0).querySelector('[data-id="text-1"]')); await until(()=>pane(0).querySelector('#textEditor'));
window.__audit.textSaveMode='fail'; const editor=pane(0).querySelector('#textEditor');
editor.value='draft surviving new window'; editor.dispatchEvent(new Event('input',{bubbles:true})); await wait(650);
return {draftId:window.state.textSession.draftId,text:editor.value};`,
  textAutoSaveTyping: `
await split(); dblclick(pane(0).querySelector('[data-id="text-1"]')); await until(()=>pane(0).querySelector('#textEditor'));
const editor=pane(0).querySelector('#textEditor'); editor.focus(); window.__audit.textSaveDelay=true;
editor.value='first text'; editor.dispatchEvent(new Event('input',{bubbles:true}));
await until(()=>window.__audit.textSavesInFlight===1);
const editableDuringSave=!editor.disabled;
editor.value='second text'; editor.dispatchEvent(new Event('input',{bubbles:true})); editor.setSelectionRange(4,4);
click(pane(1).querySelector('[data-id="item-2"]'));
window.__audit.textSaveDelay=false; window.__audit.resolveTextSave(); await until(()=>!window.state.panes[0].textSession.dirty);
return {text:window.__audit.snapshotText(),editableDuringSave,maxInFlight:window.__audit.maxTextSavesInFlight,panes:snapshot(),sameEditor:editor===pane(0).querySelector('#textEditor'),caret:editor.selectionStart};`,
  textConflictAndEmpty: `
dblclick(pane(0).querySelector('[data-id="text-1"]')); await until(()=>pane(0).querySelector('#textEditor'));
const editor=pane(0).querySelector('#textEditor'); window.__audit.textSaveMode='conflict';
editor.value='my conflicting draft'; editor.dispatchEvent(new Event('input',{bubbles:true})); await wait(650);
const conflict={text:editor.value,dirty:window.state.textSession.dirty,confirmations:window.__audit.confirmations.length,status:pane(0).querySelector('#textStatus').textContent};
window.__audit.textSaveMode='normal'; editor.value=''; editor.dispatchEvent(new Event('input',{bubbles:true})); click(pane(0).querySelector('#saveTextButton')); await wait(100);
return {conflict,empty:{text:editor.value,dirty:window.state.textSession.dirty,status:pane(0).querySelector('#textStatus').textContent,detail:pane(0).querySelector('#textStatus').title},stored:window.__audit.snapshotText(),calls:window.__audit.calls.filter(c=>c.kind==='save-text')};`,
  textImeAndPending: `
dblclick(pane(0).querySelector('[data-id="text-1"]')); await until(()=>pane(0).querySelector('#textEditor'));
const editor=pane(0).querySelector('#textEditor'); editor.focus(); window.__audit.textSaveMode='pending';
editor.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})); editor.value='中文输入'; editor.dispatchEvent(new Event('input',{bubbles:true}));
await wait(600); const during=window.__audit.calls.filter(c=>c.kind==='save-text').length;
editor.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})); await until(()=>!window.state.textSession.dirty);
return {during,stored:window.__audit.snapshotText(),status:pane(0).querySelector('#textStatus').textContent,detail:pane(0).querySelector('#textStatus').title,focused:document.activeElement===editor};`,
  inspectorFailureRestore: `
click(pane(0).querySelector('[data-id="item-1"]')); window.__audit.failIds=['item-1'];
const input=document.querySelector('#itemAnnotation'); input.value='recover failed draft'; input.dispatchEvent(new Event('input',{bubbles:true}));
click(pane(0).querySelector('[data-id="item-2"]')); await wait(100);
click(pane(0).querySelector('[data-id="item-1"]')); const restored=input.value;
window.__audit.failIds=[]; input.dispatchEvent(new Event('input',{bubbles:true})); await wait(600);
return {restored,stored:window.__audit.snapshotItem('item-1').annotation};`,
  modalFocus: `
const origin=document.querySelector('#newButton'); origin.focus();
window.__audit.emit('onCreateFolderRequest'); await until(()=>!document.querySelector('#folderDialog').classList.contains('hidden'));
await wait(60); return {origin:origin.id};`,
  asyncTextPane: `
await split();
window.__audit.readDelay = true;
dblclick(pane(0).querySelector('[data-id="text-1"]'));
await until(() => pane(0).querySelector('#modalMedia').textContent.includes('正在读取 TXT'));
click(pane(1).querySelector('[data-id="item-2"]'));
window.__audit.resolveRead(); await wait(120);
return {panes:snapshot(), firstMedia:pane(0).querySelector('#modalMedia').textContent};`,
  dirtyTextLayout: `
await split();
dblclick(pane(1).querySelector('[data-id="text-1"]'));
await until(() => pane(1).querySelector('#textEditor'));
const editor = pane(1).querySelector('#textEditor'); editor.value='UNSAVED AUDIT DRAFT'; editor.dispatchEvent(new Event('input',{bubbles:true}));
click(pane(0).querySelector('[data-id="item-2"]'));
const before=snapshot();
click(document.querySelector('#paneLayoutButton')); click(document.querySelector('#paneLayoutPopover [data-layout="single"]'));
await wait(120); return {before,after:snapshot(),confirmations:window.__audit.confirmations};`,
  dirtyTextWindowClose: `
await split(); dblclick(pane(1).querySelector('[data-id="text-1"]')); await until(() => pane(1).querySelector('#textEditor'));
const editor=pane(1).querySelector('#textEditor'); editor.value='UNSAVED AUDIT DRAFT'; editor.dispatchEvent(new Event('input',{bubbles:true}));
click(pane(0).querySelector('[data-id="item-2"]'));
await window.__audit.emit('onRequestClose');
return {panes:snapshot(),confirmations:window.__audit.confirmations,calls:window.__audit.calls};`,
  activeDirtyTextCloseControl: `
dblclick(pane(0).querySelector('[data-id="text-1"]')); await until(() => pane(0).querySelector('#textEditor'));
const editor=pane(0).querySelector('#textEditor'); editor.value='UNSAVED ACTIVE DRAFT'; editor.dispatchEvent(new Event('input',{bubbles:true}));
await window.__audit.emit('onRequestClose');
return {panes:snapshot(),confirmations:window.__audit.confirmations,calls:window.__audit.calls};`,
  dirtyTextReload: `
dblclick(pane(0).querySelector('[data-id="text-1"]')); await until(() => pane(0).querySelector('#textEditor'));
const editor=pane(0).querySelector('#textEditor'); editor.value='UNSAVED BEFORE RELOAD'; editor.dispatchEvent(new Event('input',{bubbles:true}));
const unload = new Event('beforeunload', { cancelable:true }); window.dispatchEvent(unload);
return {before:snapshot(),guardPrevented:unload.defaultPrevented,confirmations:window.__audit.confirmations,calls:window.__audit.calls};`,
  refreshSelection: `
const scroller=pane(0).querySelector('#gridScroller'); scroller.scrollTop=scroller.scrollHeight; scroller.dispatchEvent(new Event('scroll'));
await until(() => window.state.panes[0].items.some(item=>item.id==='item-200') && !window.state.panes[0].loading);
click(pane(0).querySelector('[data-id="item-200"]')); const before=snapshot();
document.dispatchEvent(new KeyboardEvent('keydown',{key:'3',code:'Digit3',bubbles:true}));
await until(()=>window.__audit.calls.some(call=>call.kind==='mutate')); await wait(350);
return {before,after:snapshot(),savedStar:window.__audit.snapshotItem('item-200').star};`,
  slideshowPane: `
await split(); dblclick(pane(0).querySelector('[data-id="item-1"]'));
const interval=pane(0).querySelector('#slideshowInterval'); interval.value='2000'; interval.dispatchEvent(new Event('change',{bubbles:true}));
click(pane(0).querySelector('#slideshowToggle'));
dblclick(pane(1).querySelector('[data-id="item-5"]')); const before=snapshot();
await wait(2250); const after=snapshot();
return {before,after};`,
  pinsDiscardDraft: `
click(pane(0).querySelector('[data-id="item-1"]'));
const input=document.querySelector('#itemAnnotation'); input.value='UNSAVED BEFORE PIN EVENT'; input.dispatchEvent(new Event('input',{bubbles:true}));
const before={dirty:window.state.inspectorDirty,value:input.value};
window.__audit.emit('onPinsChanged',{libraryPath:window.state.library.path,pins:{}});
await wait(500); return {before,after:{dirty:window.state.inspectorDirty,value:input.value},mutations:window.__audit.calls.filter(call=>call.kind==='mutate')};`,
  inFlightDraftNavigation: `
click(pane(0).querySelector('[data-id="item-1"]'));
window.__audit.mutationDelay=true;
const input=document.querySelector('#itemAnnotation'); input.value='first'; input.dispatchEvent(new Event('input',{bubbles:true}));
await until(()=>window.state.inspectorSaving);
input.value='second unsaved'; input.dispatchEvent(new Event('input',{bubbles:true}));
click(pane(0).querySelector('[data-id="item-2"]'));
window.__audit.resolveMutation(); await wait(600);
return {stored:window.__audit.snapshotItem('item-1').annotation,panes:snapshot(),mutations:window.__audit.calls.filter(call=>call.kind==='mutate')};`,
  focusedInFlightDraftNavigation: `
click(pane(0).querySelector('[data-id="item-1"]'));
window.__audit.mutationDelay=true;
const input=document.querySelector('#itemAnnotation'); input.focus(); input.value='first'; input.dispatchEvent(new Event('input',{bubbles:true}));
await until(()=>window.state.inspectorSaving);
input.value='second after focus'; input.dispatchEvent(new Event('input',{bubbles:true}));
const target=pane(0).querySelector('[data-id="item-2"]');
target.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'mouse',button:0}));
target.focus(); input.blur();
target.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'mouse',button:0})); click(target);
window.__audit.mutationDelay=false; window.__audit.resolveMutation(); await wait(700);
return {stored:window.__audit.snapshotItem('item-1').annotation,selected:[...window.state.selected],dirty:window.state.inspectorDirty,mutations:window.__audit.calls.filter(call=>call.kind==='mutate')};`,
  inFlightTypingStaysControl: `
click(pane(0).querySelector('[data-id="item-1"]'));
window.__audit.mutationDelay=true;
const input=document.querySelector('#itemAnnotation'); input.focus(); input.value='first'; input.dispatchEvent(new Event('input',{bubbles:true}));
await until(()=>window.state.inspectorSaving);
input.value='second retained'; input.dispatchEvent(new Event('input',{bubbles:true}));
window.__audit.mutationDelay=false; window.__audit.resolveMutation(); await wait(750);
return {stored:window.__audit.snapshotItem('item-1').annotation,value:input.value,focused:document.activeElement===input,dirty:window.state.inspectorDirty,mutations:window.__audit.calls.filter(call=>call.kind==='mutate')};`,
  focusedSaveThenNavigateControl: `
click(pane(0).querySelector('[data-id="item-1"]'));
const input=document.querySelector('#itemAnnotation'); input.focus(); input.value='normal saved draft'; input.dispatchEvent(new Event('input',{bubbles:true}));
const target=pane(0).querySelector('[data-id="item-2"]'); target.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'mouse',button:0})); target.focus(); input.blur(); click(target);
await wait(600);
return {stored:window.__audit.snapshotItem('item-1').annotation,selected:[...window.state.selected],mutations:window.__audit.calls.filter(call=>call.kind==='mutate')};`,
  focusedPinsDiscardDraft: `
click(pane(0).querySelector('[data-id="item-1"]'));
const input=document.querySelector('#itemAnnotation'); input.focus(); input.value='focused draft before unrelated pin'; input.dispatchEvent(new Event('input',{bubbles:true}));
const before={dirty:window.state.inspectorDirty,value:input.value,focused:document.activeElement===input};
window.__audit.emit('onPinsChanged',{libraryPath:window.state.library.path,pins:{'folder-b':{'item-201':Date.now()}}});
await wait(550); return {before,after:{dirty:window.state.inspectorDirty,value:input.value,focused:document.activeElement===input},mutations:window.__audit.calls.filter(call=>call.kind==='mutate')};`,
  pinsForeignLibraryControl: `
click(pane(0).querySelector('[data-id="item-1"]'));
const input=document.querySelector('#itemAnnotation'); input.focus(); input.value='foreign pins keep this'; input.dispatchEvent(new Event('input',{bubbles:true}));
window.__audit.emit('onPinsChanged',{libraryPath:'/mock/different-library.library',pins:{}});
const immediate={dirty:window.state.inspectorDirty,value:input.value}; await wait(550);
return {immediate,stored:window.__audit.snapshotItem('item-1').annotation,mutations:window.__audit.calls.filter(call=>call.kind==='mutate')};`,
  activeTextCancelControls: `
dblclick(pane(0).querySelector('[data-id="text-1"]')); await until(()=>pane(0).querySelector('#textEditor'));
const editor=pane(0).querySelector('#textEditor'); editor.focus(); editor.value='cancel keeps draft'; editor.dispatchEvent(new Event('input',{bubbles:true}));
click(pane(0).querySelector('#reloadTextButton'));
const afterReloadCancel=snapshot();
document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
const afterPreviewCancel=snapshot();
await window.__audit.emit('onRequestClose');
return {afterReloadCancel,afterPreviewCancel,afterWindowCancel:snapshot(),confirmations:window.__audit.confirmations,calls:window.__audit.calls};`,
  savedTextCloseControl: `
dblclick(pane(0).querySelector('[data-id="text-1"]')); await until(()=>pane(0).querySelector('#textEditor'));
const editor=pane(0).querySelector('#textEditor'); editor.focus(); editor.value='normally saved text'; editor.dispatchEvent(new Event('input',{bubbles:true}));
click(pane(0).querySelector('#saveTextButton')); await until(()=>!window.state.textSaving&&!window.state.textSession.dirty);
await window.__audit.emit('onRequestClose');
return {panes:snapshot(),confirmations:window.__audit.confirmations,calls:window.__audit.calls};`,
  nativeCommentPrompt: `
const errors=[]; window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason?.message||event.reason)));
click(pane(0).querySelector('[data-id="item-1"]')); click(document.querySelector('#addCommentButton')); await wait(100);
return {errors,commentWrites:window.__audit.calls.filter(call=>call.kind==='add-comment')};`,
  commentSecondPromptCancel: `
const replies=['Audit comment draft',null]; const prompts=[];
window.prompt=message=>{prompts.push(message);return replies.shift()??null;};
click(pane(0).querySelector('[data-id="item-1"]')); click(document.querySelector('#addCommentButton')); await wait(100);
return {prompts,commentWrites:window.__audit.calls.filter(call=>call.kind==='add-comment')};`,
  partialBatchTagsControl: `
window.__audit.failIds=['item-2']; click(pane(0).querySelector('[data-id="item-1"]'));
pane(0).querySelector('[data-id="item-2"]').dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}));
document.querySelector('#batchTagInput').value='audit-tag'; click(document.querySelector('#batchTagButton'));
await until(()=>window.__audit.calls.filter(call=>call.kind==='mutate-set').length===2); await wait(200);
return {selected:[...window.state.selected],item1Tags:window.__audit.snapshotItem('item-1').tags,item2Tags:window.__audit.snapshotItem('item-2').tags,activeOperations:window.state.operationTracker.size,toast:document.querySelector('#toast').textContent};`,
  historyQuery: `
click(document.querySelector('#folderTree [data-folder-id="folder-a"]')); await until(()=>!window.state.loading && window.state.currentView.id==='folder-a');
const input=document.querySelector('#searchInput'); input.value='Item 00'; input.dispatchEvent(new Event('input',{bubbles:true})); await wait(320);
click(document.querySelector('#folderTree [data-folder-id="folder-b"]')); await until(()=>!window.state.loading && window.state.currentView.id==='folder-b');
click(pane(0).querySelector('#backButton')); await wait(320);
return {view:window.state.currentView.id,restoredSearch:window.state.query.search,input:input.value};`,
  multiSelectFilteredOut: `
click(pane(0).querySelector('[data-id="item-1"]'));
pane(0).querySelector('[data-id="item-2"]').dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}));
const input=document.querySelector('#searchInput'); input.value='no such audit material'; input.dispatchEvent(new Event('input',{bubbles:true})); await wait(350);
return {selected:[...window.state.selected],visible:window.state.items.length,multiCount:document.querySelector('#multiCount').textContent,multiPanelVisible:!document.querySelector('#multiSelection').classList.contains('hidden')};`,
  duplicateNavigates: `
click(document.querySelector('#folderTree [data-folder-id="folder-a"]')); await until(()=>!window.state.loading && window.state.currentView.id==='folder-a');
click(pane(0).querySelector('[data-id="item-1"]'));
document.dispatchEvent(new KeyboardEvent('keydown',{key:'d',code:'KeyD',metaKey:true,bubbles:true}));
await until(()=>window.state.items.some(item=>item.id==='copy-1'));
click(document.querySelector('#folderTree [data-folder-id="folder-b"]')); await until(()=>!window.state.loading && window.state.currentView.id==='folder-b');
const before={view:window.state.currentView.id,copiedVisible:window.state.items.some(item=>item.id==='copy-1')};
await wait(1850); return {before,after:{view:window.state.currentView.id,copiedVisible:window.state.items.some(item=>item.id==='copy-1'),copiedFolders:window.state.items.find(item=>item.id==='copy-1')?.folders}};`
};
async function run() {
  await app.whenReady();
  const selected = process.argv.filter(value => value.startsWith('--scenario=')).map(value=>value.slice(11));
  let httpServer, httpURL;
  if (!selected.length || selected.includes('webHttpBootstrap')) {
    httpServer = http.createServer((request, response) => {
      const pathname = decodeURIComponent(new URL(request.url, 'http://fixture').pathname);
      const file = path.resolve(sourceRoot, 'src', '.' + pathname);
      if (!file.startsWith(path.join(sourceRoot, 'src') + path.sep)) { response.writeHead(403).end(); return; }
      const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png' }[path.extname(file)] || 'application/octet-stream';
      fs.readFile(file, (error, content) => { if (error) response.writeHead(404).end(); else response.writeHead(200, {'Content-Type':mime}).end(content); });
    });
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    // 0.0.0.0 addresses the local listener but is not a potentially trusted
    // localhost origin, reproducing ordinary LAN HTTP secure-context rules.
    httpURL = 'http://0.0.0.0:' + httpServer.address().port + '/index.html';
  }
  for (const [name, script] of Object.entries(scenarios)) {
    if (selected.length && !selected.includes(name)) continue;
    const windowOptions = { show:false, width:1440, height:900, webPreferences:{ backgroundThrottling:false, contextIsolation:false, nodeIntegration:false, preload:path.join(__dirname,'interaction-regression-preload.cjs'), partition:`audit-${name}` } };
    if (name === 'webHttpBootstrap') windowOptions.webPreferences.additionalArguments = ['--eaglemv-http-capabilities'];
    if (name === 'textStoreLifecycle') windowOptions.webPreferences.additionalArguments = ['--eaglemv-real-drafts'];
    const realMutationEvents = ['inspectorOwnSaveEcho', 'inspectorPollEchoAndExternalConflict', 'inspectorResolvedConflict', 'inspectorResolvedThenLateConflict'].includes(name);
    if (realMutationEvents || ['inspectorRemoteRebase', 'inspectorRemoteLateIntent', 'inspectorExplicitFieldRevert', 'inspectorLateIntentNoRemote'].includes(name)) {
      windowOptions.webPreferences.sandbox = false;
      windowOptions.webPreferences.additionalArguments = [realMutationEvents ? '--eaglemv-real-mutation-events' : '--eaglemv-real-mutation-hub'];
    }
    let win = new BrowserWindow(windowOptions);
    try {
      if (name === 'webHttpBootstrap') await win.loadURL(httpURL);
      else await win.loadFile(path.join(sourceRoot,'src/index.html'));
      let result = await win.webContents.executeJavaScript(`(async()=>{${helpers}\n${script}})()`);
      if (name === 'inspectorRestartRecovery') {
        const before = result; win.destroy(); win = new BrowserWindow(windowOptions);
        await win.loadFile(path.join(sourceRoot,'src/index.html'));
        result = await win.webContents.executeJavaScript(`(async()=>{${helpers}
          click(pane(0).querySelector('[data-id="item-1"]')); await until(()=>document.querySelector('[data-draft-action="recover"]'));
          click(document.querySelector('[data-draft-action="recover"]')); await wait(550);
          return {text:document.querySelector('#itemAnnotation').value,dirty:window.state.inspectorDirty,saves:window.__audit.calls.filter(c=>c.kind==='mutate').length};
        })()`); result.before=before;
      }
      if (name === 'textRestartRecovery') {
        const before = result;
        win.destroy();
        win = new BrowserWindow(windowOptions);
        await win.loadFile(path.join(sourceRoot,'src/index.html'));
        result = await win.webContents.executeJavaScript(`(async()=>{${helpers}
          dblclick(pane(0).querySelector('[data-id="text-1"]')); await until(()=>pane(0).querySelector('#textDraftSelect'));
          const select=pane(0).querySelector('#textDraftSelect'); select.value='0'; select.dispatchEvent(new Event('change',{bubbles:true}));
          click(pane(0).querySelector('#restoreTextDraft')); await wait(550);
          return {draftId:window.state.textSession.draftId,text:pane(0).querySelector('#textEditor').value,dirty:window.state.textSession.dirty,saves:window.__audit.calls.filter(c=>c.kind==='save-text').length,candidates:window.state.textSession.recoveryDrafts.length};
        })()`);
        result.before = before;
      }
      if (name === 'modalFocus') {
        result.tabInside = [];
        for (const shift of [false,false,false,false,true,true,true,true]) {
          win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:shift?['shift']:[]});
          win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:shift?['shift']:[]});
          await new Promise(resolve=>setTimeout(resolve,20));
          result.tabInside.push(await win.webContents.executeJavaScript('document.querySelector("#folderDialog").contains(document.activeElement)'));
        }
        win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
        win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
        await new Promise(resolve=>setTimeout(resolve,40));
        result.closed = await win.webContents.executeJavaScript('document.querySelector("#folderDialog").classList.contains("hidden")');
        result.restored = await win.webContents.executeJavaScript('document.activeElement.id');
      }
      if (name === 'dirtyTextReload' || name === 'textStoreLifecycle') {
        let unloadBlocked = false;
        win.webContents.once('will-prevent-unload', event => { unloadBlocked = true; event.preventDefault(); });
        await new Promise(resolve => {
          win.webContents.once('did-finish-load', resolve);
          win.webContents.reload();
        });
        const after = await win.webContents.executeJavaScript(`(async()=>{${helpers}\ndblclick(pane(0).querySelector('[data-id="text-1"]')); await until(()=>pane(0).querySelector('#textEditor')); return {panes:snapshot(),draftId:window.state.textSession.draftId,confirmations:window.__audit.confirmations,calls:window.__audit.calls};})()`);
        result = { beforeReload: result, afterReload: after, unloadBlocked };
      }
      process.stdout.write(`INTERACTION_AUDIT ${JSON.stringify({name,result})}\n`);
    } catch (error) { process.stdout.write(`INTERACTION_AUDIT ${JSON.stringify({name,error:error.message})}\n`); }
    finally { win.destroy(); }
  }
  if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  app.quit();
}
run().catch(error=>{console.error(error);app.exit(1);});
