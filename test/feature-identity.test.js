'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIdentity } = require('../lib/app-identity');

test('consolidated features retain the existing Review identity and TXT pairing', () => {
  const pkg = require('../package.json');
  assert.match(pkg.version, /-review\./);
  assert.equal(pkg.build.productName, 'Eagle MultiView Review');
  assert.equal(pkg.build.appId, 'local.eagle.multiview.review.20260905');
  assert.deepEqual(buildIdentity(pkg.version), {
    name: 'Eagle MultiView Review', profile: 'eagle-multiview-review-20260905', webPort: 41601
  });
  assert.equal(buildIdentity('1.7.1-review.2').profile, 'eagle-multiview-review-20260905');
  assert.equal(buildIdentity('1.7.0').profile, null);
});
