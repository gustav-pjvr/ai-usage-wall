/**
 * Work mode in the real renderer (docs/work-mode.md), called from
 * test/render-fit.cjs, which owns the Electron app, the sizes and `ok`.
 *
 *   - The Work view fits at every size in the list, with long task names and
 *     30+ cards per column: the columns scroll, nothing overflows the window,
 *     a column or a card.
 *   - Every action shows a pending state, then monday's answer; a failure
 *     (a read-back that did not match) leaves the card where it was.
 *   - Text boxes borrow keyboard focus and say so when they cannot.
 *   - Monday text stays text. Wheel and drag scroll a column.
 *   - The Connect dialog and the toast's work notice fit and behave.
 *
 * Nothing here talks to monday: the main process is these handlers.
 */

const { BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

/** Set CSW_SHOTS to a directory to also write a PNG of the Work view per size. */
const SHOTS = process.env.CSW_SHOTS || '';

const G = '119615221';
const J = '119615219';
const DAY = 86_400_000;
const LONG = 'Second round of homepage copy changes for the lodge booking site, with a name long enough to wrap over several lines ';
const UNBROKEN = 'Unbroken_' + 'x'.repeat(150);
const XSS = '<img src=x onerror="window.__pwned=1"> stays text';
const FAKE_TOKEN = 'render-test-token-never-shown-0c41';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 40, 40, 42 and 40 cards, so even Mine has 30+ per column: every column has to scroll at every size. */
function fixture(now = Date.now()) {
  const at = new Date(now).toISOString();
  const day = (n) => new Date(now + n * DAY).toISOString().slice(0, 10);
  const mk = (i, status) => ({
    id: String(1000 + i),
    name: i === 3 ? XSS : i % 7 === 0 ? `${LONG}${i}` : i % 11 === 0 ? UNBROKEN : `Task number ${i}`,
    group: 'topics',
    status,
    priority: ['High', 'Medium', 'Low', null][i % 4],
    due: i % 3 === 0 ? day(-2) : i % 3 === 1 ? day(3) : null,
    ownerIds: i % 5 === 0 ? [J] : i % 9 === 0 ? [G, J] : [G],
    assignedByIds: i % 6 === 0 ? [J] : [G],
    project: i % 4 === 0 ? 'A very long project name that must never push a card wider than its own column' : 'Lodge',
    updatedAt: new Date(now - (i % 6) * DAY).toISOString(),
  });
  let n = 0;
  const many = (count, status) => Array.from({ length: count }, () => mk(n++, status));
  const columns = {
    inProgress: many(40, 'In progress'),
    waiting: many(40, 'Waiting'),
    backlog: many(42, 'Not started'),
    done: many(40, 'Done'),
  };
  return { status: { connected: true, syncing: false, syncedAt: at, problem: null }, tasks: { at, columns, counts: {} } };
}

/** The main process for Work, as src/main/work/index.ts answers, with scripted results. */
function harness() {
  const h = {
    payload: null, delay: 450, fail: null, refuse: false,
    calls: { action: [], create: [], open: [], focus: [], connect: 0, toast: [], submit: [], close: 0 },
  };
  const find = (id) => Object.values(h.payload?.tasks?.columns ?? {}).flat().find((c) => c.id === id);
  ipcMain.handle('work:get', () => h.payload);
  ipcMain.handle('work:action', async (_e, id, action) => {
    h.calls.action.push([id, action]);
    await wait(h.delay);
    if (h.fail) return { ok: false, message: h.fail };
    const card = { ...find(id) };
    if (action.kind === 'status') card.status = action.value;
    if (action.kind === 'priority') card.priority = action.value;
    if (action.kind === 'due') card.due = action.value;
    return { ok: true, card };
  });
  ipcMain.handle('work:create', async (_e, input) => {
    h.calls.create.push(input);
    await wait(h.delay);
    return { ok: true, card: { id: '9999', name: input.name, group: 'group_mm86nn5y', status: 'Not started', priority: input.priority ?? null, due: input.due ?? null, ownerIds: [G], assignedByIds: [G], project: null, updatedAt: new Date().toISOString() } };
  });
  ipcMain.handle('work:open', (_e, id) => {
    h.calls.open.push(id);
    return true;
  });
  ipcMain.handle('work:focus', (e, active) => {
    h.calls.focus.push(active);
    const w = BrowserWindow.fromWebContents(e.sender);
    if (active && h.refuse) return false;
    if (active) {
      w.setFocusable(true);
      w.focus();
      return w.isFocused();
    }
    w.setFocusable(false);
    return false;
  });
  ipcMain.handle('work:connect', () => {
    h.calls.connect++;
  });
  ipcMain.handle('toast:workAction', async (_e, id, action) => {
    h.calls.toast.push([id, action]);
    await wait(h.delay);
    return action === 'done' ? { ok: true, message: 'Marked done.' } : { ok: true, message: '' };
  });
  ipcMain.handle('connect:submit', async (_e, token) => {
    h.calls.submit.push(token);
    await wait(h.delay);
    return h.calls.submit.length === 1
      ? { ok: false, message: 'monday did not accept that token. Copy it again and paste it here.' }
      : { ok: true, message: 'Connected.' };
  });
  ipcMain.handle('connect:close', () => {
    h.calls.close++;
  });
  return h;
}

/** Runs INSIDE the page: what escapes where. Findings, not assertions. */
const PROBE = `(() => {
  const f = [];
  const W = innerWidth, H = innerHeight;
  const r = (e) => e.getBoundingClientRect();
  const out = (a, b, label) => {
    if (a.left < b.left - 0.5 || a.right > b.right + 0.5) f.push(label + ' escapes horizontally (' + Math.round(a.left) + '..' + Math.round(a.right) + ' in ' + Math.round(b.left) + '..' + Math.round(b.right) + ')');
    if (a.top < b.top - 0.5 || a.bottom > b.bottom + 0.5) f.push(label + ' escapes vertically (' + Math.round(a.top) + '..' + Math.round(a.bottom) + ' in ' + Math.round(b.top) + '..' + Math.round(b.bottom) + ')');
  };
  const win = { left: 0, top: 0, right: W, bottom: H };
  const work = document.querySelector('#view-work .work');
  if (!work || !document.querySelector('#view-work').classList.contains('is-active')) return { fatal: 'Work view not active' };
  out(r(work), win, 'work view');
  if (work.scrollWidth > work.clientWidth + 1 || work.scrollHeight > work.clientHeight + 1) f.push('work view overflows ' + work.scrollWidth + 'x' + work.scrollHeight + ' in ' + work.clientWidth + 'x' + work.clientHeight);
  const strip = work.querySelector('.work-strip');
  out(r(strip), win, 'summary strip');
  if (strip.scrollWidth > strip.clientWidth + 1 || strip.scrollHeight > strip.clientHeight + 1) f.push('summary strip overflows');
  for (const s of strip.querySelectorAll('.work-stat')) out(r(s), r(strip), 'stat ' + s.textContent);
  const top = Math.max(r(document.querySelector('#mode-switch')).bottom, r(document.querySelector('#wall-actions')).bottom);
  if (r(strip).top < top - 0.5) f.push('summary strip under the top controls (' + r(strip).top + ' < ' + top + ')');
  const cols = [...work.querySelectorAll('.work-col')];
  const scrolls = [];
  for (const c of cols) {
    const name = c.dataset.col;
    out(r(c), r(work.querySelector('.work-cols')), name + ' column');
    out(r(c), win, name + ' column');
    if (c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1) f.push(name + ' column overflows its panel');
    const head = c.querySelector('.work-col-head');
    out(r(head), r(c), name + ' header');
    const list = c.querySelector('.work-list');
    if (list.scrollWidth > list.clientWidth + 1) f.push(name + ' list scrolls sideways');
    if (list.clientHeight < 60) f.push(name + ' list has only ' + list.clientHeight + 'px');
    scrolls.push(list.scrollHeight > list.clientHeight + 10);
    const lr = r(list);
    for (const t of [...list.querySelectorAll('.task')].slice(0, 14)) {
      const tr = r(t);
      if (tr.left < lr.left - 0.5 || tr.right > lr.right + 0.5) f.push(name + ' card ' + t.dataset.id + ' wider than its column');
      // Against the card's CONTENT box: text running into the padding is an overflow too.
      const cs = getComputedStyle(t);
      const inner = { left: tr.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), right: tr.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) };
      for (const k of t.querySelectorAll('*')) {
        const kr = r(k);
        if (kr.width === 0) continue;
        if (kr.left < inner.left - 0.5 || kr.right > inner.right + 0.5) { f.push(name + ' card ' + t.dataset.id + ': ' + k.className + ' escapes the card (' + Math.round(kr.right) + ' > ' + Math.round(inner.right) + ')'); break; }
      }
      // A text line wider than its own box (an unbroken word) is clipped or spills: measure the text itself.
      const nm = t.querySelector('.task-name');
      if (nm && nm.scrollWidth > nm.clientWidth + 1) f.push(name + ' card ' + t.dataset.id + ': the name is ' + (nm.scrollWidth - nm.clientWidth) + 'px wider than its box');
    }
  }
  const status = work.querySelector('.work-status');
  out(r(status), win, 'status strip');
  if (status.scrollWidth > status.clientWidth + 1) f.push('status strip overflows sideways');
  return { f, W, H, scrolls, cards: [...work.querySelectorAll('.task:not(.task-skeleton)')].length };
})()`;

module.exports = async function workChecks({ ok, SIZES, RENDERER, PRELOAD, saved, setState, h }) {
  console.log('\nWork mode\n');
  setState({ mode: 'work', work: true });
  h.payload = fixture();
  const win = new BrowserWindow({
    width: 1920, height: 1080, useContentSize: true, show: true, frame: false, focusable: false, type: 'toolbar', opacity: 0.02, skipTaskbar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadFile(RENDERER);
  await wait(1800);
  const js = (code) => win.webContents.executeJavaScript(code);
  const pointOf = async (sel) => js(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 14)) };
  })()`);
  /** Scroll the element's column so it is on screen, as a person would before clicking it. */
  const reveal = (sel) => js(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    const l = e && e.closest('.work-list');
    if (!l) return;
    const t = e.closest('.task') || e;
    const er = e.getBoundingClientRect(), lr = l.getBoundingClientRect();
    if (er.top < lr.top || er.bottom > lr.bottom) l.scrollTop = Math.max(0, t.offsetTop - 12);
  })()`);
  const click = async (sel, settle = 220) => {
    await reveal(sel);
    const p = await pointOf(sel);
    if (p) {
      win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    }
    await wait(settle);
    return p;
  };

  const base = await js(`(() => ({
    mode: document.body.dataset.mode,
    work: document.querySelector('#view-work').classList.contains('is-active'),
    stats: document.querySelector('#view-stats').classList.contains('is-active'),
    buttons: [...document.querySelectorAll('#mode-switch .mode-btn')].map((b) => b.textContent + (b.classList.contains('is-on') ? '*' : '')),
    switchShown: !document.querySelector('#mode-switch').hidden && getComputedStyle(document.querySelector('#mode-switch')).display !== 'none',
    chips: [...document.querySelectorAll('#wall-actions > *')].filter((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0).map((e) => e.className.split(' ')[0] + ':' + e.textContent.trim()),
  }))()`);
  ok('Work is on: the switch reads Claude Stats | Work with Work on, the stats view is off',
    base.mode === 'work' && base.work && !base.stats && base.switchShown && JSON.stringify(base.buttons) === JSON.stringify(['Claude Stats', 'Work*']), JSON.stringify(base));
  ok('the action row shows Mine | Everyone, + Task and Ask, and none of the stats buttons',
    base.chips.some((c) => c.startsWith('wall-seg:MineEveryone')) && base.chips.some((c) => c === 'wall-action:+ Task') && base.chips.some((c) => c === 'wall-action:Ask') &&
    !base.chips.some((c) => /Today|Any day|Milestones|Simple|Codex/.test(c)), JSON.stringify(base.chips));

  // Open one card in the narrowest content (Done), so its controls are measured at every size too.
  await click('#view-work [data-col="done"] .task');
  for (const size of SIZES) {
    win.setContentSize(size.w, size.h);
    await wait(650);
    const g = await js(PROBE);
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, `work-${size.w}x${size.h}.png`), (await win.webContents.capturePage()).toPNG());
    if (g.fatal) {
      ok(`${size.label}   Work view`, false, g.fatal);
      continue;
    }
    ok(`${size.label}   Work view ${g.W}x${g.H}: nothing escapes the window, a column or a card; all four columns scroll (${g.cards} cards)`,
      g.W === size.w && g.f.length === 0 && g.scrolls.every(Boolean) && g.cards >= 120, g.f.slice(0, 6).join('; ') || JSON.stringify(g.scrolls));
  }
  win.setContentSize(1920, 1080);
  await wait(650);

  const text = await js(`(() => ({
    pwned: !!window.__pwned,
    imgs: document.querySelectorAll('#view-work img').length,
    literal: [...document.querySelectorAll('#view-work .task-name')].some((e) => e.textContent === ${JSON.stringify(XSS)}),
    token: document.body.innerText.includes(${JSON.stringify(FAKE_TOKEN)}),
  }))()`);
  ok('monday text is text: markup in a task name stays literal, no element and no script', !text.pwned && text.imgs === 0 && text.literal, JSON.stringify(text));

  // Mine and Everyone.
  const counts = async () => js(`(() => ({
    strip: [...document.querySelectorAll('#view-work .work-stat')].map((s) => s.querySelector('.work-stat-n').textContent),
    cols: [...document.querySelectorAll('#view-work .work-col')].map((c) => c.querySelector('.work-count').textContent + '/' + c.querySelectorAll('.task').length),
  }))()`);
  const mine = await counts();
  const mineIn = h.payload.tasks.columns.inProgress.filter((c) => c.ownerIds.includes(G)).length;
  ok(`Mine (the default) counts only Gustav's tasks: In progress ${mine.strip[0]} of 40, each column count matches its cards`,
    mine.strip[0] === String(mineIn) && mine.cols.every((c) => c.split('/')[0] === c.split('/')[1]), JSON.stringify(mine));
  const savesBefore = saved.length;
  await click('#wall-actions .work-filter [data-filter="everyone"]');
  const every = await counts();
  ok('Everyone shows all 40 in progress and is saved as a setting', every.strip[0] === '40' && saved.slice(savesBefore).some((p) => p && p.workFilter === 'everyone'), JSON.stringify(every.strip));

  // A move: pending, then monday's answer, then the card moves.
  const firstIn = h.payload.tasks.columns.inProgress[0].id;
  await click(`#view-work .task[data-id="${firstIn}"]`);
  await click(`#view-work .task[data-id="${firstIn}"] .task-acts .wbtn-pri`, 120);
  const pending = await js(`(() => {
    const t = document.querySelector('#view-work .task[data-id="${firstIn}"]');
    return { pending: t.hasAttribute('data-pending'), busy: t.getAttribute('aria-busy'), msg: (t.querySelector('.task-msg') || {}).textContent || '', spin: !!t.querySelector('.task-spin'), col: t.closest('.work-col').dataset.col, disabled: [...t.querySelectorAll('.task-acts .wbtn')].every((b) => b.disabled || b.textContent === 'Open in monday') };
  })()`);
  ok('a move shows its pending state: aria-busy, a spinner, "Marking done...", buttons disabled, the card still in place',
    pending.pending && pending.busy === 'true' && pending.msg === 'Marking done...' && pending.spin && pending.col === 'inProgress' && pending.disabled, JSON.stringify(pending));
  await wait(h.delay + 300);
  const moved = await js(`(() => {
    const t = document.querySelector('#view-work .task[data-id="${firstIn}"]');
    return t ? { col: t.closest('.work-col').dataset.col, msg: (t.querySelector('.task-msg') || {}).textContent, tone: (t.querySelector('.task-msg') || { className: '' }).className } : null;
  })()`);
  ok('after monday confirms, the card is in Done and says "Marked done"', !!moved && moved.col === 'done' && moved.msg === 'Marked done' && /tone-ok/.test(moved.tone), JSON.stringify(moved));
  ok('the action sent was status Done for that task', JSON.stringify(h.calls.action.at(-1)) === JSON.stringify([firstIn, { kind: 'status', value: 'Done' }]), JSON.stringify(h.calls.action.at(-1)));

  // A failure (a read-back that did not match): the card stays, and says why.
  h.fail = 'monday did not confirm the change. It may not have been made.';
  const firstWait = h.payload.tasks.columns.waiting[0].id;
  await click(`#view-work .task[data-id="${firstWait}"]`);
  const backlogBtn = await js(`(() => { const b = [...document.querySelectorAll('#view-work .task[data-id="${firstWait}"] .task-acts .wbtn')].find((x) => x.textContent === 'Backlog'); if (!b) return null; b.dataset.probe = 'backlog'; return true; })()`);
  await click('[data-probe="backlog"]', h.delay + 300);
  const failed = await js(`(() => {
    const t = document.querySelector('#view-work .task[data-id="${firstWait}"]');
    const m = t.querySelector('.task-msg');
    return { col: t.closest('.work-col').dataset.col, msg: m ? m.textContent : '', tone: m ? m.className : '', pending: t.hasAttribute('data-pending') };
  })()`);
  ok('a failed move leaves the card in Waiting and says so in plain words',
    !!backlogBtn && failed.col === 'waiting' && /^Not changed: monday did not confirm/.test(failed.msg) && /tone-bad/.test(failed.tone) && !failed.pending, JSON.stringify(failed));
  h.fail = null;

  // Comment: borrows focus, posts on Ctrl+Enter, gives focus back.
  const focusBefore = h.calls.focus.length;
  const commentBtn = await js(`(() => { const b = [...document.querySelectorAll('#view-work .task[data-id="${firstWait}"] .task-acts .wbtn')].find((x) => x.textContent === 'Comment...'); if (!b) return null; b.dataset.probe = 'comment'; return true; })()`);
  await click('[data-probe="comment"]', 400);
  const editing = await js(`(() => {
    const i = document.querySelector('#view-work .task-edit .task-input');
    return i ? { ro: i.readOnly, active: document.activeElement === i, focus: i.closest('.task-edit').dataset.focus, tag: i.tagName } : null;
  })()`);
  ok('Comment... borrows keyboard focus and opens a live text box', !!commentBtn && !!editing && !editing.ro && editing.active && editing.focus === 'on' && editing.tag === 'TEXTAREA' && h.calls.focus.slice(focusBefore).includes(true), JSON.stringify(editing));
  await js(`(() => {
    const i = document.querySelector('#view-work .task-edit .task-input');
    i.value = 'Looks good, <b>sending</b> today';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  })()`);
  await wait(h.delay + 300);
  const posted = await js(`(() => ({ box: !!document.querySelector('#view-work .task-edit'), msg: (document.querySelector('#view-work .task[data-id="${firstWait}"] .task-msg') || {}).textContent }))()`);
  ok('Ctrl+Enter posts the comment as text, closes the box and gives focus back',
    JSON.stringify(h.calls.action.at(-1)) === JSON.stringify([firstWait, { kind: 'comment', value: 'Looks good, <b>sending</b> today' }]) && !posted.box && posted.msg === 'Comment posted' && h.calls.focus.at(-1) === false,
    JSON.stringify({ posted, last: h.calls.action.at(-1), focus: h.calls.focus.slice(focusBefore) }));

  // Focus refused: the box stays read-only and says so; Escape closes it.
  h.refuse = true;
  const dateBtn = await js(`(() => { const b = [...document.querySelectorAll('#view-work .task[data-id="${firstWait}"] .task-acts .wbtn')].find((x) => x.textContent === 'Date...'); if (!b) return null; b.dataset.probe = 'date'; return true; })()`);
  await click('[data-probe="date"]', 400);
  const refused = await js(`(() => {
    const i = document.querySelector('#view-work .task-edit .task-input');
    return i ? { ro: i.readOnly, note: i.closest('.task-edit').querySelector('.task-edit-note').textContent, type: i.type } : null;
  })()`);
  ok('when Windows refuses focus, the date box stays read-only and says so', !!dateBtn && !!refused && refused.ro && /could not take keyboard focus/.test(refused.note) && refused.type === 'date', JSON.stringify(refused));
  await js(`document.querySelector('#view-work .task-edit .task-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await wait(200);
  ok('Escape closes the box', await js(`!document.querySelector('#view-work .task-edit')`));
  h.refuse = false;

  // Open in monday goes through main, with the id only.
  const openBtn = await js(`(() => { const b = [...document.querySelectorAll('#view-work .task[data-id="${firstWait}"] .task-acts .wbtn')].find((x) => x.textContent === 'Open in monday'); if (!b) return null; b.dataset.probe = 'open'; return true; })()`);
  await click('[data-probe="open"]');
  ok('Open in monday asks main to open that task by id', !!openBtn && h.calls.open.at(-1) === firstWait, JSON.stringify(h.calls.open));

  // + Task: borrows focus, pending, then the new card in Backlog, highlighted.
  await click('#wall-actions .work-new-chip', 400);
  const form = await js(`(() => { const p = document.querySelector('#work-new'); const i = p.querySelector('.work-new-name'); const r = p.getBoundingClientRect(); return { open: p.dataset.open, ro: i.readOnly, active: document.activeElement === i, inside: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; })()`);
  ok('+ Task opens the form under the button, inside the window, with a live name box', form.open === 'on' && !form.ro && form.active && form.inside, JSON.stringify(form));
  await js(`(() => {
    const p = document.querySelector('#work-new');
    p.querySelector('.work-new-name').value = 'Call the printer about the flyers';
    [...p.querySelectorAll('.wbtn')].find((b) => b.textContent === 'High').click();
    p.querySelector('.work-new-create').click();
  })()`);
  await wait(150);
  const creating = await js(`(() => { const p = document.querySelector('#work-new'); return { busy: p.getAttribute('aria-busy'), text: p.querySelector('.work-new-create').textContent, disabled: p.querySelector('.work-new-create').disabled }; })()`);
  ok('creating shows "Creating..." with aria-busy and a disabled button', creating.busy === 'true' && creating.text === 'Creating...' && creating.disabled, JSON.stringify(creating));
  await wait(h.delay + 300);
  const created = await js(`(() => { const t = document.querySelector('#view-work .task[data-id="9999"]'); return { open: document.querySelector('#work-new').dataset.open, col: t && t.closest('.work-col').dataset.col, hl: t && t.classList.contains('is-highlight') }; })()`);
  ok('the new task lands in Backlog, highlighted, and the form closes', created.open === 'off' && created.col === 'backlog' && created.hl && JSON.stringify(h.calls.create.at(-1)) === JSON.stringify({ name: 'Call the printer about the flyers', priority: 'High' }), JSON.stringify({ created, sent: h.calls.create.at(-1) }));

  // A notice's Show: the highlight finds a card far down a column and scrolls it into view.
  const deep = h.payload.tasks.columns.backlog[30].id;
  win.webContents.send('work:highlight', deep);
  await wait(400);
  const hl = await js(`(() => {
    const t = document.querySelector('#view-work .task[data-id="${deep}"]');
    if (!t) return null;
    const l = t.closest('.work-list').getBoundingClientRect(), r = t.getBoundingClientRect();
    return { hl: t.classList.contains('is-highlight'), visible: r.top >= l.top - 1 && r.bottom <= l.bottom + 1, open: t.classList.contains('is-open') };
  })()`);
  ok('a notice\'s Show highlights the task and scrolls its column to it', !!hl && hl.hl && hl.visible && hl.open, JSON.stringify(hl));

  // Wheel and drag scroll a column.
  const listPoint = async (col) => js(`(() => { const l = document.querySelector('#view-work [data-col="${col}"] .work-list'); const r = l.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: l.scrollTop }; })()`);
  const scrollTop = (col) => js(`document.querySelector('#view-work [data-col="${col}"] .work-list').scrollTop`);
  let p = await listPoint('inProgress');
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: -240 });
  await wait(500);
  const wheeled = await scrollTop('inProgress');
  ok('the wheel scrolls a column', wheeled > p.top, `${p.top} -> ${wheeled}`);
  const openBefore = await js(`document.querySelectorAll('#view-work .task.is-open').length`);
  p = await listPoint('waiting');
  win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y - i * 25, button: 'left' });
    await wait(16);
  }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y - 200, button: 'left', clickCount: 1 });
  await wait(250);
  const dragged = await scrollTop('waiting');
  const openAfter = await js(`document.querySelectorAll('#view-work .task.is-open').length`);
  ok('dragging a column scrolls it, and the drag does not open a card', dragged >= p.top + 150 && openAfter === openBefore, `${p.top} -> ${dragged}, open ${openBefore} -> ${openAfter}`);

  // The status strip: synced, then a failure in plain words.
  const sync0 = await js(`document.querySelector('#view-work .work-sync').textContent`);
  ok('the status strip says when monday last synced', /^monday synced \d+s ago$/.test(sync0), sync0);
  win.webContents.send('work:update', { ...h.payload, status: { ...h.payload.status, problem: 'rate' } });
  await wait(200);
  const sync1 = await js(`(() => { const s = document.querySelector('#view-work .work-sync'); return { text: s.textContent, bad: s.classList.contains('tone-bad') }; })()`);
  ok('and a failure in plain words', /^monday rate limited, retrying in a minute, last synced/.test(sync1.text) && sync1.bad, JSON.stringify(sync1));

  // Not connected: an explanation and one button, inside the window at the smallest size.
  win.webContents.send('work:update', { status: { connected: false, syncing: false, syncedAt: null, problem: null }, tasks: null });
  await wait(250);
  for (const size of [{ w: 1280, h: 800 }, { w: 2560, h: 1440 }]) {
    win.setContentSize(size.w, size.h);
    await wait(500);
    const empty = await js(`(() => { const e = document.querySelector('#view-work .work-empty'); const r = e.getBoundingClientRect(); return { shown: !e.hidden && r.width > 0, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, text: e.querySelector('.work-empty-title').textContent, btn: (e.querySelector('button') || {}).textContent, task: document.querySelector('#wall-actions .work-new-chip').disabled }; })()`);
    ok(`${size.w}x${size.h}   not connected: "Connect monday" inside the window, + Task disabled`, empty.shown && empty.inside && empty.btn === 'Connect monday' && empty.task, JSON.stringify(empty));
  }
  win.setContentSize(1920, 1080);
  await wait(400);
  await click('#view-work .work-empty button');
  ok('Connect monday asks main to open the dialog', h.calls.connect === 1, String(h.calls.connect));

  // Just connected, first sync still running (the board was cleared above): a skeleton with a shimmer, aria-busy.
  win.webContents.send('work:update', { status: { connected: true, syncing: true, syncedAt: null, problem: null }, tasks: null });
  await wait(200);
  const sk = await js(`(() => {
    const w = document.querySelector('#view-work .work');
    const line = w.querySelector('.task-skeleton .sk-line');
    return { busy: w.getAttribute('aria-busy'), cards: w.querySelectorAll('.task-skeleton').length, hidden: w.querySelector('.task-skeleton').getAttribute('aria-hidden'), anim: line ? getComputedStyle(line).animationName : '', strip: w.querySelectorAll('.work-stat-n.is-skeleton').length };
  })()`);
  ok('loading shows a skeleton the shape of the board: aria-busy, shimmer, hidden from readers', sk.busy === 'true' && sk.cards === 12 && sk.anim === 'work-shimmer' && sk.hidden === 'true' && sk.strip === 6, JSON.stringify(sk));

  // Tab flips the views and saves the choice.
  const before = saved.length;
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))`);
  await wait(200);
  const toStats = await js(`({ mode: document.body.dataset.mode, stats: document.querySelector('#view-stats').classList.contains('is-active'), work: document.querySelector('#view-work').classList.contains('is-active') })`);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))`);
  await wait(200);
  const back = await js(`document.body.dataset.mode`);
  const modes = saved.slice(before).filter((x) => x && x.mode).map((x) => x.mode);
  ok('Tab switches to Claude Stats and back, saving each choice', toStats.mode === 'stats' && toStats.stats && !toStats.work && back === 'work' && JSON.stringify(modes) === JSON.stringify(['stats', 'work']), JSON.stringify({ toStats, back, modes }));

  win.destroy();
  setState({ mode: 'stats', work: undefined });
};

/** The Connect monday dialog: fits, hides and clears the token, shows pending and the answer. */
module.exports.connectChecks = async function connectChecks({ ok, ROOT, PRELOAD, h }) {
  console.log('\nConnect monday dialog\n');
  const page = path.join(ROOT, 'dist', 'renderer', 'connect.html');
  // The real window is 460 x 500 outside; about 444 x 461 inside on Windows.
  const win = new BrowserWindow({
    width: 444, height: 461, useContentSize: true, show: true, frame: false, opacity: 0.02, skipTaskbar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadFile(page);
  await wait(500);
  const js = (code) => win.webContents.executeJavaScript(code);
  const fit = await js(`(() => {
    const m = document.querySelector('#connect');
    const wide = [...m.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 0.5; }).map((e) => e.className);
    const i = document.querySelector('#token');
    return { scrollW: document.documentElement.scrollWidth <= innerWidth, tall: m.scrollHeight <= m.clientHeight + 1, wide, type: i.type, auto: i.autocomplete, title: document.querySelector('.title').textContent, steps: document.querySelectorAll('.steps li').length };
  })()`);
  ok('the dialog fits its window with no scrolling, a password field and the three steps', fit.scrollW && fit.tall && fit.wide.length === 0 && fit.type === 'password' && fit.auto === 'off' && fit.title === 'Connect monday' && fit.steps === 3, JSON.stringify(fit));
  await js(`(() => { document.querySelector('#token').value = ${JSON.stringify(FAKE_TOKEN)}; document.querySelector('.btn-pri').click(); })()`);
  await wait(120);
  const pending = await js(`(() => ({ value: document.querySelector('#token').value, busy: document.querySelector('form').getAttribute('aria-busy'), btn: document.querySelector('.btn-pri').textContent, disabled: document.querySelector('.btn-pri').disabled, text: document.body.innerText.includes(${JSON.stringify(FAKE_TOKEN)}) }))()`);
  ok('Connect clears the field at once and shows "Checking with monday..."', pending.value === '' && pending.busy === 'true' && pending.btn === 'Checking with monday...' && pending.disabled && !pending.text, JSON.stringify(pending));
  await wait(h.delay + 250);
  const refused = await js(`(() => ({ status: document.querySelector('.status').textContent, bad: document.querySelector('.status').classList.contains('is-bad'), value: document.querySelector('#token').value, text: document.documentElement.outerHTML.includes(${JSON.stringify(FAKE_TOKEN)}) }))()`);
  ok('a refused token says why, and the token is nowhere in the page', /did not accept/.test(refused.status) && refused.bad && refused.value === '' && !refused.text && h.calls.submit[0] === FAKE_TOKEN, JSON.stringify(refused));
  await js(`(() => { document.querySelector('#token').value = ${JSON.stringify(FAKE_TOKEN)}; document.querySelector('.btn-pri').click(); })()`);
  await wait(h.delay + 250);
  const okd = await js(`(() => ({ status: document.querySelector('.status').textContent, connectHidden: document.querySelector('.btn-pri').hidden }))()`);
  await wait(1700);
  ok('a good token says Connected and closes the dialog', /^Connected\./.test(okd.status) && okd.connectHidden && h.calls.close === 1, JSON.stringify({ okd, close: h.calls.close }));
  win.destroy();
};

/** The toast's work notice: fits 340 x 150, text only, Done pending then the answer. */
module.exports.toastChecks = async function toastChecks({ ok, ROOT, PRELOAD, h }) {
  console.log('\nWork notice (toast)\n');
  const win = new BrowserWindow({
    width: 340, height: 150, useContentSize: true, show: true, frame: false, transparent: true, focusable: false, type: 'toolbar', opacity: 0.02, skipTaskbar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadFile(path.join(ROOT, 'dist', 'renderer', 'toast.html'));
  await wait(400);
  const js = (code) => win.webContents.executeJavaScript(code);
  win.webContents.send('toast:work', { id: 7, label: 'monday · new task for you', from: 'Jaco', title: `${LONG}${LONG}<img src=x onerror="window.__pwned=1">`, count: 1, canDone: true });
  await wait(200);
  const shown = await js(`(() => {
    const b = document.querySelector('.work');
    const r = b.getBoundingClientRect();
    const escapes = [...b.querySelectorAll('*')].filter((e) => { const x = e.getBoundingClientRect(); return x.width > 0 && (x.right > r.right + 0.5 || x.bottom > r.bottom + 0.5); }).map((e) => e.className);
    return { shown: !b.hidden && r.width > 0, fits: b.scrollHeight <= b.clientHeight + 1 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5, escapes, from: b.querySelector('.work-from').textContent, imgs: b.querySelectorAll('img').length, pwned: !!window.__pwned, buttons: [...b.querySelectorAll('button')].filter((x) => !x.hidden).map((x) => x.textContent), update: document.querySelector('#toast').hidden };
  })()`);
  ok('a work notice shows the sender, the task as text, and Show / Done / Later, inside 340 x 150',
    shown.shown && shown.fits && shown.escapes.length === 0 && shown.from === 'Jaco' && shown.imgs === 0 && !shown.pwned && JSON.stringify(shown.buttons) === JSON.stringify(['Show', 'Done', 'Later']) && shown.update, JSON.stringify(shown));
  await js(`[...document.querySelectorAll('.work button')].find((b) => b.textContent === 'Done').click()`);
  await wait(120);
  const pending = await js(`(() => ({ busy: document.querySelector('.work').getAttribute('aria-busy'), text: [...document.querySelectorAll('.work button')].map((b) => b.textContent + (b.disabled ? '(off)' : '')).join(',') }))()`);
  ok('Done shows "Marking done..." with every button disabled', pending.busy === 'true' && pending.text === 'Show(off),Marking done...(off),Later(off)', JSON.stringify(pending));
  await wait(h.delay + 200);
  const doneMsg = await js(`(() => ({ msg: document.querySelector('.work-msg').textContent, ok: document.querySelector('.work-msg').classList.contains('is-ok') }))()`);
  ok('then what monday said: "Marked done on monday"', doneMsg.msg === 'Marked done on monday' && doneMsg.ok && JSON.stringify(h.calls.toast.at(-1)) === JSON.stringify([7, 'done']), JSON.stringify(doneMsg));
  win.webContents.send('toast:workEnd');
  await wait(100);
  ok('the notice goes when main ends it', await js(`document.querySelector('.work').hidden`));
  win.destroy();
};

module.exports.harness = harness;
module.exports.fixture = fixture;
