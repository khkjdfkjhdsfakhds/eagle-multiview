'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const MAX_IDS = 200000;
const orderKey = (scope, kind) => JSON.stringify([scope, kind]);
function validId(id) { return typeof id === 'string' && id.length > 0 && id.length <= 256; }
function uniqueIds(ids) {
  if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every(validId)) throw new Error('排序数据无效或超过上限');
  return [...new Set(ids)];
}
class ManualOrderStore {
  constructor(file) { this.file = file; this.data = null; this.loading = null; this.queue = Promise.resolve(); }
  libraryKey(libraryPath) {
    if (typeof libraryPath !== 'string' || !path.isAbsolute(libraryPath)) throw new Error('缺少资料库身份');
    return createHash('sha256').update(path.resolve(libraryPath)).digest('hex');
  }
  async load() {
    if (this.data) return;
    if (!this.loading) this.loading = (async () => { try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data.version !== 1 || !data.libraries || Array.isArray(data.libraries)) throw new Error('本地排序文件格式错误');
      this.data = data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = {version:1, libraries:{}};
    } })().finally(() => {this.loading=null;});
    await this.loading;
  }
  async get(libraryPath) {
    await this.queue;
    await this.load();
    return structuredClone(this.data.libraries[this.libraryKey(libraryPath)] || {});
  }
  move(payload) {
    const operation = this.queue.then(async () => {
      await this.load();
      const {libraryPath,scope,kind,revision,anchorId,position,reset = false} = payload;
      if (typeof scope !== 'string' || !/^(root|all|unfiled|untagged|folder:.+|smart:.+)$/.test(scope) || scope.length > 300 || !['folders','items'].includes(kind)) throw new Error('此视图不支持手动排序');
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('缺少排序版本');
      const libraryKey = this.libraryKey(libraryPath), key = orderKey(scope, kind);
      const state = structuredClone(this.data);
      const orders = state.libraries[libraryKey] ||= {};
      const current = orders[key] || {ids:[], revision:0};
      if (current.revision !== revision) return {conflict:true, orders:structuredClone(orders)};
      let next = [];
      if (!reset) {
        const known = uniqueIds(payload.knownIds), selected = new Set(uniqueIds(payload.ids));
        const knownSet = new Set(known);
        if (!selected.size || !validId(anchorId) || !['before','after'].includes(position) || selected.has(anchorId) || !knownSet.has(anchorId) || [...selected].some(id => !knownSet.has(id))) throw new Error('排序目标已失效，请重新拖动');
        // Merge, never replace: filtered or partially visible lists must not
        // erase the position of unseen IDs. New arrivals append stably.
        const merged = [...new Set([...current.ids, ...known])];
        if (payload.rebase === true) {
          // Starting a drag from a named/date sort uses the visible order as
          // its baseline. Keep unseen IDs in their existing slots.
          let index=0;
          for (let i=0;i<merged.length;i++) if (knownSet.has(merged[i])) merged[i]=known[index++];
        }
        const block = merged.filter(id => selected.has(id));
        next = merged.filter(id => !selected.has(id));
        const at = next.indexOf(anchorId) + (position === 'after' ? 1 : 0);
        next = [...next.slice(0,at), ...block, ...next.slice(at)];
        if (next.length > MAX_IDS) throw new Error('排序数量超过上限');
      }
      const order = {ids:next, revision:current.revision + 1};
      orders[key] = order;
      await fs.mkdir(path.dirname(this.file), {recursive:true});
      const temporary = `${this.file}.${process.pid}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(state), {encoding:'utf8',mode:0o600});
        await fs.rename(temporary, this.file);
      } finally { await fs.rm(temporary, {force:true}).catch(() => {}); }
      this.data = state;
      return {ok:true, order:structuredClone(order), orders:structuredClone(orders)};
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
module.exports = { ManualOrderStore, orderKey };
