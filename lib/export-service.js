'use strict';

const path = require('node:path');

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function uniqueDestination(destinationRoot, fileName, existsSync) {
  const parsed = path.parse(fileName);
  let candidate = path.join(destinationRoot, fileName);
  let index = 2;
  while (existsSync(candidate)) {
    candidate = path.join(destinationRoot, `${parsed.name} (${index})${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

async function exportFiles({ filePaths = [], destinationRoot, libraryPath, fs, pathModule = path }) {
  const unique = [...new Set(filePaths.filter(Boolean).map(filePath => pathModule.resolve(filePath)))];
  if (!unique.length) return { count: 0, missing: 0, files: [] };
  if (!destinationRoot) throw new Error('请选择导出目录');
  if (libraryPath && isInside(libraryPath, destinationRoot)) {
    throw new Error('不能把文件导出到当前 Eagle 资料库内部');
  }
  await fs.mkdir(destinationRoot, { recursive: true });
  const copied = [];
  let missing = 0;
  for (const source of unique) {
    try {
      await fs.access(source);
    } catch {
      missing += 1;
      continue;
    }
    const destination = uniqueDestination(destinationRoot, pathModule.basename(source), fs.existsSync);
    await fs.copyFile(source, destination);
    copied.push(destination);
  }
  return { count: copied.length, missing, files: copied };
}

module.exports = { exportFiles, isInside, uniqueDestination };
