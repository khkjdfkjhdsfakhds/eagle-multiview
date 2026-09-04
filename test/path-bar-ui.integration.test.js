'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { assertCleanElectronStderr } = require('../test-support/electron-stderr.cjs');

const execFileAsync = promisify(execFile);

async function runPathBarUI(platform) {
  const electron = require('electron');
  const runner = require.resolve('../test-support/path-bar-ui-runner.cjs');
  const env = { ...process.env, EAGLEMV_UI_PLATFORM: platform };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout, stderr } = await execFileAsync(electron, ['--disable-logging', runner], { env, timeout: 50000 });
  assertCleanElectronStderr(assert, stderr, `${platform} UI runner`);
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_PATH_BAR_RESULT '));
  assert.ok(line, `missing path-bar UI result: ${stdout}`);
  return JSON.parse(line.slice('EAGLEMV_PATH_BAR_RESULT '.length));
}

test('path bars stay pane-local across Web and Electron responsive layouts', { timeout: 90000 }, async () => {
  const result = await runPathBarUI('web');
  assert.equal(result.platform, 'web');
  assert.equal(result.mobile, true);
  assert.equal(result.panes, 2);
  assert.equal(result.layout, 'horizontal2');
  const electronResult = await runPathBarUI('darwin');
  assert.equal(electronResult.platform, 'darwin');
  assert.equal(electronResult.mobile, false);
  assert.equal(electronResult.panes, 2);
  assert.equal(electronResult.layout, 'vertical2');
  assert.ok(electronResult.deepPath.fontSize >= 13 && electronResult.deepPath.fontSize <= 15, `路径栏文字没有与标题同字号: ${JSON.stringify(electronResult.deepPath)}`);
  assert.ok(electronResult.deepPath.pathTextToDividerGap >= 4 && electronResult.deepPath.pathTextToDividerGap <= 8, `路径文字和分隔线距离不合理: ${JSON.stringify(electronResult.deepPath)}`);
  assert.ok(electronResult.deepPath.dividerToTitleGap >= 3, `分隔线和第二行距离不足: ${JSON.stringify(electronResult.deepPath)}`);
  assert.ok(electronResult.deepPath.breadcrumbToTitleGap >= 5, `路径栏和标题之间的间距不足: ${JSON.stringify(electronResult.deepPath)}`);
  assert.ok(Math.abs(electronResult.deepPath.navigationToDetailsDelta) <= 2, `导航图标没有和标题/文件数区域居中: ${JSON.stringify(electronResult.deepPath)}`);
  assert.ok(electronResult.deepPath.navigationToTitleGap >= 0, `导航图标与文件夹标题发生横向重叠: ${JSON.stringify(electronResult.deepPath)}`);
  assert.ok(Math.abs(electronResult.deepPath.sortToDetailsDelta) <= 2, `右侧排序控件没有和标题/文件数区域居中: ${JSON.stringify(electronResult.deepPath)}`);
  assert.equal(electronResult.deepPath.dividerVisible, true, `路径栏下方缺少分隔线: ${JSON.stringify(electronResult.deepPath)}`);
  assert.ok(electronResult.deepPath.breadcrumbLeftGap <= 2, `导航按钮下移后路径栏仍被旧占位推向右侧: ${JSON.stringify(electronResult.deepPath)}`);
  assert.ok(electronResult.deepPath.breadcrumbWidth >= electronResult.deepPath.fullNaturalWidth, `路径栏没有容纳完整路径: ${JSON.stringify(electronResult.deepPath)}`);
  assert.ok(electronResult.deepPath.currentTextGap <= 4, `当前路径文字被按钮居中撑开: ${JSON.stringify(electronResult.deepPath)}`);
  assert.equal(electronResult.fitPath.compact, false, `完整路径放得下时不应折叠: ${JSON.stringify(electronResult.fitPath)}`);
  assert.deepEqual(electronResult.fitPath.labels, ['路径测试资料库', 'Alpha', 'Beta', 'Gamma', 'Delta']);
});
