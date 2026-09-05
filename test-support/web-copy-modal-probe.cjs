'use strict';
// Real Web transport and complete renderer; only Eagle data is synthetic.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const source = process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..');
const { createWebServer } = require(path.join(source, 'lib/web-server'));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-copy-modal-'));
app.setPath('userData', directory);
app.commandLine.appendSwitch('host-resolver-rules', 'MAP eaglemv-copy.test 127.0.0.1');
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const calls = [];
const popups = [];
const library = {path:'/synthetic/copy-modal.library',name:'Synthetic copy modal',folders:[],smartFolders:[]};
const item = {id:'text-1',name:'Synthetic TXT',ext:'txt',size:8,tags:[],folders:[],annotation:'',url:'https://example.test/fixture',star:0,palettes:[{color:[12,34,56],ratio:.5}]};
const items = [item,{...item,id:'text-2',name:'Next TXT'}, {...item,id:'image-1',name:'Synthetic image',ext:'png'}];
const server = createWebServer({srcDir:path.join(source,'src'),accessKey:'synthetic-key',requireKey:false,
  resolveMediaPath:async()=>null,
  invoke:async(method,args=[])=>{
    calls.push({method,args});
    if(method==='hub:connect')return {app:{version:'synthetic'},library};
    if(method==='hub:query')return {data:items,total:items.length,hasMore:false,nextOffset:items.length};
    if(method==='hub:get-item')return items.find(row=>row.id===args[0]);
    if(method==='text:read')return {content:'original',fingerprint:{size:8,mtimeMs:1}};
    if(method==='item:metadata')return {metadata:{format:'Synthetic',positive:'合成正向提示词',negative:'合成负向提示词'}};
    if(['hub:tags','hub:tag-groups','hub:recent-folders','item:comments','text-draft:list'].includes(method))return [];
    if(method==='window:eagle-state')return {view:{kind:'all'}};
    return {};
  }});
