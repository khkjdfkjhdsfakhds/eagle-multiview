'use strict';

const path = require('node:path');

// Official Eagle thumbnail operations only. Source preparation belongs to the
// caller: desktop file chooser/clipboard, or explicitly uploaded Web bytes.
class ThumbnailOperations {
  constructor({ client, ensureLibraryPath, publishItemMutation = () => {}, invalidateThumbnail = () => {}, enqueue }) {
    this.client = client;
    this.ensureLibraryPath = ensureLibraryPath;
    this.publishItemMutation = publishItemMutation;
    this.invalidateThumbnail = invalidateThumbnail;
    const queues = new Map();
    this.enqueue = enqueue || ((id, operation) => {
      const current = (queues.get(id) || Promise.resolve()).catch(() => {}).then(operation);
      queues.set(id, current);
      const release = () => { if (queues.get(id) === current) queues.delete(id); };
      current.then(release, release);
      return current;
    });
  }

  async run({ ids, libraryPath, operation, filePath, origin = null, signal } = {}) {
    const absolutePath = value => typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value);
    if (!['refresh', 'file', 'clipboard'].includes(operation) || !absolutePath(libraryPath)
      || !Array.isArray(ids) || ids.length < 1 || ids.length > 500
      || ids.some(id => typeof id !== 'string' || !id.trim() || id.includes('\0') || id.length > 200)
      || (operation !== 'refresh' && !absolutePath(filePath))) {
      const error = new Error('缺少有效的缩略图操作、资料库、选择或图片路径；取消自定义缩略图尚无受支持接口');
      error.code = 'INVALID_THUMBNAIL_REQUEST';
      throw error;
    }
    const outcomes = [];
    const selected = [...new Set(ids)];
    let stopped = null;
    for (const id of selected) {
      await this.enqueue(id, async () => {
        let phase = 'preflight';
        let writeCompleted = false;
        try {
          if (signal?.aborted || stopped) {
            outcomes.push({ id, status: 'canceled', phase, code: stopped || 'NOT_STARTED' });
            return;
          }
          await this.ensureLibraryPath(libraryPath);
          if (signal?.aborted) {
            outcomes.push({ id, status: 'canceled', phase, code: 'NOT_STARTED' });
            return;
          }
          phase = 'write';
          if (operation === 'refresh') {
            const accepted = await this.client.refreshThumbnail(id);
            await this.ensureLibraryPath(libraryPath);
            outcomes.push({ id, status: accepted === true ? 'accepted' : 'failed', code: accepted === true ? 'GENERATION_ACCEPTED' : 'REFRESH_REJECTED', phase });
            return;
          }
          const generated = await this.client.setCustomThumbnail(id, filePath);
          if (generated !== true) {
            outcomes.push({ id, status: 'unknown', code: 'GENERATION_UNCONFIRMED', phase });
            return;
          }
          writeCompleted = true;
          phase = 'readback';
          await this.ensureLibraryPath(libraryPath);
          const item = await this.client.getItem(id);
          await this.ensureLibraryPath(libraryPath);
          if (!item || item.id !== id) throw Object.assign(new Error('缩略图已写入，素材回读身份未确认'), { code: 'READBACK_MISMATCH' });
          const context = { libraryPath, origin, reason: 'custom-thumbnail' };
          await this.invalidateThumbnail(id, context);
          await this.publishItemMutation(item, context);
          outcomes.push({ id, status: 'completed', item, phase: 'complete', writeCompleted });
        } catch (error) {
          if (error?.code === 'LIBRARY_CHANGED') stopped = error.code;
          outcomes.push({ id, status: phase === 'preflight' ? (stopped ? 'canceled' : 'failed') : 'unknown', phase, writeCompleted, code: error?.code || 'THUMBNAIL_OPERATION_ERROR', message: error?.message || String(error) });
        }
      });
    }
    const counts = { completed: 0, accepted: 0, failed: 0, unknown: 0, canceled: 0 };
    for (const outcome of outcomes) counts[outcome.status] += 1;
    return { operation, libraryPath, outcomes, counts };
  }
}

module.exports = { ThumbnailOperations };
