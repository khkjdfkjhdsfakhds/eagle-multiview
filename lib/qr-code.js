'use strict';

// Minimal, dependency-free QR encoder for the web-access address dialog.
// Scope: byte mode, error-correction level M, versions 1-6 (up to 108 data
// bytes — far beyond any http://ip:port URL), fixed mask 0. Any scanner
// decodes any mask, so skipping mask evaluation only trades a little visual
// balance for a lot less code.

// --- GF(256) arithmetic -----------------------------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}

function polyMultiply(a, b) {
  const result = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      if (a[i] && b[j]) result[i + j] ^= EXP[(LOG[a[i]] + LOG[b[j]]) % 255];
    }
  }
  return result;
}

function rsGenerator(degree) {
  let generator = [1];
  for (let i = 0; i < degree; i += 1) generator = polyMultiply(generator, [1, EXP[i]]);
  return generator;
}

function rsRemainder(data, generator) {
  const result = [...data, ...new Array(generator.length - 1).fill(0)];
  for (let i = 0; i < data.length; i += 1) {
    const factor = result[i];
    if (!factor) continue;
    for (let j = 0; j < generator.length; j += 1) {
      result[i + j] ^= EXP[(LOG[generator[j]] + LOG[factor]) % 255];
    }
  }
  return result.slice(data.length);
}

// --- version table (EC level M; block counts divide evenly for V1-6) --------
const VERSIONS = [
  null,
  { total: 26, ecPerBlock: 10, blocks: 1, align: [] },
  { total: 44, ecPerBlock: 16, blocks: 1, align: [6, 18] },
  { total: 70, ecPerBlock: 26, blocks: 1, align: [6, 22] },
  { total: 100, ecPerBlock: 18, blocks: 2, align: [6, 26] },
  { total: 134, ecPerBlock: 24, blocks: 2, align: [6, 30] },
  { total: 172, ecPerBlock: 16, blocks: 4, align: [6, 34] }
];

function dataCapacity(version) {
  const spec = VERSIONS[version];
  return spec.total - spec.ecPerBlock * spec.blocks;
}

function pickVersion(byteLength) {
  for (let version = 1; version < VERSIONS.length; version += 1) {
    // mode (4 bits) + length (8 bits) + data must fit the data codewords.
    if (12 + byteLength * 8 <= dataCapacity(version) * 8) return version;
  }
  throw new Error('内容过长，超出二维码容量');
}

function encodeCodewords(bytes, version) {
  const capacity = dataCapacity(version);
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    codewords.push(value);
  }
  for (let padIndex = 0; codewords.length < capacity; padIndex += 1) {
    codewords.push(padIndex % 2 === 0 ? 0xec : 0x11);
  }

  const spec = VERSIONS[version];
  const perBlock = capacity / spec.blocks;
  const blocks = [];
  const generator = rsGenerator(spec.ecPerBlock);
  for (let b = 0; b < spec.blocks; b += 1) {
    const data = codewords.slice(b * perBlock, (b + 1) * perBlock);
    blocks.push({ data, ec: rsRemainder(data, generator) });
  }
  const interleaved = [];
  for (let i = 0; i < perBlock; i += 1) for (const block of blocks) interleaved.push(block.data[i]);
  for (let i = 0; i < spec.ecPerBlock; i += 1) for (const block of blocks) interleaved.push(block.ec[i]);
  return interleaved;
}

// --- matrix -----------------------------------------------------------------
function formatBits(maskPattern) {
  // EC level M = 0b00.
  const data = maskPattern & 0b111;
  let remainder = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((remainder >> i) & 1) remainder ^= 0b10100110111 << (i - 10);
  }
  return ((data << 10) | remainder) ^ 0b101010000010010;
}

function generateQRMatrix(text) {
  const bytes = new TextEncoder().encode(String(text));
  const version = pickVersion(bytes.length);
  const size = 17 + version * 4;
  const matrix = Array.from({ length: size }, () => new Array(size).fill(null));
  const functional = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (row, col, value) => {
    matrix[row][col] = value ? 1 : 0;
    functional[row][col] = true;
  };

  const placeFinder = (top, left) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const row = top + r;
        const col = left + c;
        if (row < 0 || col < 0 || row >= size || col >= size) continue;
        const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
        const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(row, col, inOuter || inInner);
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  const { align } = VERSIONS[version];
  for (const centerRow of align) {
    for (const centerCol of align) {
      if (functional[centerRow][centerCol]) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          set(centerRow + r, centerCol + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i += 1) {
    if (!functional[6][i]) set(6, i, i % 2 === 0);
    if (!functional[i][6]) set(i, 6, i % 2 === 0);
  }

  // Reserve the format areas (real bits land after masking) + dark module.
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      if (!functional[8][i]) set(8, i, 0);
      if (!functional[i][8]) set(i, 8, 0);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    if (!functional[8][size - 1 - i]) set(8, size - 1 - i, 0);
    if (!functional[size - 1 - i][8]) set(size - 1 - i, 8, 0);
  }
  set(size - 8, 8, 1);

  // Zigzag data placement over non-functional modules.
  const codewords = encodeCodewords(bytes, version);
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (matrix[row][c] !== null) continue;
        const bit = bitIndex < totalBits ? (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1 : 0;
        matrix[row][c] = bit;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }

  // Mask 0 flips data modules where (row + col) is even.
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!functional[row][col] && (row + col) % 2 === 0) matrix[row][col] ^= 1;
    }
  }

  // Format information, both copies, most significant bit first.
  const format = formatBits(0);
  const bit = index => (format >> (14 - index)) & 1;
  const aroundTopLeft = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
  ];
  const splitCopy = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]
  ];
  aroundTopLeft.forEach(([row, col], index) => { matrix[row][col] = bit(index); });
  splitCopy.forEach(([row, col], index) => { matrix[row][col] = bit(index); });

  return { size, version, modules: matrix.map(row => row.map(Boolean)) };
}

// SVG rendering with a quiet zone, ready to drop into the settings dialog.
function qrToSVG(text, { moduleSize = 4, quietZone = 4, dark = '#000', light = '#fff' } = {}) {
  const { size, modules } = generateQRMatrix(text);
  const dimension = (size + quietZone * 2) * moduleSize;
  const rects = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!modules[row][col]) continue;
      rects.push(`<rect x="${(col + quietZone) * moduleSize}" y="${(row + quietZone) * moduleSize}" width="${moduleSize}" height="${moduleSize}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" width="${dimension}" height="${dimension}" shape-rendering="crispEdges">` +
    `<rect width="${dimension}" height="${dimension}" fill="${light}"/><g fill="${dark}">${rects.join('')}</g></svg>`;
}

module.exports = { generateQRMatrix, qrToSVG, formatBits, pickVersion, rsGenerator, rsRemainder };
