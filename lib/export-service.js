'use strict';

const path = require('node:path');
const { COPYFILE_EXCL } = require('node:fs').constants;

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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
  // Resolve the closest existing ancestor before mkdir: an alias to a
  // library must not even create a directory there when export is rejected.
  const resolveDestination = async candidate => {
    try { return await fs.realpath(candidate); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = pathModule.dirname(candidate);
      if (parent === candidate) throw error;
      return pathModule.join(await resolveDestination(parent), pathModule.basename(candidate));
    }
  };
  const canonicalLibrary = libraryPath ? await fs.realpath(libraryPath) : null;
  let destinationDirectory = await resolveDestination(pathModule.resolve(destinationRoot));
  const guardDestination = target => {
    if (canonicalLibrary && isInside(canonicalLibrary, target)) throw new Error('不能把文件导出到当前 Eagle 资料库内部');
  };
  guardDestination(destinationDirectory);
  await fs.mkdir(destinationDirectory, { recursive: true });
  destinationDirectory = await fs.realpath(destinationDirectory);
  guardDestination(destinationDirectory);
  const copied = [];
  let missing = 0;
  const seenSources = new Set();
  for (const selectedSource of unique) {
    let source;
    try {
      source = await fs.realpath(selectedSource);
      await fs.access(source);
    } catch {
      missing += 1;
      continue;
    }
    if (seenSources.has(source)) continue;
    seenSources.add(source);
    const occupied = new Set();
    while (true) {
      const destination = uniqueDestination(destinationDirectory, pathModule.basename(selectedSource), candidate => occupied.has(candidate) || fs.existsSync(candidate));
      try {
        await fs.copyFile(source, destination, COPYFILE_EXCL);
        copied.push(destination);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          if (copied.length) {
            // Keep both the cancellation/error code and confirmed outputs.
            // Electron may serialize only the message, so its visible text
            // must also disclose partial success. Never roll back files the
            // user has already received, and never log their private paths.
            error.partial = { count: copied.length, missing, requested: unique.length, files: [...copied], failedDestination: destination };
            error.message = `已导出 ${copied.length} 个素材，剩余已停止。${error.message || '导出失败'}`;
          }
          throw error;
        }
        occupied.add(destination);
        // Another window won the name after our scan. Exclusive copying
        // keeps both outputs intact; resolve another name against disk.
      }
    }
  }
  return { count: copied.length, missing, files: copied };
}

module.exports = { exportFiles, isInside, uniqueDestination };
