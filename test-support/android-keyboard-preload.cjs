'use strict';
// Present the renderer with what the Android WebView shell reports.
Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'Linux aarch64' });
Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: () => ({ platform: 'Android', mobile: false, brands: [] }) });
require('./web-platform-preload.cjs');
