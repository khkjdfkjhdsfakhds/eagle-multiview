'use strict';

function buildIdentity(version = '') {
  if (String(version).includes('-review.')) return {
    name: 'Eagle MultiView Review', profile: 'eagle-multiview-review-20260905', webPort: 41601
  };
  return { name: 'Eagle MultiView', profile: null, webPort: 41600 };
}

module.exports = { buildIdentity };
