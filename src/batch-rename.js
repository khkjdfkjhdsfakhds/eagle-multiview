'use strict';

// Eagle's 批量重命名 (batch-rename-modal): 格式 — `*` for the original name,
// %N… numbers, %D/%B/%M dates, %T tags, %F folders — or 替换 by text or by
// /regex/flags, then a text case, previewed row by row. The naming rules are
// pure so they can be checked without a window; the dialog is built only in
// a page.
(function exposeBatchRename(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVBatchRename = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const two = value => String(value).padStart(2, '0');

  // Eagle's numberFixedLen: zero-padded to the width, never cut shorter.
  function fixedLength(value, width) {
    return String(value).padStart(width, '0');
  }

  // Eagle formats with moment in its default (English) locale, so `ll` is
  // "Oct 19, 2026"; import dates use dashes, the file dates underscores.
  function dateFormats(date, separator) {
    const day = `${date.getFullYear()}${separator}${two(date.getMonth() + 1)}${separator}${two(date.getDate())}`;
    const hm = `${day} ${two(date.getHours())}_${two(date.getMinutes())}`;
    return {
      day,
      monthDay: `${two(date.getMonth() + 1)}${separator}${two(date.getDate())}`,
      long: `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`,
      hm,
      hms: `${hm}_${two(date.getSeconds())}`
    };
  }

  // Eagle's format(): each token is replaced once, longest spelling first.
  function formatName(item, pattern, { originName = item?.name || '', idx = 1, now = new Date(), folderNames = [] } = {}) {
    const modified = item?.mtime ? new Date(item.mtime) : (item?.modificationTime ? new Date(item.modificationTime) : now);
    const created = item?.btime ? new Date(item.btime) : (item?.modificationTime ? new Date(item.modificationTime) : now);
    const today = dateFormats(now, '-');
    const mTime = dateFormats(modified, '_');
    const bTime = dateFormats(created, '_');
    let name = String(pattern || '');
    try {
      name = name.replace(/%NNNNNNNNN+/i, fixedLength(idx, 9));
      for (let width = 8; width >= 1; width -= 1) name = name.replace(new RegExp(`%${'N'.repeat(width)}`, 'i'), fixedLength(idx, width));
      const dates = [['D', today], ['M', mTime], ['B', bTime]];
      for (const [letter, value] of dates) {
        name = name.replace(new RegExp(`%${letter}${letter}${letter}+`, 'i'), value.long);
        name = name.replace(new RegExp(`%${letter}${letter}`, 'i'), value.monthDay);
        name = name.replace(new RegExp(`%${letter}HMS`, 'i'), value.hms);
        name = name.replace(new RegExp(`%${letter}HM`, 'i'), value.hm);
        name = name.replace(new RegExp(`%${letter}`, 'i'), value.day);
      }
      name = name.replace(/\*/, () => originName);
      if (name.includes('%T')) name = name.replace(/%T/i, () => [...(item?.tags || [])].sort().join('-'));
      if (name.includes('%F')) name = name.replace(/%F/i, () => [...folderNames].sort().join('-'));
      if (!name.length) name = originName;
    } catch {
      name = originName;
    }
    return name.slice(0, 255);
  }

  // `/pattern/flags` is a regular expression; anything else is plain text.
  function parseFindPattern(text) {
    const match = String(text || '').match(/^\/(.+)\/([a-z]*)$/);
    if (!match) return null;
    try { return new RegExp(match[1], match[2]); } catch { return null; }
  }

  function replaceName(name, find, replacement) {
    const regex = parseFindPattern(find);
    return regex ? name.replace(regex, replacement) : name.split(find).join(replacement);
  }

  function applyTextCase(text, mode) {
    if (!text) return text;
    if (mode === 'uppercase') return text.toUpperCase();
    if (mode === 'lowercase') return text.toLowerCase();
    if (mode === 'capitalize') return text.replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
    return text;
  }

  // options: { method: 'format'|'replace', pattern, startAt, find, replacement, textCase, now, folderNamesOf }
  function renamed(items, options) {
    const startAt = Math.max(0, Number.parseInt(options.startAt, 10) || 0);
    return items.map((item, index) => {
      const next = options.method === 'replace'
        ? replaceName(item.name, options.find || '', options.replacement || '')
        : formatName(item, options.pattern, { originName: item.name, idx: index + startAt, now: options.now, folderNames: options.folderNamesOf?.(item) || [] });
      return { item, before: item.name, after: applyTextCase(next, options.textCase) };
    });
  }

  // The renames run one tag at a time through Eagle, while Eagle's own
  // dialog swaps every name at once: a rename whose new name another tag
  // still holds waits for that tag to move on, a name already taken merges,
  // and a closed loop goes through a temporary name.
  function planTagRenames(pairs, existingNames) {
    const names = new Set(existingNames);
    let pending = pairs.filter(pair => pair.from && pair.to && pair.from !== pair.to).map(pair => ({ ...pair }));
    const steps = [];
    const run = pair => {
      steps.push({ kind: names.has(pair.to) ? 'merge' : 'rename', from: pair.from, to: pair.to });
      names.delete(pair.from);
      names.add(pair.to);
    };
    while (pending.length) {
      const ready = pending.find(pair => !pending.some(other => other !== pair && other.from === pair.to));
      if (ready) {
        run(ready);
        pending = pending.filter(pair => pair !== ready);
        continue;
      }
      const first = pending[0];
      let temporary = `${first.from} (重命名中)`;
      for (let index = 2; names.has(temporary); index += 1) temporary = `${first.from} (重命名中 ${index})`;
      run({ from: first.from, to: temporary });
      first.from = temporary;
    }
    return steps;
  }

  const DATE_TOKENS = [
    ['导入时间', ['%D', '%DD', '%DDD', '%DHM', '%DHMS']],
    ['创建时间', ['%B', '%BB', '%BBB', '%BHM', '%BHMS']],
    ['修改时间', ['%M', '%MM', '%MMM', '%MHM', '%MHMS']]
  ];

  // Eagle's dialog keeps its method, numbering, find/replace text and case
  // from one opening to the next in a window; the name starts over.
  let lastSettings = { method: 'format', startAt: 1, find: '', replacement: '', textCase: 'none' };

  // The dialog. onRename(changes, total) is awaited; the dialog closes
  // first, the way Eagle closes before its writes run.
  function openBatchRenameDialog({ items, title = '批量重命名', initialPattern = '*', historyKey = 'eaglemv.batchRename.findHistory', storage = globalThis.localStorage, onRename }) {
    if (!items?.length || typeof document === 'undefined') return null;
    if (document.querySelector('dialog.batch-rename-dialog')) return null;
    const previousFocus = document.activeElement;
    const element = (tag, attrs = {}, text = '') => {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      if (text) node.textContent = text;
      return node;
    };
    const readHistory = () => { try { return JSON.parse(storage?.getItem(historyKey) || '[]').filter(entry => typeof entry === 'string'); } catch { return []; } };
    const settings = { ...lastSettings, pattern: initialPattern };

    const dialog = element('dialog', { class: 'feature-dialog batch-rename-dialog', 'aria-label': `${title} (${items.length})` });
    dialog.append(element('h2', {}, `${title} (${items.length})`));
    const layout = element('div', { class: 'batch-rename-layout' });
    const form = element('div', { class: 'batch-rename-form' });
    const segmented = (label, name, options) => {
      const row = element('div', { class: 'batch-rename-row' });
      row.append(element('span', { class: 'batch-rename-label' }, label));
      const group = element('div', { class: 'batch-rename-segments', role: 'radiogroup', 'aria-label': label });
      for (const [value, text, aria] of options) {
        group.append(element('button', { type: 'button', role: 'radio', 'data-rename-setting': name, 'data-value': value, 'aria-label': aria || text }, text));
      }
      row.append(group);
      return row;
    };
    const field = (label, attrs) => {
      const row = element('label', { class: 'batch-rename-row' });
      row.append(element('span', { class: 'batch-rename-label' }, label));
      const input = element('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', ...attrs });
      row.append(input);
      return { row, input };
    };
    const methodRow = segmented('命名方式', 'method', [['format', '格式'], ['replace', '替换']]);
    const name = field('名称', { maxlength: '1024', placeholder: '新的名称 - %N', 'data-rename-field': 'pattern' });
    const inserts = element('div', { class: 'batch-rename-inserts' });
    const insertButtons = [['index', '序号'], ['date', '日期'], ['tags', '标签'], ['folders', '文件夹'], ['original', '原始名']]
      .map(([kind, label]) => element('button', { type: 'button', 'data-rename-insert': kind }, label));
    inserts.append(...insertButtons);
    name.row.append(inserts);
    const start = field('编号起始于', { type: 'number', min: '0', placeholder: '1', 'data-rename-field': 'startAt' });
    const find = field('查找文本', { maxlength: '1024', placeholder: '关键字或 /regex/gi', 'data-rename-field': 'find', list: 'batchRenameFindHistory' });
    const history = element('datalist', { id: 'batchRenameFindHistory' });
    for (const entry of readHistory()) history.append(element('option', { value: entry }));
    find.row.append(history);
    const replacement = field('替换成', { maxlength: '1024', 'data-rename-field': 'replacement' });
    const caseRow = segmented('文本格式', 'textCase', [['none', '-', '不变'], ['uppercase', 'AG', '大写'], ['lowercase', 'ag', '小写'], ['capitalize', 'Ag', '首字母大写']]);
    form.append(methodRow, name.row, start.row, find.row, replacement.row, caseRow);
    const preview = element('div', { class: 'batch-rename-preview', role: 'table', 'aria-label': '预览' });
    layout.append(form, preview);
    const menu = element('div', { class: 'batch-rename-menu hidden', role: 'menu' });
    const footer = element('div', { class: 'feature-footer' });
    const cancel = element('button', { type: 'button', 'data-feature-cancel': '' }, '取消');
    const submit = element('button', { type: 'button', 'data-feature-submit': '' }, '重命名');
    footer.append(cancel, submit);
    dialog.append(layout, menu, footer);
    document.body.append(dialog);

    name.input.value = settings.pattern;
    start.input.value = String(settings.startAt);
    find.input.value = settings.find;
    replacement.input.value = settings.replacement;
    const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const marked = (text, find, tag) => {
      if (!find) return escapeHTML(text);
      const regex = parseFindPattern(find);
      if (regex) {
        // Struck through where the expression matches, with its own flags.
        let out = ''; let last = 0;
        text.replace(regex, (match, ...rest) => {
          const at = typeof rest.at(-2) === 'number' ? rest.at(-2) : rest.at(-3);
          out += escapeHTML(text.slice(last, at)) + `<${tag}>${escapeHTML(match)}</${tag}>`;
          last = at + match.length;
          return match;
        });
        return out + escapeHTML(text.slice(last));
      }
      return text.split(find).map(escapeHTML).join(`<${tag}>${escapeHTML(find)}</${tag}>`);
    };
    let previews = [];
    const tokenPresent = token => settings.pattern.toLowerCase().includes(token);
    const update = () => {
      for (const button of dialog.querySelectorAll('[data-rename-setting]')) {
        const on = settings[button.dataset.renameSetting] === button.dataset.value;
        button.setAttribute('aria-checked', String(on));
        button.classList.toggle('active', on);
      }
      const format = settings.method === 'format';
      name.row.hidden = !format;
      start.row.hidden = !(format && tokenPresent('%n'));
      find.row.hidden = format;
      replacement.row.hidden = format;
      const present = { index: tokenPresent('%n'), date: ['%d', '%m', '%b'].some(tokenPresent), tags: tokenPresent('%t'), folders: tokenPresent('%f'), original: tokenPresent('*') };
      for (const button of insertButtons) button.disabled = present[button.dataset.renameInsert];
      previews = renamed(items, { ...settings, now: new Date() });
      const header = '<div class="batch-rename-preview-row head" role="row"><span role="columnheader">原名称</span><span role="columnheader">新名称</span></div>';
      preview.innerHTML = header + previews.map(entry => `<div class="batch-rename-preview-row" role="row"><span role="cell">${format ? escapeHTML(entry.before) : marked(entry.before, settings.find, 's')}</span><span role="cell">${format || !settings.replacement ? escapeHTML(entry.after) : entry.after.split(settings.replacement).map(escapeHTML).join(`<b>${escapeHTML(settings.replacement)}</b>`)}</span></div>`).join('');
      submit.disabled = format ? !settings.pattern : !settings.find;
    };
    const focusFirst = () => requestAnimationFrame(() => {
      const target = settings.method === 'format' ? name.input : find.input;
      target.focus();
      target.select?.();
    });
    const closeMenu = () => { menu.classList.add('hidden'); menu.replaceChildren(); };
    const close = () => {
      if (!dialog.isConnected) return;
      const { pattern, ...kept } = settings;
      lastSettings = kept;
      closeMenu();
      if (dialog.open) dialog.close();
      dialog.remove();
      previousFocus?.focus?.();
    };
    const insert = token => {
      settings.pattern += token;
      name.input.value = settings.pattern;
      closeMenu();
      update();
      name.input.focus();
    };
    const openInsertMenu = button => {
      const kind = button.dataset.renameInsert;
      const first = items[0];
      const sample = token => formatName(first, settings.pattern + token, { originName: first.name, idx: Math.max(0, Number.parseInt(settings.startAt, 10) || 0), now: new Date() });
      const groups = kind === 'index' ? [['', ['%N', '%NN', '%NNN', '%NNNN']]]
        : kind === 'date' ? DATE_TOKENS
          : [['', [{ tags: '%T', folders: '%F', original: '*' }[kind]]]];
      menu.replaceChildren();
      for (const [label, tokens] of groups) {
        if (label) menu.append(element('div', { class: 'batch-rename-menu-label' }, label));
        for (const token of tokens) {
          const row = element('button', { type: 'button', role: 'menuitem', 'data-rename-token': token });
          row.append(element('span', {}, sample(token)), element('kbd', {}, token));
          menu.append(row);
        }
      }
      const box = button.getBoundingClientRect();
      const host = dialog.getBoundingClientRect();
      menu.style.left = `${box.left - host.left}px`;
      menu.style.top = `${box.bottom - host.top + 4}px`;
      menu.classList.remove('hidden');
      menu.querySelector('button')?.focus();
    };
    const doRename = async () => {
      if (submit.disabled) return;
      const chosen = previews.filter(entry => entry.after !== entry.before);
      if (settings.method === 'replace' && settings.find) {
        const next = [settings.find, ...readHistory().filter(entry => entry !== settings.find)].slice(0, 10);
        try { storage?.setItem(historyKey, JSON.stringify(next)); } catch {}
      }
      close();
      await onRename?.(chosen, previews.length);
    };

    dialog.addEventListener('click', event => {
      const setting = event.target.closest('[data-rename-setting]');
      if (setting) {
        settings[setting.dataset.renameSetting] = setting.dataset.value;
        update();
        if (setting.dataset.renameSetting === 'method') focusFirst();
        return;
      }
      const insertButton = event.target.closest('[data-rename-insert]');
      if (insertButton) { event.stopPropagation(); openInsertMenu(insertButton); return; }
      const token = event.target.closest('[data-rename-token]');
      if (token) { insert(token.dataset.renameToken); return; }
      if (!event.target.closest('.batch-rename-menu')) closeMenu();
    });
    dialog.addEventListener('input', event => {
      const key = event.target.dataset?.renameField;
      if (!key) return;
      settings[key] = key === 'startAt' ? Math.max(0, Number.parseInt(event.target.value, 10) || 0) : event.target.value;
      update();
    });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!menu.classList.contains('hidden')) closeMenu();
        else close();
        return;
      }
      // Eagle renames on ⌘Return (Ctrl on Windows) from any field.
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        doRename();
      }
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); });
    cancel.addEventListener('click', close);
    submit.addEventListener('click', doRename);
    dialog.showModal();
    update();
    focusFirst();
    return { dialog, close };
  }

  return { formatName, replaceName, applyTextCase, parseFindPattern, renamed, planTagRenames, openBatchRenameDialog };
});
