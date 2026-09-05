(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async predicate => {
    for (let index = 0; index < 250; index++) {
      if (predicate()) return;
      await wait(20);
    }
    throw new Error('pane reveal condition timed out');
  };
  let checks = 0, writes = 0;
  const assert = (condition, message) => { checks++; if (!condition) throw new Error(message); };
  await until(() => state.connected && state.library && document.querySelector('.content-pane'));
  window.confirm = () => false;
  const items = Array.from({ length: 370 }, (_, index) => ({
    id: 'fixture-' + index, name: 'Fixture ' + index, ext: 'png',
    width: 1000, height: 800, tags: [], folders: ['mv-folder'], star: 0, size: 1000
  }));
  const queryCalls = [];
  const queryItems = async query => {
    queryCalls.push({ ...query });
    const filtered = query.search ? items.filter(item => item.name.includes(query.search)) : items;
    const offset = query.offset || 0, limit = query.limit || 160;
    return { data: filtered.slice(offset, offset + limit), total: filtered.length,
      nextOffset: offset + limit, hasMore: offset + limit < filtered.length };
  };
  window.eagleMV.query = queryItems;
  window.eagleMV.getItem = async id => items.find(item => item.id === id) || null;
  window.eagleMV.mediaURL = () => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#70899a"/></svg>');
  for (const action of ['mutate', 'mutateSet', 'newWindow', 'setPinned', 'importFiles']) {
    window.eagleMV[action] = async () => { writes++; throw new Error('unexpected external action: ' + action); };
  }
  const menu = document.querySelector('#contextMenu');
  const targets = () => [...menu.querySelectorAll('[data-context-action="reveal-in-pane"]')];
  const show = (data, x = 350, y = 150) => showContextMenuAt(x, y, data);
  show({ kind: 'workspace', ids: [] });
  assert(targets().length === 0, 'single pane must hide the action');
  hideContextMenu();

  for (const [layout, spec] of Object.entries(paneLayouts)) {
    renderPaneLayout(layout, { refresh: false });
    const source = state.panes.at(-1);
    activatePane(source.id);
    show({ kind: 'workspace', paneId: source.id, ids: [] });
    assert(targets().length === spec.count - 1, layout + ': wrong target count');
    assert(targets().every(row => JSON.parse(row.dataset.contextPayload).paneId !== source.id), layout + ': source offered as target');
    if (spec.count === 2) assert(menu.textContent.includes('在另一窗格显示'), 'two-pane direct label missing');
    if (spec.count > 2) assert(menu.querySelector('.pane-target-options'), 'multi-pane submenu missing');
    hideContextMenu();
  }
  renderPaneLayout('vertical2', { refresh: false });
  const source = state.panes[0], target = state.panes[1];
  activatePane(source.id);
  navigate({ kind: 'folder', id: 'mv-folder' }, { query: createQuery(), refreshView: false });
  await refresh({ paneId: source.id, minimumCount: items.length });
  await until(() => !source.loading);
  source.selected = new Set(['fixture-2', 'fixture-350']);
  const sourceBefore = JSON.stringify({ view: source.currentView, query: source.query, ids: [...source.selected] });
  withActivePane(target.id, () => navigate({ kind: 'folder', id: 'eagle-folder' }, {
    query: createQuery({ search: 'no matching result' }), refreshView: false
  }));
  // Use the real item contextmenu event. A selected item preserves multi-selection.
  const card = paneRoot(source.id).querySelector('.item-card[data-id="fixture-350"]');
  assert(card, 'source page-two item is missing');
  card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 250 }));
  assert(targets().length === 1, 'item right-click did not expose the action');
  targets()[0].click();
  await until(() => !target.loading && target.selected.has('fixture-350'));
  await wait(40);
  assert(menu.classList.contains('hidden'), 'clicked action left a menu overlay');
  assert(target.selected.size === 2, 'multi-selection was not preserved');
  assert(target.currentView.id === 'mv-folder' && !target.query.search, 'target did not replace stale path/filter');
  assert(target.previewId === null, 'reveal must select, not open preview');
  assert(queryCalls.some(query => query.offset >= 320), 'locating page-two items never fetched the later pages');
  assert(JSON.stringify({ view: source.currentView, query: source.query, ids: [...source.selected] }) === sourceBefore, 'source was modified');
  assert(state.activePaneId === target.id, 'successful reveal did not activate its target');
  const selectedBox = paneRoot(target.id).querySelector('.item-card[data-id="fixture-2"]').getBoundingClientRect();
  const scrollerBox = paneQuery(target.id, '#gridScroller').getBoundingClientRect();
  assert(selectedBox.bottom > scrollerBox.top && selectedBox.top < scrollerBox.bottom, 'revealed item was not scrolled into view');
  assert(target.history.map(readHistoryEntry).some(entry => entry.view?.id === 'eagle-folder' && entry.query?.search === 'no matching result'), 'target history lost its previous query');

  activatePane(source.id);
  source.query.search = 'Fixture 3';
  source.selectedFolderCard = 'eagle-folder';
  paneQuery(source.id, '#gridScroller').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 180 }));
  assert(state.contextMenu.kind === 'workspace', 'blank space did not open workspace menu');
  assert(state.contextMenu.paneReveal.ids.length === 0, 'blank context inherited selected assets');
  assert(state.contextMenu.paneReveal.view.id === 'mv-folder', 'blank context inherited selected folder instead of current path');
  assert(!state.contextMenu.paneReveal.query.search, 'path-only action copied source search');
  await executeContextAction('reveal-in-pane', { paneId: target.id });
  assert(target.selected.size === 0 && !target.query.search, 'blank action did not clear target selection/filter');
  assert(source.selected.size === 2 && source.query.search === 'Fixture 3', 'blank action changed source selection/search');
  hideContextMenu();

  activatePane(source.id);
  source.query = createQuery();
  show({ kind: 'folder', ids: [], folderId: 'eagle-folder', paneId: source.id });
  await executeContextAction('reveal-in-pane', { paneId: target.id });
  assert(target.currentView.id === 'eagle-folder' && source.currentView.id === 'mv-folder', 'folder card action used wrong folder or changed source');
  activatePane(source.id);
  openSidebarContextMenu(document.querySelector('[data-folder-id="mv-folder"]'), { x: 100, y: 180 });
  assert(state.contextMenu.paneReveal.view.id === 'mv-folder', 'sidebar context did not capture clicked folder');
  await executeContextAction('reveal-in-pane', { paneId: target.id });
  assert(target.currentView.id === 'mv-folder', 'sidebar folder action failed');

  activatePane(source.id);
  const beforeLocked = JSON.stringify(target.currentView);
  show({ kind: 'folder', folderId: 'locked-folder', ids: [], paneId: source.id });
  assert(await executeContextAction('reveal-in-pane', { paneId: target.id }) === false, 'encrypted folder navigation was not blocked');
  assert(JSON.stringify(target.currentView) === beforeLocked && state.activePaneId === source.id, 'encrypted block moved target or focus');
  show({ kind: 'folder', folderId: 'eagle-folder', ids: [], paneId: source.id });
  target.textSession = { dirty: true, value: 'UNSAVED' };
  target.query = createQuery({ search: 'old target filter' });
  const targetBeforeCancel = JSON.stringify({ view: target.currentView, query: target.query, history: target.history });
  assert(await executeContextAction('reveal-in-pane', { paneId: target.id }) === false, 'dirty TXT cancel did not block reveal');
  assert(target.textSession.value === 'UNSAVED', 'dirty TXT was lost');
  assert(JSON.stringify({ view: target.currentView, query: target.query, history: target.history }) === targetBeforeCancel, 'cancel changed target path/query/history');
  assert(state.activePaneId === source.id, 'cancel did not restore source activation');
  target.textSession = null;
  target.textSaving = true;
  assert(await executeContextAction('reveal-in-pane', { paneId: target.id }) === false, 'active text save should block navigation');
  target.textSaving = false;
  const snapshot = structuredClone(state.contextMenu.paneReveal);
  assert(await revealInPane({ ...snapshot, libraryPath: '/different-library' }, target.id) === false, 'stale library was accepted');
  assert(await revealInPane({ ...snapshot, layout: 'grid4' }, target.id) === false, 'stale layout was accepted');
  assert(await revealInPane(snapshot, source.id) === false, 'source accepted as target');
  assert(await revealInPane(snapshot, 'removed-pane') === false, 'missing target accepted');

  // A newer navigation wins over a delayed query from this menu action.
  let release;
  window.eagleMV.query = () => new Promise(resolve => { release = resolve; });
  const inFlight = revealInPane(snapshot, target.id);
  await until(() => Boolean(release));
  navigate({ kind: 'all' }, { refreshView: false, query: createQuery({ search: 'newer navigation' }) });
  release({ data: [], total: 0, hasMore: false });
  await inFlight;
  assert(target.currentView.kind === 'all' && target.query.search === 'newer navigation', 'late result replaced newer navigation');
  assert(target.selected.size === 0, 'late result changed selection');
  window.eagleMV.query = async () => { throw new Error('fixture connection failed'); };
  assert(await revealInPane(snapshot, target.id) === false, 'query failure must not report success');
  assert(Boolean(target.errorMessage), 'failed target lacks error feedback');
  window.eagleMV.query = queryItems;
  assert(await revealInPane(snapshot, target.id) === true && !target.errorMessage, 'retry did not recover');
  hideContextMenu();
  activatePane(source.id);
  source.selected.clear();
  navigate({ kind: 'root' }, { refreshView: false, query: createQuery() });
  show({ kind: 'workspace', ids: [], paneId: source.id });
  assert(state.contextMenu.paneReveal.ids.length === 0, 'unselected workspace must remain path-only');
  assert(await executeContextAction('reveal-in-pane', { paneId: target.id }), 'unselected root path action failed');
  assert(target.currentView.kind === 'root' && target.selected.size === 0, 'root path opened wrong target or selected old content');

  activatePane(source.id);
  show({ kind: 'folder', ids: [], folderId: 'eagle-folder', paneId: source.id });
  const focusSnapshot = structuredClone(state.contextMenu.paneReveal);
  release = null;
  window.eagleMV.query = () => new Promise(resolve => { release = resolve; });
  const slow = revealInPane(focusSnapshot, target.id);
  await until(() => Boolean(release));
  activatePane(source.id);
  release({ data: [], total: 0, hasMore: false });
  await slow;
  await wait(30);
  assert(state.activePaneId === source.id, 'async completion stole focus back from the user');
  assert(source.currentView.kind === 'root', 'async completion navigated the source');
  window.eagleMV.query = queryItems;
  hideContextMenu();
  // Consolidation must keep both menu entries, rather than resolving the
  // adjacent additions by dropping either the move or the reveal action.
  window.eagleMV.moveFolder = async () => { writes++; };
  for (const kind of ['folder', 'sidebar']) {
    show({ kind, folderId: 'mv-folder', targetFolderId: 'mv-folder', ids: [], paneId: source.id });
    assert(targets().length === 1 && menu.querySelector('[data-context-action="move-folder-node"]'), 'folder move and pane reveal must coexist');
    hideContextMenu();
  }
  // A manually ordered destination can have loaded metadata beyond its
  // rendered range. The revealed card must become visible as well as selected.
  withActivePane(target.id, () => {
    navigate({ kind: 'root' }, { refreshView: false, query: createQuery() });
    sortMemory.remember(state.library.path, descriptorKey(target.currentView), 'manual', 'auto', Date.now());
    target.sort = 'manual';
    target.manualRenderLimit = 1;
  });
  activatePane(source.id);
  const manualSnapshot = { ...capturePaneReveal({ kind: 'workspace', paneId: source.id }), ids: ['fixture-350'], loadedCount: items.length };
  assert(await revealInPane(manualSnapshot, target.id), 'manual destination reveal failed');
  await wait(40);
  assert(target.sort === 'manual' && target.selected.has('fixture-350'), 'manual order or selection was lost');
  assert(paneRoot(target.id).querySelector('.item-card[data-id="fixture-350"]'), 'manual destination selected an unrendered card');
  assert(document.activeElement?.dataset.id === 'fixture-350', 'manual destination failed to focus the revealed card');
  hideContextMenu();
  assert(writes === 0, 'pane reveal wrote to Eagle or opened an OS window');

  renderPaneLayout('leftStack', { refresh: false });
  const last = state.panes.at(-1);
  activatePane(last.id);
  show({ kind: 'workspace', ids: [], paneId: last.id }, innerWidth - 15, 170);
  await wait(40);
  const parent = menu.querySelector('.pane-target-options').parentElement.parentElement;
  parent.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
  await wait(30);
  const submenuBox = menu.querySelector('.pane-target-options').parentElement.getBoundingClientRect();
  assert(submenuBox.width > 0 && submenuBox.right <= innerWidth && submenuBox.left >= 0, 'positional submenu clips at right edge');
  assert(menu.querySelector('.pane-target-options').textContent.includes('左'), 'positional submenu labels missing');
  return { checks, writes };
})()
