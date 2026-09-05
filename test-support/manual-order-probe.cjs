'use strict';
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {ManualOrderStore}=require('../lib/manual-order-store');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mv-manual-ui-'));
app.setPath('userData',root);
app.on('window-all-closed',()=>{});
let store=new ManualOrderStore(path.join(root,'state','manual-order.json'));
let windows=[],moves=0;
const folderMoves=[];
ipcMain.handle('fixture:folder-move',(_event,payload)=>{folderMoves.push(payload);return {ok:true};});
const items=Array.from({length:3101},(_,i)=>({id:`item-${i}`,name:`Picture ${i}`,ext:'png',width:10,height:10,folders:[],tags:[]}));
ipcMain.handle('fixture:identity',event=>`fixture-${event.sender.id}`);
ipcMain.handle('fixture:orders',(_event,data)=>store.get(data.libraryPath));
ipcMain.handle('fixture:query',(_event,{offset=0,limit=160})=>({data:items.slice(offset,offset+limit),total:items.length,nextOffset:offset+limit,hasMore:offset+limit<items.length}));
ipcMain.handle('fixture:move',async (_event,payload)=>{
  moves++; const result=await store.move(payload);
  for(const win of windows)if(!win.isDestroyed())win.webContents.send('fixture:changed',{libraryPath:payload.libraryPath,orders:result.orders,scope:payload.scope,kind:payload.kind,startSort:payload.startSort});
  return result;
});
const source=process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname,'..');
async function open() {
  const win=new BrowserWindow({show:false,width:900,height:740,webPreferences:{contextIsolation:false,nodeIntegration:false,sandbox:false,preload:path.join(__dirname,'manual-order-preload.cjs')}});
  windows.push(win);await win.loadFile(path.join(source,'src/index.html'));return win;
}
const helpers=`
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async fn=>{for(let i=0;i<600;i++){if(fn())return;await wait(20);}throw Error('manual UI timeout');};
  const assert=(x,m)=>{if(!x)throw Error(m);};
  await until(()=>document.querySelector('.item-card'));
  const select=document.querySelector('#sortSelect');
  assert(!select.querySelector('option[value="manual"]') && !document.querySelector('[data-sort="manual"]'),'a manual mode is still exposed');
  for(let i=0;i<600 && document.querySelectorAll('.item-card').length<3101;i++){
    const scroller=document.querySelector('#gridScroller');
    scroller.scrollTop=scroller.scrollHeight;
    scroller.dispatchEvent(new Event('scroll'));
    await wait(20);
  }
  await until(()=>document.querySelectorAll('.item-card').length===3101);
  await wait(40);
`;
(async()=>{
  await app.whenReady();const first=await open(),second=await open();
  if(process.env.EAGLEMV_PARTIAL_ORDER){
    await first.webContents.executeJavaScript(`(async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const until=async fn=>{for(let i=0;i<300;i++){if(fn())return;await wait(20);}throw Error('partial order timeout');};
      const assert=(x,m)=>{if(!x)throw Error(m);};
      await until(()=>document.querySelector('[data-id="item-1"]') && document.querySelector('#loadIndicator').classList.contains('hidden'));
      assert(document.querySelectorAll('.item-card').length<3101,'fixture did not retain unloaded pages');
      const reorder=async (id,target)=>{
        const source=document.querySelector('[data-id="'+id+'"]'),to=document.querySelector('[data-id="'+target+'"]');
        const data=new DataTransfer(),box=to.getBoundingClientRect();
        source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:data}));
        to.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientX:box.left+2,clientY:box.top+2}));
        await until(()=>document.querySelector('#sortSelectLabel').textContent==='自定义顺序');await wait(40);
      };
      await reorder('item-1','item-0');
      assert(document.querySelector('.item-card').dataset.id==='item-1','default paginated view did not reorder immediately');
      const select=document.querySelector('#sortSelect');select.value='name';select.dispatchEvent(new Event('change',{bubbles:true}));
      await until(()=>document.querySelectorAll('.item-card').length>=3000 && document.querySelector('#loadIndicator').classList.contains('hidden'));
      await reorder('item-2','item-1');
      const ids=[...document.querySelectorAll('.item-card')].slice(0,3).map(node=>node.dataset.id);
      assert(JSON.stringify(ids)===JSON.stringify(['item-0','item-2','item-1']),'automatic sort undid drag order or revived old custom order');
      assert(window.__nativeDragCalls===2,'normal native drag requires a modifier');
    })()`);
    console.log('PARTIAL_ORDER_UI_OK');for(const win of windows)win.destroy();app.quit();return;
  }
  for(const win of [first,second])await win.webContents.executeJavaScript(`(async()=>{${helpers}})()`);
  await first.webContents.executeJavaScript(`(async()=>{${helpers}
    const from=document.querySelector('[data-id="item-3100"]'),to=document.querySelector('[data-id="item-0"]');
    document.querySelector('[data-id="item-3099"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
    from.dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}));
    const data=new DataTransfer();
    const started=from.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:data}));
    assert(!started && window.__nativeDragCalls===1,'ordinary drag no longer starts the native file session');
    const rect=to.getBoundingClientRect();
    to.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data,clientX:rect.left+2,clientY:rect.top+2}));
    assert(to.dataset.manualDrop==='horizontal-before','no image insertion marker');
    to.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientX:rect.left+2,clientY:rect.top+2}));
    await until(()=>document.querySelector('.item-card').dataset.id==='item-3099');
    assert(window.__cancelDragTokens?.includes(1),'native reorder did not release the shared drag token');
    assert(document.querySelectorAll('.item-card')[1].dataset.id==='item-3100','multi-selection lost block order');
    assert(document.querySelector('[data-id="item-3100"]').classList.contains('selected'),'reorder lost selection');
    assert(!document.querySelector('.feature-dialog[open]'),'image reorder opened modal');
  })()`);
  await second.webContents.executeJavaScript(`(async()=>{${helpers}
    await until(()=>document.querySelector('.item-card').dataset.id==='item-3099');
    const card=document.querySelector('.item-card'),data=new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:data,altKey:true}));
    assert(window.__nativeDragCalls===1,'Option drag no longer supports native export');
    card.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:data}));
    const canceled=new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:canceled}));
    card.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:canceled}));
    assert(!document.querySelector('[data-manual-drop]'),'canceled drag left insertion marker');
    const folder=document.querySelector('.folder-card[data-open-folder="mv-folder"]');
    const into=document.querySelector('.folder-card[data-open-folder="eagle-folder"]');
    const folderData=new DataTransfer(),box=into.getBoundingClientRect();
    folder.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:folderData}));
    into.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:folderData,clientX:box.left+box.width/2,clientY:box.top+box.height/2}));
    await until(()=>window.__folderMoves===1);
    assert(!document.querySelector('.feature-dialog[open]'),'folder center no longer moves directly in manual mode');
  })()`);
  if(moves!==1)throw Error('automatic replay or unexpected write');
  if(folderMoves.length!==1 || folderMoves[0].id!=='mv-folder' || folderMoves[0].parentId!=='eagle-folder')throw Error('folder center route changed');
  first.destroy();second.destroy();windows=[];
  store=new ManualOrderStore(path.join(root,'state','manual-order.json'));
  const restarted=await open();
  await restarted.webContents.executeJavaScript(`(async()=>{${helpers}
    assert(document.querySelector('.item-card').dataset.id==='item-3099','restart lost saved order');
    select.value='default';select.dispatchEvent(new Event('change',{bubbles:true}));
    assert(document.querySelector('.item-card').dataset.id==='item-0','default order changed Eagle data');
  })()`);
  if(process.env.EAGLEMV_MANUAL_SCREENSHOT){
    restarted.setSize(980,740);
    await restarted.webContents.executeJavaScript(`(async()=>{
      document.querySelector('#gridScroller').scrollTop=0;
      await new Promise(r=>setTimeout(r,180));
      const box=document.querySelector('#sortSelectButton').getBoundingClientRect();
      if(!box.width || box.right>innerWidth || box.left<0)throw Error('minimum desktop width hides or overflows manual sort control');
    })()`);
    fs.writeFileSync(process.env.EAGLEMV_MANUAL_SCREENSHOT,(await restarted.webContents.capturePage()).toPNG());
  }
  console.log('MANUAL_ORDER_UI_OK');restarted.destroy();app.quit();
})().catch(error=>{console.error(error);app.exit(1);});
