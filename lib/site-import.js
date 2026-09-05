'use strict';

const { createHash } = require('node:crypto');
const ORIGIN = 'https://www.artstation.com';
const IMAGE_HOSTS = new Set(['cdna.artstation.com', 'cdnb.artstation.com', 'cdnc.artstation.com', 'assets.artstation.com']);

function siteError(code, message) { return Object.assign(new Error(message), { code }); }

function profileAuthor(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  const normalized = input.startsWith('www.artstation.com/') || input.startsWith('artstation.com/') ? `https://${input}` : input;
  const match = /^https:\/\/(?:www\.)?artstation\.com\/([a-zA-Z0-9_-]{1,100})\/?(?:[?#].*)?$/.exec(normalized);
  if (!match || ['artwork', 'users', 'projects', 'marketplace', 'search', 'learning', 'jobs', 'blogs', 'channels', 'prints'].includes(match[1].toLowerCase())) {
    throw siteError('SITE_URL_INVALID', '请输入 ArtStation 作者主页链接（https://www.artstation.com/作者名）');
  }
  return match[1];
}

function imageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname) || url.port || url.username || url.password ||
      !/\.(?:jpg|jpeg|png|gif|webp|avif)$/i.test(url.pathname)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function createSiteImportService({ fetch: fetchImpl = globalThis.fetch, limits = {} } = {}) {
  const limit = (key, fallback, ceiling) => Number.isFinite(limits[key]) && limits[key] > 0 ? Math.min(Math.floor(limits[key]), ceiling) : fallback;
  const timeoutMs = limit('timeoutMs', 30000, 120000);
  const maxResponseBytes = limit('maxResponseBytes', 4 * 1024 * 1024, 8 * 1024 * 1024);
  const maxTotalBytes = limit('maxTotalBytes', 16 * 1024 * 1024, 32 * 1024 * 1024);
  const maxProjects = limit('maxProjects', 250, 500);
  const maxAssets = limit('maxAssets', 2000, 5000);

  async function abortable(promise, signal) {
    if (signal.aborted) throw signal.reason;
    let stop;
    const aborted = new Promise((resolve, reject) => {
      stop = () => reject(signal.reason);
      signal.addEventListener('abort', stop, { once: true });
    });
    try { return await Promise.race([promise, aborted]); }
    finally { signal.removeEventListener('abort', stop); }
  }

  async function requestJson(url, signal, budget) {
    if (signal.aborted) throw signal.reason;
    let response;
    try { response = await abortable(fetchImpl(url, { credentials: 'omit', redirect: 'error', signal }), signal); }
    catch (error) {
      if (signal.aborted) throw signal.reason;
      throw siteError('SITE_REQUEST_FAILED', 'ArtStation 请求失败，请检查网络连接');
    }
    if (!response.ok) throw siteError('SITE_HTTP_ERROR', `ArtStation 请求失败（HTTP ${response.status}）`);
    const declaredBytes = Number(response.headers?.get('content-length'));
    const tooLarge = () => siteError('SITE_RESPONSE_LIMIT', '站点响应超过本次读取大小限制，已停止加载');
    if (declaredBytes > maxResponseBytes || declaredBytes + budget.bytes > maxTotalBytes) {
      await response.body?.cancel().catch(() => {});
      throw tooLarge();
    }
    let size = 0;
    const chunks = [];
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await abortable(reader.read(), signal);
          if (chunk.done) break;
          size += chunk.value.byteLength;
          budget.bytes += chunk.value.byteLength;
          if (size > maxResponseBytes || budget.bytes > maxTotalBytes) throw tooLarge();
          chunks.push(Buffer.from(chunk.value));
        }
      } catch (error) {
        reader.cancel().catch(() => {});
        throw error;
      } finally { reader.releaseLock(); }
    } else {
      const body = Buffer.from(await abortable(response.text(), signal));
      budget.bytes += body.length;
      if (body.length > maxResponseBytes || budget.bytes > maxTotalBytes) throw tooLarge();
      chunks.push(body);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw siteError('SITE_RESPONSE_INVALID', 'ArtStation 返回的内容不是有效 JSON'); }
  }
  return {
    async discover({ url, startPage = 1, maxPages = 1, signal } = {}) {
      const author = profileAuthor(url);
      if (!Number.isInteger(startPage) || startPage < 1 || startPage > 10000 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) {
        throw siteError('SITE_PAGE_INVALID', '页码必须为正整数，每次最多加载 5 页');
      }
      const sourceUrl = `${ORIGIN}/${author}`;
      const assets = [];
      const failures = [];
      const projectIds = new Set();
      const assetIds = new Set();
      const controller = new AbortController();
      const stop = () => controller.abort(siteError('ABORT_ERR', '已取消站点加载'));
      if (signal?.aborted) stop();
      else signal?.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(() => controller.abort(siteError('SITE_TIMEOUT', '站点加载超时，请稍后重试')), timeoutMs);
      const budget = { bytes: 0 };
      const requestSignal = controller.signal;
      let nextPage = startPage;
      let complete = false;
      let truncated = false;
      try {
      for (let step = 0; step < maxPages; step++) {
        const page = startPage + step;
        let list;
        try {
          list = await requestJson(`${ORIGIN}/users/${author}/projects.json?page=${page}`, requestSignal, budget);
          if (!Array.isArray(list?.data)) throw siteError('SITE_RESPONSE_INVALID', 'ArtStation 未返回有效作品列表');
        } catch (error) {
          if (requestSignal.aborted) throw requestSignal.reason;
          if (step === 0) throw error;
          failures.push({ page, code: error.code || 'SITE_REQUEST_FAILED', message: error.message });
          truncated = error.code === 'SITE_RESPONSE_LIMIT';
          nextPage = page;
          break;
        }
        for (const project of list.data) {
          if (!project || typeof project.hash_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(project.hash_id)) {
            failures.push({ code: 'SITE_PROJECT_INVALID', message: '站点返回了无效的作品标识，已跳过' });
            continue;
          }
          if (projectIds.has(project.hash_id)) continue;
          if (projectIds.size >= maxProjects) {
            failures.push({ code: 'SITE_PROJECT_LIMIT', message: '作品数超过本次加载上限，未加载剩余作品' });
            truncated = true;
            break;
          }
          projectIds.add(project.hash_id);
          let detail;
          try {
            detail = await requestJson(`${ORIGIN}/projects/${project.hash_id}.json`, requestSignal, budget);
            if (!Array.isArray(detail?.assets)) throw siteError('SITE_RESPONSE_INVALID', 'ArtStation 未返回有效素材列表');
          } catch (error) {
            if (requestSignal.aborted) throw requestSignal.reason;
            failures.push({ projectId: project.hash_id, code: error.code || 'SITE_REQUEST_FAILED', message: error.code ? error.message : 'ArtStation 作品请求失败，请检查网络连接' });
            if (error.code === 'SITE_RESPONSE_LIMIT') { truncated = true; break; }
            continue;
          }
          for (const asset of [...detail.assets].sort((a, b) => (Number(a?.position) || 0) - (Number(b?.position) || 0))) {
            const assetUrl = imageUrl(asset?.image_url);
            if (!assetUrl || asset.player_embedded || asset.oembed || /video/i.test(asset.asset_type || asset.type || '')) {
              failures.push({ projectId: project.hash_id, code: 'SITE_ASSET_UNSUPPORTED', message: '该素材不是受支持的 ArtStation 原始图片，已跳过' });
              continue;
            }
            const assetId = typeof asset.id === 'number' || typeof asset.id === 'string'
              ? String(asset.id).slice(0, 100) : createHash('sha256').update(assetUrl).digest('hex').slice(0, 24);
            const id = `artstation:${project.hash_id}:${assetId}`;
            if (assetIds.has(id)) continue;
            if (assets.length >= maxAssets) {
              failures.push({ code: 'SITE_ASSET_LIMIT', message: '图片数超过本次加载上限，未加载剩余图片' });
              truncated = true;
              break;
            }
            assetIds.add(id);
            assets.push({ id, name: typeof project.title === 'string' ? project.title.slice(0, 1024) : project.hash_id,
              url: assetUrl, website: `${ORIGIN}/artwork/${project.hash_id}`,
              width: Number.isFinite(asset.width) && asset.width > 0 ? asset.width : null,
              height: Number.isFinite(asset.height) && asset.height > 0 ? asset.height : null,
              projectId: project.hash_id, assetId });
          }
          if (truncated) break;
        }
        complete = !list.data.length || (page === 1 && list.total_count <= list.data.length);
        nextPage = complete ? null : page + 1;
        if (complete || truncated) break;
      }
      return { site: 'artstation', author, sourceUrl, assets, failures, complete: complete && !truncated, nextPage: truncated ? null : nextPage, truncated, partial: failures.length > 0 };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
      }
    }
  };
}

module.exports = { createSiteImportService };
