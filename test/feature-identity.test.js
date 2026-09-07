'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIdentity } = require('../lib/app-identity');

test('main release uses the formal identity while the archived Review remains isolated', () => {
  const pkg = require('../package.json');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.name, 'eagle-multiview');
  assert.equal(pkg.build.productName, 'Eagle MultiView');
  assert.equal(pkg.build.appId, 'local.eagle.multiview');
  const fs = require('node:fs');
  const path = require('node:path');
  assert.match(fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8'), /<title>Eagle MultiView<\/title>/);
  const plugin = require('../eagle-plugin/text-save-service/manifest.json');
  assert.equal(plugin.id, 'EAGLEMVTXT20260907');
  assert.deepEqual(buildIdentity(pkg.version), {
    name: 'Eagle MultiView', profile: null, webPort: 41600
  });
  assert.equal(buildIdentity('1.7.1-review.2').profile, 'eagle-multiview-review-20260905');
  assert.equal(buildIdentity('1.7.0').profile, null);
});
