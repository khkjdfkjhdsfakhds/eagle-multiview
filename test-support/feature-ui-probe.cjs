'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-features-ui-'));
app.setPath('userData', profile);
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 900, height: 760, webPreferences: {
    contextIsolation: false, nodeIntegration: false, sandbox: false, preload: path.join(__dirname, 'feature-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const until = async fn => { for(let i=0;i<100;i++){if(fn())return;await wait(20);}throw Error('UI timeout'); };
    const assert = (x,m) => {if(!x)throw Error(m);};
    await until(() => document.querySelector('[data-folder-id="mv-folder"]'));
    const sortSelect=document.querySelector('#sortSelect');
    assert(!sortSelect.querySelector('option[value="manual"]') && !document.querySelector('[data-sort="manual"]'),'manual sorting still requires a dedicated mode');
    const dragFolder=document.querySelector('.folder-card[data-open-folder="eagle-folder"]');
    const beforeFolder=document.querySelector('.folder-card[data-open-folder="mv-folder"]');
    const manualData=new DataTransfer();
    dragFolder.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:manualData}));
    const edge=beforeFolder.getBoundingClientRect();
    beforeFolder.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:manualData,clientX:edge.left+2,clientY:edge.top+edge.height/2}));
    assert(beforeFolder.dataset.manualDrop==='horizontal-before','manual order lacks insertion feedback');
    beforeFolder.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:manualData,clientX:edge.left+2,clientY:edge.top+edge.height/2}));
    await until(()=>window.__uiTestCalls.some(x=>x.kind==='manual-order'));
    await until(()=>document.querySelector('.folder-card').dataset.openFolder==='eagle-folder');
    window.__manualOrderChanged({libraryPath:'/tmp/EagleMV-UI-Test.library',orders:{'["root","folders"]':{ids:['mv-folder'],revision:0}}});
    assert(document.querySelector('.folder-card').dataset.openFolder==='eagle-folder','late older event overwrote manual order');
    window.__manualOrderChanged({libraryPath:'/other.library',orders:{'["root","folders"]':{ids:['mv-folder'],revision:50}}});
    assert(document.querySelector('.folder-card').dataset.openFolder==='eagle-folder','another library changed local order');
    assert(!window.__uiTestCalls.some(x=>x.kind==='move-folder'),'local reorder called Eagle folder move');
    assert(!document.querySelector('.feature-dialog[open]'),'manual reorder opened a confirmation');
    sortSelect.value='default';sortSelect.dispatchEvent(new Event('change',{bubbles:true}));
    assert(document.querySelector('.folder-card').dataset.openFolder==='eagle-folder','changing item sort erased folder order');
    sortSelect.value='name';sortSelect.dispatchEvent(new Event('change',{bubbles:true}));
    assert(document.querySelector('.folder-card').dataset.openFolder==='eagle-folder','switching sort mode erased manual order');
    sortSelect.value='default';sortSelect.dispatchEvent(new Event('change',{bubbles:true}));
    const open = async () => {
      document.querySelector('[data-folder-id="mv-folder"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:200}));
      const button = document.querySelector('[data-context-action="move-folder-node"]');
      assert(button,'folder menu lacks move node action'); button.click();
      await until(() => document.querySelector('.feature-dialog[open]'));
    };
    await open();
    let dialog = document.querySelector('.feature-dialog');
    assert(!dialog.querySelector('option[value="mv-folder"]'), 'self is selectable');
    assert(!dialog.querySelector('option[value="child-folder"]'), 'descendant is selectable');
    const search = dialog.querySelector('input[aria-label="搜索目标文件夹"]');
    assert(search, 'large libraries lack destination search');
    search.value='大量文件夹 299'; search.dispatchEvent(new Event('input',{bubbles:true}));
    assert(dialog.querySelector('option[value="many-299"]'), 'search lost matching destination');
    assert(!dialog.querySelector('option[value="many-10"]'), 'search did not filter unrelated destination');
    search.value='同名'; search.dispatchEvent(new Event('input',{bubbles:true}));
    assert(dialog.querySelector('option[value="same-one"]').textContent==='Eagle 文件夹 / 同名', 'same-name target lacks full path');
    assert(dialog.querySelector('option[value="same-two"]').textContent==='其他父级 / 同名', 'second same-name target is ambiguous');
    dialog.querySelector('[data-feature-cancel]').click();
    assert(!window.__uiTestCalls.some(x=>x.kind==='move-folder'), 'cancel moved folder');
    await open(); dialog = document.querySelector('.feature-dialog');
    dialog.querySelector('select').value='eagle-folder';
    dialog.querySelector('[data-feature-submit]').click();
    await until(() => window.__uiTestCalls.some(x=>x.kind==='move-folder'));
    const payload = window.__uiTestCalls.find(x=>x.kind==='move-folder').payload;
    assert(payload.id==='mv-folder' && payload.parentId==='eagle-folder' && payload.baseParentId===null,'wrong folder move payload');
    assert(payload.libraryPath==='/tmp/EagleMV-UI-Test.library','missing frozen library');
    await until(() => !document.querySelector('.feature-dialog[open]'));

    const callCount = () => window.__uiTestCalls.filter(x=>x.kind==='move-folder').length;
    await open(); dialog = document.querySelector('.feature-dialog');
    dialog.querySelector('select').value='';
    dialog.querySelector('[data-feature-submit]').click();
    await until(() => !document.querySelector('.feature-dialog[open]'));
    assert(window.__uiTestCalls.filter(x=>x.kind==='move-folder').at(-1).payload.parentId===null,'root is not explicit null');

    await open(); dialog = document.querySelector('.feature-dialog');
    const countBeforeEscape=callCount();
    dialog.dispatchEvent(new Event('cancel',{cancelable:true}));
    assert(!document.querySelector('.feature-dialog[open]') && callCount()===countBeforeEscape,'Escape submitted a move');

    window.__featureState.mode='pending';
    await open(); dialog = document.querySelector('.feature-dialog');
    dialog.querySelector('select').value='eagle-folder';
    const countBeforeRepeat=callCount();
    dialog.querySelector('[data-feature-submit]').click(); dialog.querySelector('[data-feature-submit]').click();
    await until(() => window.__featureRelease);
    dialog.querySelector('[data-feature-cancel]').click();
    dialog.dispatchEvent(new Event('cancel',{cancelable:true}));
    assert(dialog.open && callCount()===countBeforeRepeat+1,'pending move duplicated or modal cancelled');
    window.__featureRelease(); window.__featureRelease=null;
    await until(() => !document.querySelector('.feature-dialog[open]'));

    for (const mode of ['failure','conflict']) {
      window.__featureState.mode=mode;
      await open(); dialog = document.querySelector('.feature-dialog');
      dialog.querySelector('select').value='eagle-folder';
      const previous=callCount(); dialog.querySelector('[data-feature-submit]').click();
      await until(() => dialog.querySelector('[data-feature-cancel]').textContent==='关闭');
      assert(dialog.querySelector('[data-feature-submit]').disabled,'failed/conflict move can replay stale input');
      dialog.querySelector('[data-feature-submit]').click();
      assert(callCount()===previous+1,'failed move replayed');
      dialog.querySelector('[data-feature-cancel]').click();
      assert(!document.querySelector('.feature-dialog[open]'),'failed modal cannot close');
    }

    window.__featureState.mode='success';
    await open(); dialog=document.querySelector('.feature-dialog');
    const beforeSwitch=callCount();
    window.__featureEmit('/tmp/Other-UI-Test.library');
    await until(() => document.querySelector('.sidebar-library-label').textContent==='另一测试库');
    dialog.querySelector('[data-feature-submit]').click();
    assert(callCount()===beforeSwitch,'stale-library modal wrote');
    assert(dialog.querySelector('[data-feature-submit]').disabled,'stale-library modal may resume after switching back');
    dialog.querySelector('[data-feature-cancel]').click();
    window.__featureEmit('/tmp/EagleMV-UI-Test.library');
    await until(() => document.querySelector('.sidebar-library-label').textContent==='测试资料库');

    const sourceNode=document.querySelector('[data-folder-node-id="mv-folder"]');
    const targetNode=document.querySelector('[data-folder-node-id="eagle-folder"]');
    assert(sourceNode && targetNode, 'folder drag source hooks missing');
    const dragData=new DataTransfer();
    sourceNode.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dragData}));
    assert(dragData.types.includes('application/x-eagle-multiview-folder-node'),'folder drag has no distinct MIME');
    const dragCount=callCount();
    const moveBox=targetNode.getBoundingClientRect();
    const movePoint={clientX:moveBox.left+moveBox.width/2,clientY:moveBox.top+moveBox.height/2};
    targetNode.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dragData,...movePoint}));
    assert(targetNode.dataset.folderNodeDrop==='allowed','folder drag lacks destination feedback');
    assert(callCount()===dragCount,'hover moved a folder');
    targetNode.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dragData,...movePoint}));
    assert(!document.querySelector('.feature-dialog[open]'),'drop opened an unwanted confirmation');
    await until(() => callCount()===dragCount+1);
    const dropPayload=window.__uiTestCalls.filter(x=>x.kind==='move-folder').at(-1).payload;
    assert(dropPayload.parentId==='eagle-folder' && dropPayload.baseParentId===null,'direct drop lost frozen destination/source parent');
    await wait(80);
    assert(!document.querySelector('[data-folder-node-drop]'),'drop feedback remained after drop');

    const sourceAgain=document.querySelector('[data-folder-node-id="mv-folder"]');
    const selfData=new DataTransfer();
    sourceAgain.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:selfData}));
    sourceAgain.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:selfData}));
    assert(!document.querySelector('.feature-dialog[open]') && callCount()===dragCount+1,'self folder drop was accepted');
    sourceAgain.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:selfData}));

    const selectedRoot=document.querySelector('[data-folder-node-root]');
    const crossData=new DataTransfer();
    crossData.setData('application/x-eagle-multiview-folder-node', JSON.stringify({id:'child-folder',baseParentId:'mv-folder',libraryPath:'/tmp/EagleMV-UI-Test.library'}));
    const beforeRootDrop=callCount();
    selectedRoot.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:crossData}));
    assert(!document.querySelector('.feature-dialog[open]'),'root drop opened confirmation');
    await until(() => callCount()===beforeRootDrop+1);
    await wait(80);
    const rootPayload=window.__uiTestCalls.filter(x=>x.kind==='move-folder').at(-1).payload;
    assert(rootPayload.id==='child-folder' && rootPayload.parentId===null && rootPayload.baseParentId==='mv-folder','cross-window drag lost source parent/root intent');

    const foreignData=new DataTransfer();
    foreignData.setData('application/x-eagle-multiview-folder-node',JSON.stringify({id:'mv-folder',baseParentId:null,libraryPath:'/other.library'}));
    targetNode.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:foreignData}));
    assert(!document.querySelector('.feature-dialog[open]'),'cross-library folder drag opened a move');

    // An item drag must retain its original propagation and cleanup path.
    const passthrough=document.createElement('div'); document.body.append(passthrough);
    let propagated=0; passthrough.addEventListener('dragend',()=>propagated++);
    const staleFolderData=new DataTransfer();
    sourceAgain.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:staleFolderData}));
    const itemsData=new DataTransfer();itemsData.setData('application/x-eagle-multiview-items','["item"]');
    passthrough.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:itemsData}));
    passthrough.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:itemsData}));
    assert(propagated===1,'folder drag intercepted later item drag cleanup');passthrough.remove();

    window.__featureState.mode='pending';
    await open(); dialog=document.querySelector('.feature-dialog');
    dialog.querySelector('select').value='eagle-folder';
    dialog.querySelector('[data-feature-submit]').click();
    await until(() => window.__featureRelease);
    window.__featureEmit('/tmp/Other-UI-Test.library');
    await until(() => document.querySelector('.sidebar-library-label').textContent==='另一测试库');
    window.__featureRelease();window.__featureRelease=null;
    await wait(80);
    assert(dialog.open && /原库/.test(dialog.querySelector('[role="status"]').textContent),'late old-library success is shown as current-library success');
    dialog.querySelector('[data-feature-cancel]').click();
    const notices=[];
    const refreshFailureUI=window.createSelectedFeatureUI({api:{moveFolder:async()=>({ok:true})},
      context:()=>({libraryPath:'/fixture.library',folders:[{id:'x',name:'X',children:[]}]}),
      canStart:()=>true,refresh:async()=>{throw Error('offline');},notify:message=>notices.push(message)});
    await refreshFailureUI.moveFolder('x');
    document.querySelector('[data-feature-submit]').click();await wait(30);
    assert(notices.some(message=>/已移动/.test(message)&&/刷新/.test(message)), 'confirmed move plus failed refresh has no visible feedback');
    notices.length=0;
    await refreshFailureUI.moveFolder('x', null);
    // x is already at root: a same-parent drop is a no-op without a request.
    assert(notices.length===0,'same-parent direct move was submitted');

    const directContext={libraryPath:'/fixture.library',folders:[
      {id:'x',name:'X',children:[{id:'child',name:'Child',children:[]}]},
      {id:'y',name:'Y',children:[]}
    ]};
    let directCalls=0, releaseDirect, directMode='pending', directRefreshes=0;
    const directUI=window.createSelectedFeatureUI({
      api:{moveFolder:async()=>{
        directCalls++;
        if(directMode==='pending') await new Promise(resolve=>{releaseDirect=resolve;});
        if(directMode==='failure') throw Error('网络中断，请核对结果');
        if(directMode==='conflict') return {conflict:true};
        if(directMode==='unknown') return {};
        return {ok:true};
      }},context:()=>directContext,canStart:()=>true,
      refresh:async()=>{directRefreshes++;if(directMode==='refresh-failure')throw Error('offline');},
      notify:message=>notices.push(message)
    });
    const pendingDirect=directUI.moveFolder('x','y');
    assert(directCalls===1 && !document.querySelector('.feature-dialog[open]'),'direct move did not submit immediately without a modal');
    await directUI.moveFolder('x','y');
    await directUI.moveFolder('x');
    assert(directCalls===1 && !document.querySelector('.feature-dialog[open]'),'pending direct move allowed a duplicate or menu replay');
    directContext.libraryPath='/other.library';
    releaseDirect();await pendingDirect;
    assert(directRefreshes===0 && notices.some(message=>/原库/.test(message)),'late direct success refreshed the wrong library');
    directContext.libraryPath='/fixture.library';
    for(const mode of ['failure','conflict','unknown','refresh-failure','success']){
      directMode=mode;notices.length=0;const previous=directCalls;
      await directUI.moveFolder('x','y');
      assert(directCalls===previous+1 && !document.querySelector('.feature-dialog[open]'),'direct move retried or opened an error modal');
      const expected={failure:/网络中断/,conflict:/其他窗口/,unknown:/尚未确认/,'refresh-failure':/已移动.*刷新失败/,success:/文件夹已移动/}[mode];
      assert(notices.some(message=>expected.test(message)),'direct move lost '+mode+' feedback');
    }
    const beforeInvalid=directCalls;
    for(const target of ['x','child','missing',null]) await directUI.moveFolder('x',target);
    assert(directCalls===beforeInvalid,'invalid direct destination wrote');
  })()`);
  console.log('FEATURE_UI_OK'); win.destroy(); app.quit();
})().catch(error => { console.error(error); app.exit(1); });
