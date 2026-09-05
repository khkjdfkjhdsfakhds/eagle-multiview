'use strict';

function sessionError(code, message) { return Object.assign(new Error(message), { code }); }

class SiteImportSessions {
  constructor({ discover, ensureLibraryPath, ensureDestination = async () => {}, addAsset, refresh = async () => {},
    now = Date.now, ttlMs = 15 * 60 * 1000, maxSessions = 20, maxAssets = 5000 }) {
    Object.assign(this, { discover, ensureLibraryPath, ensureDestination, addAsset, refresh });
    this.now = now;
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.min(ttlMs, 60 * 60 * 1000) : 15 * 60 * 1000;
    this.maxSessions = Number.isInteger(maxSessions) && maxSessions > 0 ? Math.min(maxSessions, 100) : 20;
    this.maxAssets = Number.isInteger(maxAssets) && maxAssets > 0 ? Math.min(maxAssets, 10000) : 5000;
    this.sessions = new Map();
  }

  async start({ owner, requestId, url, libraryPath, folderId = null }) {
    if ((typeof owner !== 'string' && typeof owner !== 'number') || !String(owner) || typeof requestId !== 'string' || !requestId || requestId.length > 200 ||
      typeof libraryPath !== 'string' || !libraryPath || (folderId !== null && (typeof folderId !== 'string' || !folderId))) {
      throw sessionError('SITE_SESSION_INVALID', '站点导入任务身份或目标无效');
    }
    for (const [id, session] of this.sessions) {
      if (session.expiresAt > this.now()) continue;
      session.canceled = true;
      session.controller.abort();
      if (!session.busy) this.sessions.delete(id);
    }
    if (this.sessions.has(requestId)) throw sessionError('SITE_SESSION_EXISTS', '此站点导入任务已存在');
    if (this.sessions.size >= this.maxSessions) throw sessionError('SITE_SESSION_LIMIT', '站点导入任务数量已达上限，请稍后重试');
    const session = { owner, requestId, url, libraryPath, folderId, assets: new Map(), outcomes: new Map(), controller: new AbortController(), busy: false, canceled: false, nextPage: 1, expiresAt: this.now() + this.ttlMs };
    this.sessions.set(requestId, session);
    return this.loadPage(session);
  }

  async loadPage(session) {
    this.checkAvailable(session);
    if (!session.nextPage) return { requestId: session.requestId, assets: [], totalAssets: session.assets.size, nextPage: null, complete: true };
    session.busy = true;
    try {
      await this.ensureLibraryPath(session.libraryPath);
      if (session.canceled) throw sessionError('ABORT_ERR', '已取消站点导入');
      session.lastPage = session.nextPage;
      const result = await this.discover({ url: session.url, startPage: session.nextPage, maxPages: 1, signal: session.controller.signal });
      await this.ensureLibraryPath(session.libraryPath);
      if (session.canceled) throw sessionError('ABORT_ERR', '已取消站点导入');
      const assets = [];
      let limited = false;
      for (const asset of result.assets) {
        if (session.assets.has(asset.id)) continue;
        if (session.assets.size >= this.maxAssets) { limited = true; break; }
        session.assets.set(asset.id, Object.freeze({ ...asset }));
        assets.push({ ...asset });
      }
      session.nextPage = limited ? null : result.nextPage || null;
      return { ...result, assets, totalAssets: session.assets.size, requestId: session.requestId,
        ...(limited ? { nextPage: null, complete: false, truncated: true, partial: true,
          failures: [...(result.failures || []), { code: 'SITE_SESSION_ASSET_LIMIT', message: '本次任务图片数量已达上限，剩余图片未加载' }] } : {}) };
    } finally { session.busy = false; this.releaseCanceled(session); }
  }

  async next({ owner, requestId }) {
    return this.loadPage(this.getSession(owner, requestId));
  }

  async retry({ owner, requestId }) {
    const session = this.getSession(owner, requestId);
    this.checkAvailable(session);
    session.nextPage = session.lastPage || 1;
    return this.loadPage(session);
  }

