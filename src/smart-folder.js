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

  // folderScope: the folders the view's query covers (a search inside a
  // folder reaches its whole subtree), so the saved folder matches the view.
  function buildSmartFolderConditions(view = { kind: 'all' }, query = {}, baseConditions = [], { folderScope = null } = {}) {
    if (['recent', 'random', 'trash', 'tags'].includes(view.kind)) {
      return { conditions: [], unsupported: '当前特殊视图不能等价保存为 Eagle 智能文件夹' };
    }
    // Every active filter must have a verified conversion. New query fields
    // default to rejection rather than silently widening a saved folder.
    const supported = new Set(['search', 'tags', 'folderInclude', 'ext', 'rating', 'annotation', 'url', 'shape']);
    const normalized = querySpec.createQuery(query);
    const labels = {
      color: '颜色', size: '文件大小', added: '添加日期', modified: '修改日期', duration: '时长',
      comments: '标注', pixels: '像素范围', searchScope: '限定搜索字段', folderInclude: '文件夹', ext: '格式'
    };
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
    // Match what the view shows (S-05). Eagle's folders `intersection` needs
    // every listed folder and `union` any of them, so a searched subtree is a
    // union; and a search at the root covers the whole library, not 未分类.
    const subtree = search && view.kind === 'folder' && folderScope?.length > 1 ? [...folderScope] : null;
    if (subtree) rules.push({ property: 'folders', method: 'union', value: subtree });
    else if (view.kind === 'folder' && view.id) rules.push({ property: 'folders', method: 'intersection', value: [view.id] });
    if (view.kind === 'unfiled' || (view.kind === 'root' && !search)) rules.push({ property: 'folders', method: 'empty' });
    if (view.kind === 'untagged') rules.push({ property: 'tags', method: 'empty' });
    const extra = [];
    const tagRules = setRules('tags', normalized.tags, normalized.tagsExclude, normalized.tagLogic, normalized.noTags ? { property: 'tags', method: 'empty' } : null);
    const folderRules = folderSetRules(normalized);
    for (const group of [tagRules, folderRules]) {
      if (!group) continue;
      if (group.unsupported) return { conditions: [], unsupported: `以下条件暂不支持无损保存：${labels[group.unsupported]}` };
      if (group.any) extra.push({ match: 'OR', boolean: 'TRUE', rules: group.any });
      else rules.push(...group.all);
    }
    // Eagle has no "is not this format" rule we have verified.
    if (normalized.extExclude.length) return { conditions: [], unsupported: `以下条件暂不支持无损保存：${labels.ext}（排除）` };
    if (normalized.ext.length === 1) rules.push({ property: 'type', method: 'equal', value: normalized.ext[0] });
    else if (normalized.ext.length > 1) extra.push({ match: 'OR', boolean: 'TRUE', rules: normalized.ext.map(ext => ({ property: 'type', method: 'equal', value: ext })) });
    if (Number.isInteger(query.rating)) rules.push({ property: 'rating', method: 'equal', value: query.rating === 0 ? 'none' : String(query.rating) });
    if (query.annotation?.trim()) rules.push({ property: 'annotation', method: 'contain', value: query.annotation.trim() });
    if (query.url?.trim()) rules.push({ property: 'url', method: 'contain', value: query.url.trim() });
    if (query.shape) rules.push({ property: 'shape', method: 'equal', value: query.shape });
    if (rules.length) conditions.push({ match: 'AND', boolean: 'TRUE', rules });
    conditions.push(...extra);
    if (!conditions.length) return { conditions: [], unsupported: '当前视图没有可保存的筛选条件' };
    return { conditions, unsupported: null };
  }

  // Eagle's tag/folder rule methods (rule-match.js): intersection = all of,
  // union = any of, equal = exactly, identity = none of. The panel's 全部 and
  // 完全相同 are plain AND rules; 任意 with exclusions or 未标签 is Eagle's
  // union of options, which only an OR condition of its own can hold.
  function setRules(property, includes, excludes, logic, emptyRule) {
    const all = [];
    if (logic === 'OR' && (includes.length > 1 || ((excludes.length || emptyRule) && (includes.length || excludes.length)))) {
      const any = [];
      if (includes.length) any.push({ property, method: 'union', value: [...includes] });
      if (excludes.length) any.push({ property, method: 'identity', value: [...excludes] });
      if (emptyRule) any.push(emptyRule);
      return { any };
    }
    if (includes.length) all.push({ property, method: logic === 'EQUAL' ? 'equal' : 'intersection', value: [...includes] });
    if (excludes.length) all.push({ property, method: 'identity', value: [...excludes] });
    if (emptyRule) all.push(emptyRule);
    return all.length ? { all } : null;
  }

  function folderSetRules(query) {
    const none = querySpec.NO_FOLDER;
    const includes = query.folderInclude.filter(id => id !== none);
    const excludes = query.folderExclude.filter(id => id !== none);
    const includeUnfiled = query.folderInclude.includes(none);
    const excludeUnfiled = query.folderExclude.includes(none);
    if (!includes.length && !excludes.length && !includeUnfiled && !excludeUnfiled) return null;
    if (query.folderLogic === 'OR') {
      // "None of the excluded" with 未分类 among them needs an AND inside the OR.
      if (excludeUnfiled && (excludes.length || includes.length || includeUnfiled)) return { unsupported: 'folderInclude' };
      if (excludeUnfiled) return { all: [{ property: 'folders', method: 'not-empty' }] };
      return setRules('folders', includes, excludes, 'OR', includeUnfiled ? { property: 'folders', method: 'empty' } : null);
    }
    const group = setRules('folders', includes, excludes, query.folderLogic, includeUnfiled ? { property: 'folders', method: 'empty' } : null) || { all: [] };
    if (excludeUnfiled) group.all.push({ property: 'folders', method: 'not-empty' });
    return group;
  }

  return { buildSmartFolderConditions, cloneConditions };
});
