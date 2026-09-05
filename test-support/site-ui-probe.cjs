'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'eaglemv-site-ui-')));
(async()=>{
  await app.whenReady();const w=new BrowserWindow({show:false,width:390,height:740});
  await w.loadURL('data:text/html,<html><body></body></html>');
  await w.webContents.insertCSS(fs.readFileSync(path.join(__dirname,'../src/styles.css'),'utf8'));
  await w.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname,'../src/site-import-ui.js'),'utf8') + ';void 0;');
  await w.webContents.executeJavaScript(`(async()=>{
    const wait=ms=>new Promise(r=>setTimeout(r,ms));const until=async f=>{for(let i=0;i<100;i++){if(f())return;await wait(10);}throw Error('site UI timeout');};
    const assert=(v,m)=>{if(!v)throw Error(m);};const calls=[];let library='/fixture.library', partial=false;
    const api={startSiteImport:async p=>{calls.push(['start',p]);return {requestId:p.requestId,assets:[{id:'a',name:'first',website:'https://www.artstation.com/artwork/aa'},{id:'b',name:'second',website:'https://www.artstation.com/artwork/bb'}],nextPage:2};},
      nextSiteImport:async()=>({assets:[],nextPage:null,complete:true}),cancelSiteImport:async p=>calls.push(['cancel',p]),
      importSiteSelection:async p=>{calls.push(['import',p]);return partial ? {outcomes:[],notSubmitted:['b'],error:{message:'missing target'}} : {outcomes:[{assetId:'b',status:'committed',id:'eagle-b'}]};}};
    const ui=window.createSiteImportUI({api,context:()=>({libraryPath:library,folderId:'target',folders:[{id:'target',name:'Target',children:[]}]}),canStart:()=>true,refresh:async()=>{},notify:()=>{}});
    ui.open();document.querySelector('[data-site-url]').value='https://www.artstation.com/artist';document.querySelector('[data-site-discover]').click();
    await until(()=>document.querySelectorAll('[data-site-asset]').length===2);
    assert(!calls.some(c=>c[0]==='import'),'discovery imported assets');
    document.querySelector('[data-site-import]').click();await wait(10);assert(!calls.some(c=>c[0]==='import'),'empty selection imported');
    document.querySelector('[data-site-asset="b"]').checked=true;document.querySelector('[data-site-import]').click();
    await until(()=>calls.some(c=>c[0]==='import'));
    assert(calls.find(c=>c[0]==='import')[1].ids.join(',')==='b','unselected asset imported');
    assert(calls[0][1].folderId==='target'&&calls[0][1].libraryPath==='/fixture.library','destination not frozen');
    document.querySelector('[data-site-close]').click();await wait(10);
    ui.open();document.querySelector('[data-site-url]').value='https://www.artstation.com/artist';document.querySelector('[data-site-discover]').click();
    await until(()=>document.querySelectorAll('[data-site-asset]').length===2);library='/other.library';
    document.querySelector('[data-site-asset="a"]').checked=true;document.querySelector('[data-site-import]').click();await wait(10);
    assert(calls.filter(c=>c[0]==='import').length===1,'switched library imported');
    document.querySelector('[data-site-close]').click();await until(()=>calls.some(c=>c[0]==='cancel'));
    library='/fixture.library';partial=true;ui.open();document.querySelector('[data-site-url]').value='https://www.artstation.com/artist';document.querySelector('[data-site-discover]').click();
    await until(()=>document.querySelectorAll('[data-site-asset]').length===2);
    document.querySelector('[data-site-asset="b"]').checked=true;document.querySelector('[data-site-import]').click();
    await until(()=>calls.filter(c=>c[0]==='import').length===2);await wait(10);
    assert(!document.querySelector('[data-site-asset="b"]').disabled,'not-submitted asset permanently disabled');
    assert(document.querySelector('[role="status"]').textContent.includes('missing target'),'error object not rendered');
  })()`);console.log('SITE_UI_OK');w.destroy();app.quit();
})().catch(e=>{console.error(e);app.exit(1);});
