'use strict';
// B4-02: with the policy installed, a page's permission requests are refused.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { installPermissionPolicy } = require('../lib/permission-policy');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-permissions-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  installPermissionPolicy(session.defaultSession);
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await window.loadURL('data:text/html,<title>probe</title>');
  const result = await window.webContents.executeJavaScript(`(async () => ({
    notifications: await Notification.requestPermission(),
    geolocation: await new Promise(resolve => navigator.geolocation.getCurrentPosition(
      () => resolve('granted'),
      error => resolve(error.code === error.PERMISSION_DENIED ? 'denied' : 'error:' + error.code),
      { timeout: 5000 }))
  }))()`);
  console.log(`EAGLEMV_PERMISSIONS ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
