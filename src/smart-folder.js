'use strict';

(function exposeSmartFolder(root, factory) {
  const querySpec = typeof module === 'object' && module.exports ? require('./query-spec') : root.EagleMVQuerySpec;
  const api = factory(querySpec);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVSmartFolder = api;
})(typeof window !== 'undefined' ? window : globalThis, querySpec => {
  function cloneConditions(conditions) {
    return (conditions || []).map(condition => ({
      ...condition,
      rules: (condition.rules || []).map(rule => ({ ...rule, value: Array.isArray(rule.value) ? [...rule.value] : rule.value }))
    }));
  }

  function buildSmartFolderConditions(view = { kind: 'all' }, query = {}, baseConditions = []) {
    if (['recent', 'random', 'trash', 'tags'].includes(view.kind)) {
      return { conditions: [], unsupported: '当前特殊视图不能等价保存为 Eagle 智能文件夹' };
    }
    // Every active filter must have a verified conversion. New query fields
    // default to rejection rather than silently widening a saved folder.
    const supported = new Set(['search', 'tags', 'ext', 'rating', 'annotation', 'url', 'shape']);
    const normalized = querySpec.createQuery(query);
    const labels = { color: '颜色', size: '文件大小', added: '添加日期', pixels: '像素范围', searchScope: '限定搜索字段' };
    const unsupported = querySpec.spec.filter(field => (field.filter || field.key === 'searchScope') && field.isActive(normalized[field.key], normalized) && !supported.has(field.key));
    if (unsupported.length) return { conditions: [], unsupported: `以下条件暂不支持无损保存：${unsupported.map(field => labels[field.key] || field.key).join('、')}` };
    const conditions = cloneConditions(baseConditions);
    const search = String(query.search || '').trim();
    if (search) {
      if (/\bOR\b|[()]|(^|\s)-\S/i.test(search)) {
        return { conditions: [], unsupported: '高级搜索语法无法无损转换为智能文件夹条件' };
      }
      for (const word of search.split(/\s+/).filter(Boolean)) {
        conditions.push({
          match: 'OR',
          boolean: 'TRUE',
          rules: [
            { property: 'name', method: 'contain', value: word },
            { property: 'annotation', method: 'contain', value: word },
            { property: 'url', method: 'contain', value: word },
            { property: 'comments', method: 'contain', value: word },
            { property: 'folderName', method: 'contain', value: word },
            { property: 'tags', method: 'union', value: [word] }
          ]
        });
      }
    }

    const rules = [];
    if (view.kind === 'folder' && view.id) rules.push({ property: 'folders', method: 'intersection', value: [view.id] });
    if (view.kind === 'root' || view.kind === 'unfiled') rules.push({ property: 'folders', method: 'empty' });
    if (view.kind === 'untagged') rules.push({ property: 'tags', method: 'empty' });
    if (query.tags?.length) rules.push({ property: 'tags', method: 'intersection', value: [...query.tags] });
    if (query.ext) rules.push({ property: 'type', method: 'equal', value: String(query.ext).toLowerCase() });
    if (Number.isInteger(query.rating)) rules.push({ property: 'rating', method: 'equal', value: query.rating === 0 ? 'none' : String(query.rating) });
    if (query.annotation?.trim()) rules.push({ property: 'annotation', method: 'contain', value: query.annotation.trim() });
    if (query.url?.trim()) rules.push({ property: 'url', method: 'contain', value: query.url.trim() });
    if (query.shape) rules.push({ property: 'shape', method: 'equal', value: query.shape });
    if (rules.length) conditions.push({ match: 'AND', boolean: 'TRUE', rules });
    if (!conditions.length) return { conditions: [], unsupported: '当前视图没有可保存的筛选条件' };
    return { conditions, unsupported: null };
  }

  return { buildSmartFolderConditions, cloneConditions };
});
