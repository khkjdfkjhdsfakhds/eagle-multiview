'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function probeLayoutPopover({ zoom, sidebar = '', inspector = '' } = {}) {
  const electron = require('electron');
  const runner = require.resolve('../test-support/layout-popover-probe.cjs');
  const env = {
    ...process.env,
    EAGLEMV_PROBE_ZOOM: String(zoom || 1),
    EAGLEMV_PROBE_SIDEBAR: sidebar,
    EAGLEMV_PROBE_INSPECTOR: inspector
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout, stderr } = await execFileAsync(electron, ['--disable-logging', runner], { env, timeout: 50000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_LAYOUT_PROBE '));
  assert.ok(line, `missing layout popover probe result: ${stdout}`);
  return JSON.parse(line.slice('EAGLEMV_LAYOUT_PROBE '.length));
}

test('pane layout popover never clips the single-pane option at desktop zooms', { timeout: 120000 }, async () => {
  const configs = [
    { zoom: 1 },
    { zoom: 1.2 },
    { zoom: 1.4 },
    { zoom: 1.4, sidebar: '150px', inspector: '220px' }
  ];
  for (const config of configs) {
    const label = `${config.zoom}x` + (config.sidebar ? ' 窄面板' : ' 默认面板');
    const result = await probeLayoutPopover(config);
    const single = result.rows.find(row => row.layout === 'single');
    assert.ok(single, `${label} 弹层缺少单栏选项`);
    const popoverRight = result.popoverRect.left + result.popoverRect.width;
    const singleRight = single.rect.left + single.rect.width;
    const popoverCenter = result.popoverRect.left + result.popoverRect.width / 2;
    assert.ok(result.popoverRect.left >= 0, `${label} 弹层被裁出屏幕左缘: ${JSON.stringify(result.popoverRect)}`);
    assert.ok(popoverRight <= result.innerWidth + 1, `${label} 弹层超出屏幕右缘`);
    assert.ok(Math.abs(popoverCenter - result.buttonRect.center) <= 2, `${label} 弹层没有水平居中在按钮下方: 弹层中心=${popoverCenter} 按钮中心=${result.buttonRect.center}`);
    assert.ok(single.rect.left >= 0, `${label} 单栏选项被裁出屏幕左缘: ${JSON.stringify(single.rect)}`);
    assert.ok(singleRight <= result.innerWidth + 1, `${label} 单栏选项超出屏幕右缘`);
    assert.ok(single.hitIsOption, `${label} 单栏选项中心不可点击命中`);
  }
});
