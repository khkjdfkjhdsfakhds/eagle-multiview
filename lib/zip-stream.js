'use strict';

// Dependency-free STORE-mode zip streaming for web exports. Files are not
// compressed (library media is already compressed); CRCs are computed while
// streaming and emitted in data descriptors, so nothing is buffered.
// No zip64: callers must keep the total under ~4GB (guarded upstream).

const fs = require('node:fs');
const zlib = require('node:zlib');

const LOCAL_SIGNATURE = 0x04034b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
// Bit 3: sizes/CRC follow the data. Bit 11: names are UTF-8.
const FLAGS = 0x0808;

function dosDateTime(date = new Date(2020, 0, 1)) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

async function write(output, buffer) {
  if (output.destroyed || output.writableEnded) throw new Error('下载连接已关闭');
  if (!output.write(buffer)) await new Promise((resolve, reject) => {
    const finish = error => {
      output.off('drain', onDrain);
      output.off('close', onClose);
      output.off('error', onError);
      error ? reject(error) : resolve();
    };
    const onDrain = () => finish();
    const onClose = () => finish(new Error('下载连接已关闭'));
    const onError = error => finish(error);
    output.once('drain', onDrain);
    output.once('close', onClose);
    output.once('error', onError);
    if (output.destroyed) onClose();
  });
}

// entries: [{ name, filePath, mtime? }] — names must already be deduplicated.
async function writeStoreZip(output, entries) {
  let offset = 0;
  const central = [];
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const { time, date } = dosDateTime(entry.mtime instanceof Date ? entry.mtime : undefined);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(FLAGS, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    // CRC and sizes are zero here; the data descriptor carries the truth.
    localHeader.writeUInt16LE(nameBytes.length, 26);
    const headerOffset = offset;
    await write(output, localHeader);
    await write(output, nameBytes);
    offset += 30 + nameBytes.length;

    let crc = 0;
    let size = 0;
    const stream = fs.createReadStream(entry.filePath);
    for await (const chunk of stream) {
      crc = zlib.crc32(chunk, crc);
      size += chunk.length;
      await write(output, chunk);
    }
    offset += size;

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(DESCRIPTOR_SIGNATURE, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    await write(output, descriptor);
    offset += 16;

    central.push({ nameBytes, crc: crc >>> 0, size, time, date, headerOffset });
  }

  const centralStart = offset;
  for (const record of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(FLAGS, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(record.time, 12);
    header.writeUInt16LE(record.date, 14);
    header.writeUInt32LE(record.crc, 16);
    header.writeUInt32LE(record.size, 20);
    header.writeUInt32LE(record.size, 24);
    header.writeUInt16LE(record.nameBytes.length, 28);
    header.writeUInt32LE(record.headerOffset, 42);
    await write(output, header);
    await write(output, record.nameBytes);
    offset += 46 + record.nameBytes.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - centralStart, 12);
  eocd.writeUInt32LE(centralStart, 16);
  await write(output, eocd);
}

// "a.png, a.png, b.png" → "a.png, a-2.png, b.png"
function dedupeNames(names) {
  const used = new Set();
  return names.map(name => {
    const dot = name.lastIndexOf('.');
    let candidate = name;
    let suffix = 2;
    // Archives are often extracted on case-insensitive, Unicode-normalizing disks.
    while (used.has(candidate.normalize('NFC').toLowerCase())) {
      candidate = dot > 0 ? `${name.slice(0, dot)}-${suffix}${name.slice(dot)}` : `${name}-${suffix}`;
      suffix++;
    }
    used.add(candidate.normalize('NFC').toLowerCase());
    return candidate;
  });
}

module.exports = { writeStoreZip, dedupeNames, dosDateTime };
