'use strict';

const { buildIdentity } = require('../lib/app-identity');
const pkg = require('../package.json');

// Fixtures must follow the same package-selected identity as the actual app.
// The product plugin remains unchanged, so a mismatched pairing still fails.
const identity = buildIdentity(pkg.version);
module.exports = Object.freeze({ ...identity, profile: identity.profile || pkg.name });