  releaseCanceled(session) {
    if (session.canceled && !session.busy && !session.outcomes.size) this.sessions.delete(session.requestId);
  }

  cancel({ owner, requestId }) {
    const session = this.getSession(owner, requestId);
    session.canceled = true;
    session.controller.abort();
    this.releaseCanceled(session);
    return { requestId, canceled: true };
  }

  checkAvailable(session) {
    this.checkExpiry(session);
    if (session.busy) throw sessionError('SITE_SESSION_BUSY', '此导入任务正在操作，请等待当前操作结束');
    if (session.canceled) throw sessionError('ABORT_ERR', '已取消站点导入');
  }

  getSession(owner, requestId) {
    const session = this.sessions.get(requestId);
    if (!session || session.owner !== owner) throw sessionError('SITE_SESSION_NOT_FOUND', '站点导入任务不存在或已失效');
    this.checkExpiry(session);
    return session;
  }

  checkExpiry(session) {
    if (session.expiresAt > this.now()) return;
    session.canceled = true;
    session.controller.abort();
    throw sessionError('SITE_SESSION_EXPIRED', '站点导入任务已过期，请重新识别；此前已提交和待核对的图片请先在 Eagle 核对');
  }

  async importSelected({ owner, requestId, ids }) {
    const session = this.getSession(owner, requestId);
    this.checkAvailable(session);
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !session.assets.has(id))) throw sessionError('SITE_SELECTION_INVALID', '请选择本任务已经发现的图片');
    if (ids.some(id => session.outcomes.has(id))) throw sessionError('SITE_ASSET_ALREADY_SUBMITTED', '已提交或结果待核对的图片不会重复导入');
    const addedIds = [];
    const selected = [...new Set(ids)];
    const unknown = [];
    let notSubmitted = [];
    let error = null;
    session.busy = true;
    try {
    for (let index = 0; index < selected.length; index++) {
      const id = selected[index];
      try {
        this.checkExpiry(session);
        if (session.canceled) throw sessionError('ABORT_ERR', '已取消站点导入');
        await this.ensureLibraryPath(session.libraryPath);
        await this.ensureDestination({ libraryPath: session.libraryPath, folderId: session.folderId });
        await this.ensureLibraryPath(session.libraryPath);
        if (session.canceled) throw sessionError('ABORT_ERR', '已取消站点导入');
      } catch (failure) {
        error = { code: failure.code || 'SITE_DESTINATION_CHANGED', message: failure.message };
        notSubmitted = selected.slice(index);
        break;
      }
      session.outcomes.set(id, { status: 'pending' });
      try {
        const added = await this.addAsset({ asset: session.assets.get(id), libraryPath: session.libraryPath, folderId: session.folderId });
        const eagleId = typeof added === 'string' ? added : added?.id;
        if (typeof eagleId !== 'string' || !eagleId) throw sessionError('SITE_RESULT_UNKNOWN', 'Eagle 未返回素材 ID，请核对结果后再操作');
        session.outcomes.set(id, { status: 'committed', id: eagleId });
        addedIds.push(eagleId);
      } catch (failure) {
        error = { code: failure.code || 'SITE_RESULT_UNKNOWN', message: failure.message };
        session.outcomes.set(id, { status: 'unknown' });
        unknown.push(id);
        notSubmitted = selected.slice(index + 1);
        break;
      }
    }
    try {
      await this.ensureLibraryPath(session.libraryPath);
      await this.refresh({ libraryPath: session.libraryPath, ids: addedIds });
    } catch (failure) {
      error ||= { code: failure.code || 'SITE_REFRESH_FAILED', message: failure.message };
    }
    return { requestId, ids: addedIds, count: addedIds.length, unknown, notSubmitted, error,
      outcomes: selected.filter(id => session.outcomes.has(id)).map(assetId => ({ assetId, ...session.outcomes.get(assetId) })), partial: Boolean(error), canceled: session.canceled };
    } finally { session.busy = false; this.releaseCanceled(session); }
  }
}

module.exports = { SiteImportSessions };
