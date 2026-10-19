'use strict';

// Eagle's own per-folder item order, read from Eagle 4's renderer source:
// a folder with `orderBy` is sorted by sortData(orderBy) and reversed when its
// `sortIncrease` is not true; MANUAL compares `order[folderId]` (falling back to
// the add time) as strings, largest first. Dragging writes a value only for the
// moved items, between their new neighbours (onDropBoxItem).
(function exposeEagleOrder(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVEagleOrder = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const LABELS = {
    MANUAL: '自定义排序', NAME: '标题', IMPORT: '添加日期', CREATEDATE: '添加日期', BTIME: '创建日期',
    MTIME: '修改日期', FILESIZE: '文件大小', RESOLUTION: '尺寸', RATING: '评分', EXT: '扩展名',
    DURATION: '时长', TAGS: '标签', RANDOM: '随机模式'
  };

  function nativeValue(item, folderId) {
    const explicit = item?.order?.[folderId];
    return explicit ? String(explicit) : String(item?.modificationTime ?? '');
  }

  // The order a folder view shows under "Eagle 顺序" (the folder's own sort)
  // or "自定义顺序" (its manual order), or null when Eagle's API order holds.
  function folderOrder(folder, sort) {
    if (!folder) return null;
    if (sort === 'manual') {
      return { orderBy: 'MANUAL', increase: folder.orderBy === 'MANUAL' ? folder.sortIncrease === true : true };
    }
    if (sort !== 'default' || !folder.orderBy) return null;
    return { orderBy: String(folder.orderBy), increase: folder.sortIncrease === true };
  }

  // Eagle lets a folder be reordered by dragging only while it shows its
  // manual order or the add-time order that manual order falls back to
  // (index.html `box-sortable`).
  function dragSortable(folder, sort) {
    if (!folder) return false;
    if (sort === 'manual') return true;
    if (sort !== 'default') return false;
    return !folder.orderBy || folder.orderBy === 'MANUAL' || (folder.orderBy === 'IMPORT' && folder.sortIncrease === true);
  }

  const newestFirst = (a, b) => (Number(b?.modificationTime) || 0) - (Number(a?.modificationTime) || 0);
  const ascending = (left, right) => (left > right ? 1 : left < right ? -1 : 0);

  // null for RANDOM: the caller shuffles with its own seed.
  function comparator({ orderBy, increase }, folderId, { collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }) } = {}) {
    let base;
    switch (orderBy) {
      case 'NAME': base = (a, b) => collator.compare(String(a?.name ?? ''), String(b?.name ?? '')); break;
      case 'EXT': base = (a, b) => collator.compare(String(a?.ext ?? ''), String(b?.ext ?? '')); break;
      case 'TAGS': base = (a, b) => collator.compare(String(a?.tags?.[0] ?? ''), String(b?.tags?.[0] ?? '')); break;
      case 'RESOLUTION': base = (a, b) => ascending((a?.width || 0) * (a?.height || 0), (b?.width || 0) * (b?.height || 0)); break;
      case 'FILESIZE': base = (a, b) => ascending(parseInt(a?.size, 10) || 0, parseInt(b?.size, 10) || 0); break;
      case 'RATING': base = (a, b) => ascending(parseInt(a?.star, 10) || 0, parseInt(b?.star, 10) || 0); break;
      case 'DURATION': base = (a, b) => ascending(parseInt(a?.duration, 10) || 0, parseInt(b?.duration, 10) || 0); break;
      case 'MANUAL': base = (a, b) => -ascending(nativeValue(a, folderId), nativeValue(b, folderId)); break;
      case 'BTIME': base = (a, b) => -ascending(a?.btime || a?.modificationTime || 0, b?.btime || b?.modificationTime || 0); break;
      case 'MTIME': base = (a, b) => -ascending(a?.mtime || a?.modificationTime || 0, b?.mtime || b?.modificationTime || 0); break;
      case 'RANDOM': return null;
      default: base = () => 0;
    }
    // Ties keep Eagle's add-time order; a reversed folder reverses them too.
    return (a, b) => {
      const result = base(a, b) || newestFirst(a, b) || ascending(String(a?.id ?? ''), String(b?.id ?? ''));
      return increase ? result : -result;
    };
  }

  // Plain decimal strings (Eagle's BigNumber output) as scaled BigInts, so a
  // midpoint never loses digits the way a float would.
  const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
  function fractionDigits(value) {
    const match = DECIMAL.exec(value);
    if (!match) throw new Error('Eagle 顺序值格式异常，请在 Eagle 里刷新后重试');
    return (match[3] || '').length;
  }
  function toScaled(value, scale) {
    const [, sign, whole, fraction = ''] = DECIMAL.exec(value);
    const digits = BigInt(whole + fraction.padEnd(scale, '0'));
    return sign ? -digits : digits;
  }
  function fromScaled(scaled, scale) {
    const negative = scaled < 0n;
    const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, '0');
    const whole = digits.slice(0, digits.length - scale);
    const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
  }

  // Values for `count` moved items placed between the item above (`above`)
  // and below (`below`) them, in display order. `increase` false is a
  // reversed manual folder, where values grow down the list.
  function insertionValues({ above = null, below = null, count, increase = true }) {
    if (!(count > 0)) return [];
    if (above === null && below === null) throw new Error('没有可参照的相邻素材，无需调整顺序');
    const scale = Math.max(above === null ? 0 : fractionDigits(above), below === null ? 0 : fractionDigits(below)) + 20;
    const one = 10n ** BigInt(scale);
    const step = increase ? one : -one;
    const upper = above === null ? toScaled(below, scale) + step : toScaled(above, scale);
    const lower = below === null ? toScaled(above, scale) - step : toScaled(below, scale);
    if (increase ? upper <= lower : upper >= lower) {
      throw new Error('这两张素材在 Eagle 里的顺序值相同，无法插入其间，请换个位置');
    }
    const middle = (upper + lower) / 2n;
    const span = upper - middle;
    return Array.from({ length: count }, (_, index) => fromScaled(middle + (span * BigInt(count - 1 - index)) / BigInt(count), scale));
  }

  // The moved block's neighbours once `movedIds` sit before/after `anchorId`.
  function blockNeighbours(ids, movedIds, anchorId, position) {
    const moved = new Set(movedIds);
    if (!moved.size || moved.has(anchorId) || !ids.includes(anchorId) || [...moved].some(id => !ids.includes(id))) {
      throw new Error('排序目标已失效，请刷新后重试');
    }
    const block = ids.filter(id => moved.has(id));
    const rest = ids.filter(id => !moved.has(id));
    const at = rest.indexOf(anchorId) + (position === 'after' ? 1 : 0);
    return { block, aboveId: rest[at - 1] ?? null, belowId: rest[at] ?? null };
  }

  return { LABELS, nativeValue, folderOrder, dragSortable, comparator, insertionValues, blockNeighbours };
});
