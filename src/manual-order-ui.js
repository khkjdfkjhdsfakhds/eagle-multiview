'use strict';
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVManualOrder = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const TYPE = 'application/x-eagle-multiview-manual-order';
  const FOLDER_TYPE = 'application/x-eagle-multiview-folder-node';
  const ITEM_TYPE = 'application/x-eagle-multiview-items';
  const key = (scope, kind) => JSON.stringify([scope, kind]);
  const ranks = new WeakMap();
  function rank(order, id) {
    if (!order) return Infinity;
    if (!ranks.has(order)) ranks.set(order, new Map(order.ids.map((id,index) => [id,index])));
    return ranks.get(order).get(id) ?? Infinity;
  }
  function compare(order, a, b) { return (rank(order,a) - rank(order,b)) || 0; }
  function sort(items, order) { return [...items].sort((a,b) => compare(order,a.id,b.id)); }
  function attach({context, begin, submit, notify, finish = () => {}, forward = () => {}, nativeStart = null, nativeSource = () => null}) {
    let drag = null, feedback = null, busy = false;
    const clear = () => { feedback?.removeAttribute('data-manual-drop'); feedback = null; };
    const consume = event => {
      event.preventDefault(); event.stopImmediatePropagation();
      for (const node of document.querySelectorAll('[data-folder-node-drop]')) node.removeAttribute('data-folder-node-drop');
    };
    const hasPayload = event => Array.from(event.dataTransfer?.types || []).includes(TYPE);
    const isManual = event => hasPayload(event) || Boolean(nativeSource());
    const nodeFor = event => event.target.closest?.('.item-card, [data-folder-node-id]');
    function destination(event, snapshot = false) {
      const node = nodeFor(event), ctx = node && context(node, snapshot);
      if (!ctx) return null;
      const rect = node.getBoundingClientRect();
      const vertical = node.matches('.folder-row') || node.closest('.asset-grid.list');
      const point = vertical ? (event.clientY-rect.top)/rect.height : (event.clientX-rect.left)/rect.width;
      // Folder centers retain the ordinary reparent/membership operation.
      const middle = ctx.kind === 'folders' && point > .25 && point < .75;
      return {node,ctx,middle,position:point < .5 ? 'before' : 'after',vertical};
    }
    document.addEventListener('dragstart', event => {
      const node = nodeFor(event), ctx = node && context(node, true);
      if (!ctx?.enabled || !event.dataTransfer) return;
      const native = ctx.kind === 'items' && nativeStart;
      if (busy || (!ctx.ready && !native)) { consume(event); notify('排序数据尚未就绪，请稍后重试'); return; }
      const ids = begin(node,ctx);
      if (!ids?.length) { consume(event); return; }
      drag = {...ctx, ids};
      if (native) {consume(event);nativeStart(drag);return;}
      if (ctx.kind === 'folders') finish();
      event.dataTransfer.setData(TYPE, JSON.stringify(drag));
      if (ctx.kind === 'folders') event.dataTransfer.setData(FOLDER_TYPE, JSON.stringify({id:ids[0],libraryPath:ctx.libraryPath,baseParentId:ctx.parentId}));
      else event.dataTransfer.setData(ITEM_TYPE, JSON.stringify(ids));
      event.dataTransfer.effectAllowed = 'copyMove';
      event.stopImmediatePropagation();
    }, true);
    document.addEventListener('dragover', event => {
      if (!isManual(event)) return;
      clear(); const target = destination(event);
      if (!target || target.middle) return;
      consume(event);
      const allowed = !busy && target?.ctx.enabled && target.ctx.ready && (!drag ||
        (drag.libraryPath===target.ctx.libraryPath && drag.scope===target.ctx.scope && drag.kind===target.ctx.kind && !drag.ids.includes(target.ctx.id) && drag.pinned===target.ctx.pinned));
      event.dataTransfer.dropEffect = allowed ? 'move' : 'none';
      if (allowed) {feedback=target.node; feedback.dataset.manualDrop=`${target.vertical?'vertical':'horizontal'}-${target.position}`;}
    }, true);
    document.addEventListener('drop', event => {
      if (!isManual(event)) return;
      clear(); const target = destination(event, true);
      if (!target) return;
      let source;try {source=hasPayload(event) ? JSON.parse(event.dataTransfer.getData(TYPE)) : nativeSource();} catch {drag=null;consume(event);finish();return;}
      if (!source || typeof source!=='object') {drag=null;consume(event);finish();return;}
      drag=null;
      if (target?.middle) {
        if (busy || source.libraryPath!==target.ctx.libraryPath || !Array.isArray(source.ids)) {consume(event);finish();return;}
        forward(source);return;
      }
      consume(event);
      const ctx=target?.ctx;
      if (busy || !ctx?.enabled || !ctx.ready || source.ready===false || source.mixedPinned || source.libraryPath!==ctx.libraryPath || source.scope!==ctx.scope || source.kind!==ctx.kind || source.pinned!==ctx.pinned || !Array.isArray(source.ids) || source.ids.includes(ctx.id)) {finish();return;}
      busy=true;
      // Release the OS drag session before invoking an async main-process RPC.
      finish();
      setTimeout(() => Promise.resolve().then(() => submit(source,ctx,target.position)).catch(error=>notify(error.message,6000)).finally(()=>{busy=false;}),0);
    }, true);
    document.addEventListener('dragleave', event => {if(isManual(event) && feedback && !feedback.contains(event.relatedTarget))clear();}, true);
    document.addEventListener('dragend', () => {clear();drag=null;finish();}, true);
  }
  return {TYPE,key,compare,sort,attach};
});
