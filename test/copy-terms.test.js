'use strict';
// P3 wording batch: one vocabulary, taken from Eagle's zh_CN strings
// (GUI-07, P2-04, F-15, F-16, GUI-06, B1 wording).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const userFacing = [
  'main.js', 'src/renderer.js', 'src/index.html', 'src/feature-ui.js', 'src/site-import-ui.js', 'src/thumbnail-ui.js',
  'src/update.js', 'src/web-shim.js', ...fs.readdirSync(path.join(root, 'lib')).filter(name => name.endsWith('.js')).map(name => 'lib/' + name)
];

test('the library is 资源库 and quotes are “”, as in Eagle', () => {
  for (const file of userFacing) {
    const source = read(file);
    assert.doesNotMatch(source, /资料库/, file + ' still says 资料库');
    assert.doesNotMatch(source, /[「」]/, file + ' still uses 「」');
  }
});

test('sidebar, trash and Finder wording match Eagle', () => {
  const renderer = read('src/renderer.js');
  const html = read('src/index.html');
  assert.match(renderer, /data-special="all">[\s\S]{0,200}?<span class="folder-name">全部<\/span>/);
  assert.match(renderer, /data-special="untagged">[\s\S]{0,200}?<span class="folder-name">未标签<\/span>/);
  assert.doesNotMatch(renderer + html, /废纸篓|全部素材'|未加标签|在 Finder 中显示/);
  assert.match(html, /id="trashButton"[^>]*>丢到回收站</);
  assert.match(html, /id="finderButton"[^>]*>在访达中打开</);
});

test('the app menu has Chinese labels and one name for a new window', () => {
  const main = read('main.js');
  for (const role of ['about', 'hide', 'hideOthers', 'unhide', 'quit']) {
    assert.match(main, new RegExp(`role: '${role}', label: `), role + ' has no label');
  }
  assert.doesNotMatch(main, /label: '新窗口'/);
});

test('status bar counts items like Eagle instead of a scroll percentage', () => {
  const renderer = read('src/renderer.js');
  assert.match(read('src/index.html'), /<span id="scrollStatus">0 个项目<\/span>/);
  assert.match(renderer, / 个项目`/);
  assert.doesNotMatch(renderer, /scrollTop \/ maximum \* 100/);
});

test('formatBytes never shows 1024 of a unit and reaches TB', () => {
  const source = read('src/renderer.js').match(/function formatBytes\(bytes\) \{[\s\S]*?\n\}/)[0];
  const formatBytes = new Function(`${source}; return formatBytes;`)();
  assert.equal(formatBytes(1023.95 * 1024), '1.0 MB');
  assert.equal(formatBytes(1024 ** 2 - 1), '1.0 MB');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(3 * 1024 ** 4), '3.0 TB');
});

test('empty views use Eagle-style wording per view', () => {
  const renderer = read('src/renderer.js');
  const body = renderer.match(/function emptyStateCopy\(\) \{[\s\S]*?\n\}/)[0];
  for (const text of ['回收站是空的', '所有文件已经都分类完成啦！', '所有文件都已经有标签啦！', '也许换个搜索规则就能找到它！', '拖放文件到这里']) {
    assert.ok(body.includes(text), text);
  }
  assert.doesNotMatch(renderer, /可以调整筛选条件，或将文件导入当前文件夹/);
});