let win;
const page = script=>win.webContents.executeJavaScript(`(async()=>{${script}})()`,true);
async function until(expression){for(let n=0;n<250;n++){if(await page(`return Boolean(${expression});`))return;await delay(20);}throw new Error(`Condition timeout: ${expression}`);}
async function key(keyCode,modifiers=[]){
  win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});
  if(keyCode==='Return')win.webContents.sendInputEvent({type:'char',keyCode:'\r',modifiers});
  if(keyCode==='Space')win.webContents.sendInputEvent({type:'char',keyCode:' ',modifiers});
  win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});
  await delay(40);
}
async function run(){
  await app.whenReady();app.dock?.hide();
  const address=await server.start(0,'127.0.0.1');
  win=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.setWindowOpenHandler(details=>{popups.push(details.url);return {action:'deny'};});
  await win.loadURL(`http://eaglemv-copy.test:${address.port}/#state=${encodeURIComponent(JSON.stringify({view:{kind:'all'}}))}`);
  await until('window.state?.connected && state.items.length===3 && !state.loading');
  await page(`window.__copyUnhandled=[];window.addEventListener('unhandledrejection',event=>window.__copyUnhandled.push(String(event.reason?.message||event.reason)));const card=document.querySelector('[data-id="text-1"]');card.click();card.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));`);
  await until('document.querySelector("#textEditor")');
  await page(`document.querySelector('#copyURLButton').focus();document.querySelector('#copyURLButton').click();`);
  await until('document.querySelector(".web-copy-dialog")?.open');
  const before=await page(`return {secure:isSecureContext,preview:state.previewId,dialog:!!document.querySelector('.web-copy-dialog'),text:document.querySelector('.web-copy-dialog textarea').value};`);
  await key('Escape');
  const after=await page(`return {preview:state.previewId,previewOpen:!document.querySelector('#previewModal').classList.contains('hidden'),editor:document.querySelector('#textEditor')?.value,dialog:!!document.querySelector('.web-copy-dialog'),focus:document.activeElement.id,unhandled:window.__copyUnhandled};`);
  await page(`document.querySelector('#copyURLButton').focus();document.querySelector('#copyURLButton').click();`);
  await until('document.querySelector(".web-copy-dialog")?.open');
  const tabs=[];
  for(const modifiers of [[],[],[],['shift'],['shift'],['shift']]){await key('Tab',modifiers);tabs.push(await page(`return document.querySelector('.web-copy-dialog').contains(document.activeElement);`));}
  await key('Tab');
  const shortcuts=[];
  for(const [code,modifiers] of [['2',[]],['Right',[]],['Left',[]],['Up',[]],['Down',[]],['Delete',[]],['Backspace',[]],['W',['meta']],['O',['meta']],['F',['meta']],['A',['meta']],['/',[]],['S',[]],['G',[]],['B',[]]]){
    await key(code,modifiers);
    shortcuts.push(await page(`return {key:${JSON.stringify(code)},preview:state.previewId,dialog:!!document.querySelector('.web-copy-dialog'),selected:[...state.selected],focus:document.activeElement.textContent,slideshow:state.slideshow?.running||false};`));
  }
  await key('Space');
  const space=await page(`return {preview:state.previewId,dialog:!!document.querySelector('.web-copy-dialog'),focus:document.activeElement.id,unhandled:window.__copyUnhandled};`);
  await page(`document.querySelector('#closePreview').click();document.querySelector('#copyURLButton').focus();document.querySelector('#copyURLButton').click();`);
  await until('document.querySelector(".web-copy-dialog")?.open');await key('Tab');await key('Delete');
  const gridDelete=await page(`return {dialog:!!document.querySelector('.web-copy-dialog'),trashOpen:!document.querySelector('#trashDialog').classList.contains('hidden'),selected:[...state.selected]};`);
  await key('Escape');
  await page(`document.querySelector('#copyURLButton').focus();document.querySelector('#copyURLButton').click();`);
  await until('document.querySelector(".web-copy-dialog")?.open');
  await page(`document.querySelector('.web-copy-dialog button:last-child').click();`);
  await delay(40);
  const cancelButton=await page(`return {dialog:!!document.querySelector('.web-copy-dialog'),focus:document.activeElement.id,unhandled:[...window.__copyUnhandled]};`);
  await page(`document.querySelector('[data-id="image-1"]').click();window.__copyToasts=[];new MutationObserver(()=>window.__copyToasts.push(document.querySelector('#toast').textContent)).observe(document.querySelector('#toast'),{childList:true});`);
  await until('document.querySelector("[data-metadata-copy=positive]")');
  const entries=[];
  for(const selector of ['.palette-swatch','[data-metadata-copy="positive"]','[data-metadata-copy="negative"]','[data-context-action="copy-name"]']) {
    const openEntry=async()=>{
      if(selector.includes('copy-name')) {
        await page(`const card=document.querySelector('[data-id="image-1"]');card.focus();card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:150}));`);
        await page(`document.querySelector('[data-context-action="copy-name"]').closest('.has-submenu').classList.add('submenu-open');`);
      }
      await page(`window.__copyToasts=[];const button=document.querySelector(${JSON.stringify(selector)});button.focus();button.click();`);
      await until('document.querySelector(".web-copy-dialog")?.open');
      return page(`return {text:document.querySelector('.web-copy-dialog textarea').value,toasts:[...window.__copyToasts]};`);
    };
    const pending=await openEntry();
    await key('Escape');
    const focusSelector=selector.includes('copy-name')?'.item-card[data-id="image-1"]':selector;
    const canceled=await page(`return {dialog:!!document.querySelector('.web-copy-dialog'),selected:[...state.selected],unhandled:[...window.__copyUnhandled],toasts:[...window.__copyToasts],focusRestored:document.activeElement.matches(${JSON.stringify(focusSelector)})};`);
    await openEntry();await key('Tab');await key('Return');
    const completed=await page(`return {dialog:!!document.querySelector('.web-copy-dialog'),unhandled:[...window.__copyUnhandled],toasts:[...window.__copyToasts],focusRestored:document.activeElement.matches(${JSON.stringify(focusSelector)})};`);
    entries.push({selector,pending,canceled,completed});
  }
  process.stdout.write('WEB_COPY_MODAL '+JSON.stringify({escape:{before,after},tabs,shortcuts,space,gridDelete,cancelButton,entries,popups,mutations:calls.filter(call=>call.method.startsWith('hub:mutate'))})+'\n');
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  for(const window of BrowserWindow.getAllWindows())window.destroy();await server.stop().catch(()=>{});
  fs.rmSync(directory,{recursive:true,force:true});app.exit(process.exitCode||0);
});
