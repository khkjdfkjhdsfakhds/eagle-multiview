'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { generateQRMatrix, qrToSVG, formatBits, pickVersion } = require('../lib/qr-code');

// Content correctness was proven against macOS CIDetector (5/5 decode PASS,
// including UTF-8 and multi-block versions); these tests pin the structure
// and a golden matrix so regressions cannot slip in silently.

test('format bits for EC-M mask 0 match the spec constant', () => {
  assert.equal(formatBits(0).toString(2).padStart(15, '0'), '101010000010010');
});

test('version selection tracks byte capacity', () => {
  assert.equal(pickVersion(1), 1);
  assert.equal(pickVersion(14), 1);   // V1-M holds 14 data bytes
  assert.equal(pickVersion(15), 2);
  assert.equal(pickVersion(26), 2);
  assert.equal(pickVersion(27), 3);
  assert.equal(pickVersion(106), 6);
  assert.throws(() => pickVersion(107), /容量/);
});

test('matrix structure: size, finders, timing, dark module', () => {
  const { size, version, modules } = generateQRMatrix('http://192.168.1.100:41600');
  assert.equal(version, 2, '26 字节 URL 落在 V2-M');
  assert.equal(size, 25);
  const finderAt = (top, left) => {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const expected = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        assert.equal(modules[top + r][left + c], expected, `finder(${top},${left}) @${r},${c}`);
      }
    }
  };
  finderAt(0, 0);
  finderAt(0, size - 7);
  finderAt(size - 7, 0);
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(modules[6][i], i % 2 === 0, `timing row @${i}`);
    assert.equal(modules[i][6], i % 2 === 0, `timing col @${i}`);
  }
  assert.equal(modules[size - 8][8], true, 'dark module');
});

test('golden matrix stays stable for the verified reference URL', () => {
  const { modules } = generateQRMatrix('http://192.168.1.100:41600');
  const flat = modules.map(row => row.map(Number).join('')).join('\n');
  const digest = crypto.createHash('sha256').update(flat).digest('hex').slice(0, 16);
  // This exact matrix decoded correctly via CoreImage CIDetector (2026-07-27).
  assert.equal(digest, '59917f7b1e103f0d');
});

test('svg renders with a quiet zone and crisp edges', () => {
  const svg = qrToSVG('http://10.0.0.5:41600', { moduleSize: 4, quietZone: 4 });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('shape-rendering="crispEdges"'));
  const { size } = generateQRMatrix('http://10.0.0.5:41600');
  assert.ok(svg.includes(`viewBox="0 0 ${(size + 8) * 4} ${(size + 8) * 4}"`));
});
