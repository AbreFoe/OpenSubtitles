import {
  fmtTime, fmtShort, parseTime, parseSpans, plainText, parseSubs, toSRT, toYTT, cuePosition,
  FONTS, EDGES, edgeShadow, rgba, PREVIEW_EM, toASS,
} from './formats.js';
import { Timeline } from './timeline.js';

const $ = id => document.getElementById(id);
const video = $('video');

const LANGS = [
  ['ru', 'Русский'], ['en', 'Английский'], ['uk', 'Украинский'], ['be', 'Белорусский'], ['kk', 'Казахский'],
  ['de', 'Немецкий'], ['fr', 'Французский'], ['es', 'Испанский'], ['it', 'Итальянский'], ['pt', 'Португальский'],
  ['pl', 'Польский'], ['tr', 'Турецкий'], ['ja', 'Японский'], ['ko', 'Корейский'], ['zh', 'Китайский'],
];
const googleCode = c => (c === 'zh' ? 'zh-CN' : c);

const BASE_STYLE = {
  font: 4, size: 100, color: '#FFFFFF', opacity: 100, bg: '#000000', bgOpacity: 0, edge: 3, edgeColor: '#000000',
  bold: false, italic: false, underline: false, align: 2, ap: 7, ah: 50, av: 96,
};
const defaultStyles = () => ({
  main: { ...BASE_STYLE, name: 'Основной — белый с обводкой' },
  classic: { ...BASE_STYLE, name: 'Классика YouTube — плашка', edge: 0, bgOpacity: 75 },
  accent: { ...BASE_STYLE, name: 'Жёлтый акцент', color: '#FFE14D', bold: true },
  top: { ...BASE_STYLE, name: 'Надпись сверху', ap: 1, av: 4, size: 85, italic: true, edge: 4 },
});
const DEFAULT_SETTINGS = {
  field: 'text', srcLang: '', tgtLang: 'en', asrLang: '', model: 'small', glossary: '', cps: 17, line: 42, trScope: 'all',
};
const defaultProject = () => ({ version: 1, cues: [], styles: defaultStyles(), settings: { ...DEFAULT_SETTINGS } });

function normalize(p) {
  p.styles = p.styles && Object.keys(p.styles).length ? p.styles : defaultStyles();
  for (const k in p.styles) p.styles[k] = { ...BASE_STYLE, ...p.styles[k] };
  p.settings = { ...DEFAULT_SETTINGS, ...(p.settings || {}) };
  const first = Object.keys(p.styles)[0];
  p.cues = (p.cues || []).map(c => ({
    id: c.id || newId(), start: +c.start || 0, end: +c.end || 0, text: c.text || '', tr: c.tr || '',
    style: p.styles[c.style] ? c.style : first, pos: c.pos || null,
  }));
  p.cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return p;
}

// --- состояние ---------------------------------------------------------------

let media = null;
let P = defaultProject();
let selId = null;
let version = 0;
let range = null;
let stopAt = null;
let currentTab = 'cues';
let curStyle = 'main';
let problems = new Map();
let uid = 0;

// мелкие настройки интерфейса — только в этом браузере
const store = {
  get(k, d) { try { const v = localStorage.getItem('substudio.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('substudio.' + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};

function newId() { return 'c' + Date.now().toString(36) + (uid++).toString(36); }
const field = () => P.settings.field;
const otherField = () => (field() === 'text' ? 'tr' : 'text');
const cueById = id => P.cues.find(c => c.id === id);
const sel = () => cueById(selId);
const firstStyle = () => Object.keys(P.styles)[0];
const styleOf = c => P.styles[c.style] || P.styles[firstStyle()];
const sortCues = () => P.cues.sort((a, b) => a.start - b.start || a.end - b.end);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => video.currentTime || 0;

// --- сеть --------------------------------------------------------------------

async function api(url, body) {
  const opts = { headers: { 'X-Sub-Studio': '1' } };
  if (body !== undefined) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  let j = {};
  try { j = await r.json(); } catch { /* пустой ответ */ }
  if (!r.ok || j.error) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}

async function waitJob(jid, bar, onMessage) {
  bar.hidden = false;
  bar.firstElementChild.style.width = '0%';
  try {
    for (;;) {
      await new Promise(r => setTimeout(r, 600));
      const j = await api('/api/job/' + jid);
      bar.firstElementChild.style.width = j.progress + '%';
      if (j.message) onMessage(j.message, j.progress);
      if (j.status === 'done') return j.result;
      if (j.status === 'error') throw new Error(j.error);
    }
  } finally {
    bar.hidden = true;
  }
}

// --- уведомления -------------------------------------------------------------

let toastTimer = null;
function toast(msg, { err = false, action = null, ms = 4000 } = {}) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  if (action) {
    const a = document.createElement('a');
    a.textContent = action[0];
    a.onclick = () => { action[1](); t.hidden = true; };
    t.appendChild(a);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const hideToast = () => { $('toast').hidden = true; };

// --- отмена / повтор ---------------------------------------------------------

const undoStack = [], redoStack = [];
let typingKey = null, typingAt = 0;
const snap = () => JSON.stringify({ cues: P.cues, styles: P.styles });

function pushUndo(key = null) {
  const t = Date.now();
  if (key && key === typingKey && t - typingAt < 1500) { typingAt = t; return; }
  typingKey = key; typingAt = t;
  undoStack.push(snap());
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
}
function applySnap(s) {
  const o = JSON.parse(s);
  P.cues = o.cues; P.styles = o.styles;
  if (!sel()) selId = null;
  if (!P.styles[curStyle]) curStyle = firstStyle();
  renderStyles();
  changed(true);
}
function undo() {
  if (!undoStack.length) return toast('Отменять нечего');
  redoStack.push(snap()); typingKey = null;
  applySnap(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return toast('Повторять нечего');
  undoStack.push(snap()); typingKey = null;
  applySnap(redoStack.pop());
}

// --- сохранение --------------------------------------------------------------

let saveTimer = null, dirty = false, saving = false;
function scheduleSave() {
  if (!media) return;
  dirty = true;
  $('saveState').textContent = 'Изменено…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 1000);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!media || !dirty) return;
  dirty = false;
  saving = true;
  try {
    await api('/api/project', { id: media.id, project: P });
    $('saveState').textContent = 'Сохранено ✓';
  } catch (e) {
    dirty = true;
    $('saveState').textContent = 'Не сохранилось!';
    toast('Не удалось сохранить: ' + e.message, { err: true });
  } finally {
    saving = false;
  }
}
window.addEventListener('beforeunload', e => {
  if (dirty && media) { flushSave(); e.preventDefault(); e.returnValue = ''; }
});
// окно приложения (server.py) перед закрытием дописывает правки и ждёт, пока они сохранятся
window.substudioFlush = flushSave;
window.substudioDirty = () => !!media && (dirty || saving);

// --- общий «что-то поменялось» -----------------------------------------------

function changed(full = false, save = true) {
  version++;
  computeProblems();
  if (full) renderList(); else refreshAround(selId);
  renderEditor();
  tl.draw();
  renderOverlay(true);
  if (save) scheduleSave();
}

// --- проверка читаемости -----------------------------------------------------

function computeProblems() {
  problems = new Map();
  const f = field(), { cps, line } = P.settings;
  P.cues.forEach((c, i) => {
    const out = [];
    const txt = plainText(c[f]).trim(), d = c.end - c.start;
    if (!txt) out.push(f === 'tr' ? 'Нет перевода' : 'Пустая строка');
    else {
      const lines = txt.split('\n'), chars = txt.replace(/\n/g, '').length, speed = chars / Math.max(d, 0.01);
      if (speed > cps) out.push(`Слишком быстро: ${speed.toFixed(1)} симв/с (норма ≤ ${cps}) — не успеют прочитать`);
      const long = Math.max(...lines.map(l => l.length));
      if (long > line) out.push(`Длинная строка: ${long} симв. (норма ≤ ${line})`);
      if (lines.length > 2) out.push('Больше двух строк');
    }
    if (d < 0.7) out.push(`Слишком мало на экране: ${d.toFixed(2)} с`);
    if (d > 8) out.push(`Слишком долго на экране: ${d.toFixed(1)} с`);
    const n = P.cues[i + 1];
    if (n && n.start < c.end - 0.01 && n.style === c.style && !n.pos && !c.pos) out.push('Накладывается на следующую строку');
    if (out.length) problems.set(c.id, out);
  });
  $('problemCount').textContent = problems.size;
}

// --- список ------------------------------------------------------------------

const list = $('list');
const rowEl = id => list.querySelector(`.cue-row[data-id="${id}"]`);

function fillRow(row, c, i) {
  row.classList.toggle('sel', c.id === selId);
  row.innerHTML = '<span class="idx"></span><span class="tm mono"></span><div class="txt"></div><span class="warn"></span>';
  row.children[0].textContent = i + 1;
  row.children[1].innerHTML = `${fmtShort(c.start)}<br>${fmtShort(c.end)}`;
  const txt = row.children[2];
  txt.textContent = plainText(c[field()]) || '—';
  const o = plainText(c[otherField()]);
  if (o) {
    const d = document.createElement('div');
    d.className = 'other';
    d.textContent = o;
    txt.appendChild(d);
  }
  const probs = problems.get(c.id);
  if (probs) { row.children[3].textContent = '⚠'; row.children[3].title = probs.join('\n'); }
}

function renderList() {
  list.textContent = '';
  $('cueCount').textContent = P.cues.length ? `${P.cues.length} строк` : '';
  if (!P.cues.length) {
    const d = document.createElement('div');
    d.className = 'list-empty';
    d.textContent = media
      ? 'Субтитров пока нет. Выдели участок на дорожке снизу и нажми «Распознать», импортируй SRT или нажми «+ Новая».'
      : 'Открой видео, чтобы начать.';
    list.appendChild(d);
    return;
  }
  const frag = document.createDocumentFragment();
  P.cues.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'cue-row';
    row.dataset.id = c.id;
    fillRow(row, c, i);
    frag.appendChild(row);
  });
  list.appendChild(frag);
  lastPlaying = null;
}

function refreshAround(id) {
  const i = P.cues.findIndex(c => c.id === id);
  if (i < 0) return;
  for (let k = Math.max(0, i - 1); k <= Math.min(P.cues.length - 1, i + 1); k++) {
    const row = rowEl(P.cues[k].id);
    if (row) fillRow(row, P.cues[k], k);
  }
}

list.addEventListener('click', e => {
  const row = e.target.closest('.cue-row');
  if (row) select(row.dataset.id, true);
});

function select(id, seek = false) {
  selId = id;
  for (const r of list.querySelectorAll('.cue-row.sel')) r.classList.remove('sel');
  const row = rowEl(id);
  if (row) { row.classList.add('sel'); row.scrollIntoView({ block: 'nearest' }); }
  const c = sel();
  if (c && seek) seekTo(c.start);
  renderEditor();
  tl.draw();
  renderOverlay(true);
}

let lastPlaying = null;
function highlightPlaying(t) {
  const c = P.cues.find(c => c.start <= t && c.end > t);
  const id = c ? c.id : null;
  if (id === lastPlaying) return;
  if (lastPlaying) rowEl(lastPlaying)?.classList.remove('playing');
  lastPlaying = id;
  if (id) {
    const row = rowEl(id);
    row?.classList.add('playing');
    if (row && !video.paused && followOn()) row.scrollIntoView({ block: 'center' });
  }
  syncFollow();
  updateEdHead();
}

// --- карточка следует за видео -----------------------------------------------
// Во время воспроизведения карточка сама открывает строку, которая сейчас на экране, — поверх выбранной вручную.
// Пока ты печатаешь в карточке, она не переключается; Esc — выйти из поля и догнать видео.

const followOn = () => $('follow').checked;
function editorBusy() {
  const a = document.activeElement;
  return !!a && $('editor').contains(a) && a.matches('input, textarea');
}
function syncFollow() {
  if (video.paused || !followOn() || !lastPlaying || lastPlaying === selId || editorBusy() || capDrag || tl.drag) return;
  select(lastPlaying);
}
function updateEdHead() {
  const c = sel(), mode = $('edMode');
  $('edNum').textContent = c ? `Строка ${P.cues.indexOf(c) + 1} из ${P.cues.length}` : '';
  let cls = '', txt = '';
  if (c && !video.paused && followOn()) {
    if (c.id === lastPlaying) { cls = 'live'; txt = '▶ сейчас на экране'; }
    else if (editorBusy()) { cls = 'hold'; txt = '✎ правишь — карточка ждёт (Esc)'; }
  }
  mode.hidden = !txt;
  mode.textContent = txt;
  mode.className = 'badge ' + cls;
  $('editor').classList.toggle('live', cls === 'live');
}
$('follow').checked = store.get('follow', true);
$('pauseOnType').checked = store.get('pauseOnType', true);
$('follow').addEventListener('change', () => {
  store.set('follow', followOn());
  toast(followOn() ? 'Карточка следует за видео' : 'Карточка больше не переключается сама', { ms: 1800 });
  syncFollow();
  updateEdHead();
});
$('pauseOnType').addEventListener('change', () => store.set('pauseOnType', $('pauseOnType').checked));
$('editor').addEventListener('focusin', () => updateEdHead());
$('editor').addEventListener('focusout', () => setTimeout(() => { syncFollow(); updateEdHead(); }));

// --- редактор строки ---------------------------------------------------------

const ed = {
  start: $('edStart'), end: $('edEnd'), info: $('edInfo'), text: $('edText'), tr: $('edTr'),
  style: $('edStyle'), pos: $('edPos'), posReset: $('edPosReset'), posToStyle: $('edPosToStyle'),
};
let lastTa = ed.text;

function renderEditor() {
  const c = sel();
  for (const el of $('editor').querySelectorAll('input, textarea, select, button')) {
    if (el.id !== 'btnAdd') el.disabled = !c;
  }
  ed.text.classList.toggle('active', field() === 'text');
  ed.tr.classList.toggle('active', field() === 'tr');
  const focus = document.activeElement;
  if (!c) {
    for (const k of ['start', 'end', 'text', 'tr']) ed[k].value = '';
    ed.info.textContent = media ? 'Выбери строку в списке или на дорожке' : '';
    ed.pos.textContent = '';
    updateEdHead();
    return;
  }
  if (focus !== ed.start) ed.start.value = fmtTime(c.start);
  if (focus !== ed.end) ed.end.value = fmtTime(c.end);
  if (focus !== ed.text) ed.text.value = c.text;
  if (focus !== ed.tr) ed.tr.value = c.tr;
  ed.style.value = c.style;
  const d = c.end - c.start, chars = plainText(c[field()]).replace(/\n/g, '').length;
  ed.info.textContent = `${d.toFixed(2)} с · ${(chars / Math.max(d, 0.01)).toFixed(1)} симв/с`;
  const pos = cuePosition(c, styleOf(c));
  ed.pos.textContent = c.pos ? `Своя позиция: ${Math.round(pos.ah)}% × ${Math.round(pos.av)}%` : 'Позиция — как в стиле';
  ed.posReset.disabled = ed.posToStyle.disabled = !c.pos;
  updateEdHead();
}

function setTime(which, t) {
  const c = sel();
  if (!c || t == null) return renderEditor();
  pushUndo();
  c[which] = Math.max(0, t);
  if (c.end <= c.start + 0.05) {
    if (which === 'start') c.end = c.start + 1; else c.start = Math.max(0, c.end - 1);
  }
  sortCues();
  changed(true);
}
for (const k of ['start', 'end']) {
  ed[k].addEventListener('change', () => setTime(k, parseTime(ed[k].value)));
  ed[k].addEventListener('keydown', e => { if (e.key === 'Enter') ed[k].blur(); });
}
for (const k of ['text', 'tr']) {
  ed[k].addEventListener('focus', () => { lastTa = ed[k]; });
  ed[k].addEventListener('input', () => {
    const c = sel();
    if (!c) return;
    pushUndo(`txt:${c.id}:${k}`);
    c[k] = ed[k].value;
    if (!video.paused && $('pauseOnType').checked) { video.pause(); stopAt = null; }
    changed(false);
  });
}
ed.style.addEventListener('change', () => {
  const c = sel();
  if (!c) return;
  pushUndo();
  c.style = ed.style.value;
  changed(false);
});
ed.posReset.onclick = () => { const c = sel(); if (c) { pushUndo(); c.pos = null; changed(false); } };
ed.posToStyle.onclick = () => {
  const c = sel();
  if (!c?.pos) return;
  pushUndo();
  Object.assign(styleOf(c), { ap: c.pos.ap, ah: Math.round(c.pos.ah), av: Math.round(c.pos.av) });
  c.pos = null;
  curStyle = c.style;
  renderStyles();
  changed(true);
  toast('Позиция записана в стиль — все строки с этим стилем переехали туда же');
};

function wrapSelection(tag, ta = lastTa) {
  const c = sel();
  if (!c) return;
  const key = ta === ed.tr ? 'tr' : 'text';
  let a = ta.selectionStart, b = ta.selectionEnd;
  if (a === b) { a = 0; b = ta.value.length; }
  const open = tag === 'font' ? `<font color="${$('wrapColor').value.toUpperCase()}">` : `<${tag}>`;
  const close = `</${tag}>`;
  pushUndo();
  ta.value = ta.value.slice(0, a) + open + ta.value.slice(a, b) + close + ta.value.slice(b);
  c[key] = ta.value;
  ta.focus();
  ta.setSelectionRange(a + open.length, b + open.length);
  changed(false);
}
for (const btn of document.querySelectorAll('[data-wrap]')) {
  btn.addEventListener('mousedown', e => e.preventDefault()); // не забираем фокус у текста
  btn.onclick = () => wrapSelection(btn.dataset.wrap);
}

// --- операции над строками ---------------------------------------------------

function addCue() {
  if (!media) return toast('Сначала открой видео');
  const t = now();
  const next = P.cues.find(c => c.start > t + 0.05);
  let end = t + 2;
  if (next && next.start - 0.05 < end) end = Math.max(t + 0.5, next.start - 0.05);
  pushUndo();
  const style = sel()?.style || firstStyle();
  const c = { id: newId(), start: t, end, text: '', tr: '', style, pos: null };
  P.cues.push(c);
  sortCues();
  selId = c.id;
  changed(true);
  (field() === 'tr' ? ed.tr : ed.text).focus();
}

function splitText(str, ratio, caret) {
  if (caret != null && caret > 0 && caret < str.length) return [str.slice(0, caret).trim(), str.slice(caret).trim()];
  const flat = str.replace(/\n/g, ' ');
  const target = Math.round(flat.length * ratio);
  const spaces = [...flat.matchAll(/ /g)].map(m => m.index);
  if (!spaces.length) return [str, ''];
  const k = spaces.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best));
  return [flat.slice(0, k).trim(), flat.slice(k + 1).trim()];
}

function splitCue() {
  const c = sel();
  if (!c) return;
  const t = now();
  const at = t > c.start + 0.15 && t < c.end - 0.15 ? t : (c.start + c.end) / 2;
  const ratio = (at - c.start) / (c.end - c.start);
  const caret = f => (document.activeElement === ed[f] ? ed[f].selectionStart : null);
  const [t1, t2] = splitText(c.text, ratio, caret('text'));
  const [r1, r2] = splitText(c.tr, ratio, caret('tr'));
  pushUndo();
  const n = { id: newId(), start: at, end: c.end, text: t2, tr: r2, style: c.style, pos: c.pos };
  Object.assign(c, { end: at, text: t1, tr: r1 });
  P.cues.push(n);
  sortCues();
  ed.text.blur(); ed.tr.blur();
  selId = n.id;
  changed(true);
}

function mergeCue() {
  const c = sel();
  if (!c) return;
  const i = P.cues.indexOf(c), n = P.cues[i + 1];
  if (!n) return toast('Это последняя строка — склеивать не с чем');
  pushUndo();
  c.end = Math.max(c.end, n.end);
  c.text = [c.text, n.text].filter(Boolean).join(' ');
  c.tr = [c.tr, n.tr].filter(Boolean).join(' ');
  P.cues.splice(i + 1, 1);
  changed(true);
}

function deleteCue() {
  const c = sel();
  if (!c) return;
  pushUndo();
  const i = P.cues.indexOf(c);
  P.cues.splice(i, 1);
  selId = (P.cues[i] || P.cues[i - 1])?.id || null;
  changed(true);
}

function stepCue(dir) {
  if (!P.cues.length) return;
  let i = P.cues.findIndex(c => c.id === selId);
  if (i < 0) {
    const t = now();
    i = dir > 0 ? P.cues.findIndex(c => c.start >= t) : P.cues.findLastIndex(c => c.start < t);
    if (i < 0) i = dir > 0 ? P.cues.length - 1 : 0;
  } else i = clamp(i + dir, 0, P.cues.length - 1);
  select(P.cues[i].id, true);
}

function playCue() {
  const c = sel();
  if (!c) return;
  seekTo(c.start);
  stopAt = c.end;
  video.play();
}

$('btnAdd').onclick = addCue;
$('btnSplit').onclick = splitCue;
$('btnMerge').onclick = mergeCue;
$('btnDelete').onclick = deleteCue;
$('btnPlayCue').onclick = playCue;
$('btnNextProblem').onclick = () => {
  if (!problems.size) return toast('Проблем не найдено 👍');
  const i = P.cues.findIndex(c => c.id === selId);
  const next = P.cues.find((c, k) => k > i && problems.has(c.id)) || P.cues.find(c => problems.has(c.id));
  select(next.id, true);
  toast(problems.get(next.id).join(' · '));
};

// --- плеер -------------------------------------------------------------------

function seekTo(t, play = false) {
  video.currentTime = clamp(t, 0, video.duration || t);
  tl.follow(t);
  tl.draw();
  if (play) video.play();
}
function togglePlay() {
  if (!media) return;
  stopAt = null;
  if (video.paused) video.play(); else video.pause();
}

$('btnPlay').onclick = togglePlay;
video.addEventListener('click', togglePlay);
video.addEventListener('play', () => { $('btnPlay').textContent = '❚❚'; syncFollow(); updateEdHead(); });
video.addEventListener('pause', () => { $('btnPlay').textContent = '▶'; updateEdHead(); });
// дублируем tick: requestAnimationFrame замирает, если окно свёрнуто или вкладка в фоне, а видео играет дальше
// и заодно догоняем видео, когда вышел из поля (событие ухода фокуса приходит не всегда)
video.addEventListener('timeupdate', () => { highlightPlaying(now()); syncFollow(); updateEdHead(); });
video.addEventListener('seeked', () => highlightPlaying(now()));
video.addEventListener('loadedmetadata', () => {
  $('timeDur').textContent = fmtShort(video.duration);
  tl.setDuration(video.duration);
  renderOverlay(true);
});
$('speed').onchange = () => { video.playbackRate = +$('speed').value; };
$('volume').oninput = () => { video.volume = +$('volume').value; };

let lastT = -1;
function tick() {
  const t = now();
  if (stopAt != null && t >= stopAt) { video.pause(); stopAt = null; }
  if (t !== lastT) {
    lastT = t;
    $('timeNow').textContent = fmtShort(t);
    if (!video.paused) tl.follow(t);
    tl.draw();
    highlightPlaying(t);
  }
  renderOverlay();
  requestAnimationFrame(tick);
}

// --- предпросмотр сабов на видео ---------------------------------------------

const overlay = $('overlay');
let overlayKey = '';

function videoRect() {
  const box = $('videoBox');
  const bw = box.clientWidth, bh = box.clientHeight;
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const s = Math.min(bw / vw, bh / vh);
  const w = vw * s, h = vh * s;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}

function makeCap(text, st, pos, r) {
  const el = document.createElement('div');
  el.className = 'cap';
  const fs = r.h * PREVIEW_EM * st.size / 100;
  const font = FONTS.find(f => f.id === +st.font) || FONTS[0];
  Object.assign(el.style, {
    fontSize: fs + 'px', fontFamily: font.css, fontVariant: font.smallCaps ? 'small-caps' : 'normal',
    textAlign: ['left', 'right', 'center'][st.align] || 'center',
    left: 2 + 0.96 * pos.ah + '%', top: 2 + 0.96 * pos.av + '%',
    transform: `translate(${-(pos.ap % 3) * 50}%, ${-Math.floor(pos.ap / 3) * 50}%)`,
  });
  const shadow = edgeShadow(st.edge, rgba(st.edgeColor, st.opacity), fs / 16);
  for (const s of parseSpans(text)) {
    const sp = document.createElement('span');
    sp.textContent = s.text;
    Object.assign(sp.style, {
      color: rgba(s.color || st.color, st.opacity), backgroundColor: rgba(st.bg, st.bgOpacity), textShadow: shadow,
      fontWeight: st.bold || s.b ? '700' : '400', fontStyle: st.italic || s.i ? 'italic' : 'normal',
      textDecoration: st.underline || s.u ? 'underline' : 'none',
    });
    el.appendChild(sp);
  }
  return el;
}

function renderOverlay(force = false) {
  const t = now(), f = field();
  const active = media ? P.cues.filter(c => c.start <= t && c.end > t && plainText(c[f]).trim()) : [];
  const sample = !active.length && currentTab === 'styles';
  const r = videoRect();
  const key = `${version}|${active.map(c => c.id).join(',')}|${sample}|${selId}|${r.w}x${r.h}`;
  if (!force && key === overlayKey) return;
  overlayKey = key;
  Object.assign(overlay.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  overlay.textContent = '';
  for (const c of active) {
    const st = styleOf(c);
    const el = makeCap(c[f].trim(), st, cuePosition(c, st), r);
    el.dataset.id = c.id;
    if (c.id === selId) el.classList.add('sel');
    overlay.appendChild(el);
  }
  if (sample) {
    const st = P.styles[curStyle];
    const el = makeCap('Так будут выглядеть субтитры\nв этом стиле', st, st, r);
    el.classList.add('sample');
    el.dataset.style = curStyle;
    overlay.appendChild(el);
  }
}
new ResizeObserver(() => renderOverlay(true)).observe($('videoBox'));

// перетаскивание сабов прямо на видео
let capDrag = null;
overlay.addEventListener('mousedown', e => {
  const cap = e.target.closest('.cap');
  if (!cap || e.button !== 0) return;
  e.preventDefault();
  const r = videoRect();
  if (cap.dataset.id) {
    const c = cueById(cap.dataset.id);
    if (c.id !== selId) select(c.id);
    capDrag = { c, p0: { ...cuePosition(c, styleOf(c)) }, r, x0: e.clientX, y0: e.clientY, moved: false };
  } else {
    const st = P.styles[cap.dataset.style];
    capDrag = { st, p0: { ap: st.ap, ah: st.ah, av: st.av }, r, x0: e.clientX, y0: e.clientY, moved: false };
  }
});
window.addEventListener('mousemove', e => {
  const d = capDrag;
  if (!d) return;
  const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
  if (!d.moved && Math.hypot(dx, dy) < 3) return;
  if (!d.moved) { pushUndo(); d.moved = true; }
  const pos = {
    ap: d.p0.ap,
    ah: Math.round(clamp(d.p0.ah + dx / d.r.w * 100 / 0.96, 0, 100)),
    av: Math.round(clamp(d.p0.av + dy / d.r.h * 100 / 0.96, 0, 100)),
  };
  if (d.c) d.c.pos = pos; else Object.assign(d.st, { ah: pos.ah, av: pos.av });
  version++;
  renderOverlay(true);
  if (d.c) renderEditor(); else fillStyleForm();
});
window.addEventListener('mouseup', () => {
  if (capDrag?.moved) changed(false);
  capDrag = null;
});

// --- дорожка -----------------------------------------------------------------

const tl = new Timeline($('tl'), {
  cues: () => P.cues,
  selectedId: () => selId,
  field: () => field(),
  time: () => now(),
  onSeek: (t, play) => seekTo(t, play),
  onSelectCue: id => { if (id !== selId) select(id); },
  onCueEdit: (id, s, e, phase) => {
    const c = cueById(id);
    if (!c) return;
    if (phase === 'begin') pushUndo();
    else if (phase === 'drag') {
      c.start = s; c.end = e;
      version++;
      tl.draw();
      renderEditor();
      renderOverlay(true);
      const row = rowEl(id);
      if (row) fillRow(row, c, P.cues.indexOf(c));
    } else { sortCues(); changed(true); }
  },
  onSelection: r => { range = r; updateSelInfo(); },
});

function updateSelInfo() {
  const has = !!range;
  $('selInfo').textContent = has
    ? `Участок ${fmtShort(range.a)} – ${fmtShort(range.b)} (${(range.b - range.a).toFixed(1)} с)`
    : 'Протяни мышкой по дорожке, чтобы выделить участок';
  $('btnAsrSel').disabled = !has || asrBusy;
  $('btnPlaySel').disabled = !has;
  $('applyRange').disabled = !has;
}
$('zoomIn').onclick = () => tl.zoom(1.5);
$('zoomOut').onclick = () => tl.zoom(1 / 1.5);
$('zoomFit').onclick = () => { tl.view = 0; tl.pps = Math.max(0.5, tl.width / Math.max(1, tl.duration)); tl.draw(); };
$('btnPlaySel').onclick = () => { if (range) { seekTo(range.a); stopAt = range.b; video.play(); } };

// --- распознавание речи ------------------------------------------------------

let asrBusy = false;
async function runAsr(useRange) {
  if (!media) return toast('Сначала открой видео');
  if (asrBusy) return;
  const a = useRange ? range.a : 0, b = useRange ? range.b : null;
  const inRange = c => c.start >= a - 0.05 && (b == null || c.end <= b + 0.05);
  const existing = P.cues.filter(inRange).length;
  if (existing && !confirm(`На этом участке уже есть строк: ${existing}. Заменить их распознанным текстом?\n(Можно будет отменить через Ctrl+Z)`)) return;
  asrBusy = true;
  $('btnAsrAll').disabled = true;
  updateSelInfo();
  try {
    const { job } = await api('/api/transcribe', { id: media.id, start: a, end: b, lang: P.settings.asrLang, model: P.settings.model });
    const res = await waitJob(job, $('asrProgress'), (msg, p) => toast(`${msg} ${p ? Math.round(p) + '%' : ''}`, { ms: 0 }));
    pushUndo();
    P.cues = P.cues.filter(c => !inRange(c));
    const style = sel()?.style || firstStyle();
    for (const c of res.cues) P.cues.push({ id: newId(), start: c.start, end: c.end, text: c.text, tr: '', style, pos: null });
    sortCues();
    if (!P.settings.srcLang && res.language) { P.settings.srcLang = res.language; fillSettings(); }
    if (field() !== 'text') setField('text', false);
    changed(true);
    toast(res.cues.length ? `Готово: ${res.cues.length} строк (язык: ${res.language})` : 'Речь не найдена на этом участке', { ms: 6000 });
  } catch (e) {
    toast('Распознавание не удалось: ' + e.message, { err: true, ms: 10000 });
  } finally {
    asrBusy = false;
    $('btnAsrAll').disabled = false;
    updateSelInfo();
    refreshModels();
  }
}
$('btnAsrSel').onclick = () => runAsr(true);
$('btnAsrAll').onclick = () => runAsr(false);

// модели: скачиваются один раз; нужную заранее поднимаем в память, пока смотришь видео
let modelPoll = null;
async function refreshModels() {
  clearTimeout(modelPoll);
  let m;
  try { m = await api('/api/models'); } catch { return; }
  for (const o of $('asrModel').options) {
    o.dataset.label ||= o.textContent;
    o.textContent = o.dataset.label + (m.downloaded.includes(o.value) ? '' : ' (скачается при первом запуске)');
  }
  const s = $('asrModelState');
  if (m.loaded === P.settings.model) {
    s.textContent = '⚡ готова';
    s.title = `Модель уже в памяти (${m.device === 'cuda' ? 'видеокарта' : 'процессор'}) — распознавание начнётся сразу`;
  } else if (m.loading) {
    s.textContent = '⏳ загружается';
    s.title = 'Модель поднимается в память — это один раз за запуск';
    modelPoll = setTimeout(refreshModels, 1500);
  } else {
    s.textContent = '';
    s.title = '';
  }
}
function preloadModel() {
  if (media) api('/api/models/preload', { model: $('asrModel').value }).then(refreshModels, () => {});
}
$('asrModel').addEventListener('change', preloadModel);
refreshModels();

// --- перевод -----------------------------------------------------------------

async function runTranslate() {
  if (!media) return toast('Сначала открой видео');
  const s = P.settings;
  let cues = P.cues.filter(c => plainText(c.text).trim());
  if (s.trScope === 'empty') cues = cues.filter(c => !c.tr.trim());
  if (s.trScope === 'range') {
    if (!range) return toast('Выдели участок на дорожке');
    cues = cues.filter(c => c.end > range.a && c.start < range.b);
  }
  if (s.trScope === 'cue') cues = cues.filter(c => c.id === selId);
  if (!cues.length) return toast('Нечего переводить');
  if (s.srcLang && s.srcLang === s.tgtLang) return toast('Языки «с» и «на» совпадают');
  const glossary = s.glossary.split('\n').map(l => l.split('=')).filter(p => p.length >= 2 && p[0].trim())
    .map(([a, ...b]) => [a.trim(), b.join('=').trim()]);
  $('btnTranslate').disabled = true;
  try {
    const { job } = await api('/api/translate', {
      texts: cues.map(c => c.text), source: googleCode(s.srcLang), target: googleCode(s.tgtLang), glossary,
    });
    const res = await waitJob(job, $('trProgress'), (msg, p) => toast(`${msg} ${Math.round(p)}%`, { ms: 0 }));
    pushUndo();
    cues.forEach((c, i) => { if (res.texts[i]) c.tr = res.texts[i]; });
    setField('tr', false);
    changed(true);
    toast(`Переведено строк: ${cues.length}. Проверь глазами — машинный перевод любит ошибаться в шутках и сленге.`, { ms: 7000 });
  } catch (e) {
    toast('Перевод не удался: ' + e.message, { err: true, ms: 10000 });
  } finally {
    $('btnTranslate').disabled = false;
  }
}
$('btnTranslate').onclick = runTranslate;

function setField(f, rerender = true) {
  P.settings.field = f;
  for (const b of document.querySelectorAll('#fieldToggle button')) b.classList.toggle('on', b.dataset.field === f);
  if (rerender) changed(true);
}
for (const b of document.querySelectorAll('#fieldToggle button')) b.onclick = () => setField(b.dataset.field);

// --- стили -------------------------------------------------------------------

const st = id => $(id);
const STYLE_FIELDS = [
  ['stName', 'name', 'text'], ['stFont', 'font', 'num'], ['stSize', 'size', 'num'], ['stColor', 'color', 'color'],
  ['stOpacity', 'opacity', 'num'], ['stBg', 'bg', 'color'], ['stBgOpacity', 'bgOpacity', 'num'],
  ['stEdge', 'edge', 'num'], ['stEdgeColor', 'edgeColor', 'color'], ['stBold', 'bold', 'bool'],
  ['stItalic', 'italic', 'bool'], ['stUnderline', 'underline', 'bool'], ['stAlign', 'align', 'num'],
  ['stAh', 'ah', 'num'], ['stAv', 'av', 'num'],
];
const ANCHORS = ['↖', '↑', '↗', '←', '•', '→', '↙', '↓', '↘'];

for (const f of FONTS) st('stFont').add(new Option(f.name, f.id));
for (const e of EDGES) st('stEdge').add(new Option(e.name, e.id));
ANCHORS.forEach((label, ap) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = 'Привязка текста к этой точке';
  b.onclick = () => {
    const s = P.styles[curStyle];
    pushUndo();
    Object.assign(s, { ap, ah: [3, 50, 97][ap % 3], av: [4, 50, 96][Math.floor(ap / 3)] });
    fillStyleForm();
    changed(false);
  };
  $('anchorGrid').appendChild(b);
});

function renderStyles() {
  if (!P.styles[curStyle]) curStyle = firstStyle();
  for (const s of [st('styleSel'), ed.style]) {
    s.textContent = '';
    for (const [k, v] of Object.entries(P.styles)) s.add(new Option(v.name, k));
  }
  st('styleSel').value = curStyle;
  fillStyleForm();
  renderEditor();
}

function fillStyleForm() {
  const s = P.styles[curStyle];
  for (const [id, key, type] of STYLE_FIELDS) {
    const el = st(id);
    if (document.activeElement === el && type === 'text') continue;
    if (type === 'bool') el.checked = !!s[key];
    else if (type === 'color') el.value = s[key].toLowerCase();
    else el.value = s[key];
  }
  st('stSizeOut').value = s.size + '%';
  st('stOpacityOut').value = s.opacity + '%';
  st('stBgOpacityOut').value = s.bgOpacity + '%';
  st('stAhOut').value = s.ah + '%';
  st('stAvOut').value = s.av + '%';
  [...$('anchorGrid').children].forEach((b, k) => b.classList.toggle('on', k === +s.ap));
}

for (const [id, key, type] of STYLE_FIELDS) {
  st(id).addEventListener(type === 'bool' || id === 'stFont' || id === 'stEdge' || id === 'stAlign' ? 'change' : 'input', () => {
    const s = P.styles[curStyle], el = st(id);
    pushUndo(`style:${curStyle}:${key}`);
    s[key] = type === 'bool' ? el.checked : type === 'num' ? +el.value : type === 'color' ? el.value.toUpperCase() : el.value;
    if (key === 'name') {
      for (const sel of [st('styleSel'), ed.style]) {
        const o = [...sel.options].find(o => o.value === curStyle);
        if (o) o.text = s.name || 'Без названия';
      }
    }
    fillStyleForm();
    changed(false);
  });
}
st('styleSel').onchange = () => { curStyle = st('styleSel').value; fillStyleForm(); renderOverlay(true); };
st('styleNew').onclick = () => {
  pushUndo();
  curStyle = 's' + Date.now().toString(36);
  P.styles[curStyle] = { ...BASE_STYLE, name: 'Новый стиль' };
  renderStyles(); changed(false);
  st('stName').select();
};
st('styleDup').onclick = () => {
  pushUndo();
  const src = P.styles[curStyle];
  curStyle = 's' + Date.now().toString(36);
  P.styles[curStyle] = { ...src, name: src.name + ' (копия)' };
  renderStyles(); changed(false);
};
st('styleDel').onclick = () => {
  const keys = Object.keys(P.styles);
  if (keys.length < 2) return toast('Нужен хотя бы один стиль');
  const used = P.cues.filter(c => c.style === curStyle).length;
  if (!confirm(`Удалить стиль «${P.styles[curStyle].name}»?` + (used ? `\nСтрок с этим стилем: ${used} — им поставится первый стиль из списка.` : ''))) return;
  pushUndo();
  delete P.styles[curStyle];
  const fb = firstStyle();
  for (const c of P.cues) if (!P.styles[c.style]) c.style = fb;
  curStyle = fb;
  renderStyles(); changed(true);
};
function applyStyle(cues) {
  if (!cues.length) return toast('Нет подходящих строк');
  pushUndo();
  for (const c of cues) { c.style = curStyle; c.pos = null; }
  changed(true);
  toast(`Стиль применён к строкам: ${cues.length}`);
}
$('applyCue').onclick = () => applyStyle(P.cues.filter(c => c.id === selId));
$('applyRange').onclick = () => range && applyStyle(P.cues.filter(c => c.end > range.a && c.start < range.b));
$('applyAll').onclick = () => applyStyle(P.cues);

// --- вкладки -----------------------------------------------------------------

for (const b of document.querySelectorAll('.tabs button')) {
  b.onclick = () => {
    currentTab = b.dataset.tab;
    for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x === b);
    for (const t of document.querySelectorAll('.tab')) t.hidden = t.id !== 'tab-' + currentTab;
    renderOverlay(true);
  };
}

// --- настройки (языки, глоссарий, лимиты) ------------------------------------

st('asrLang').add(new Option('Определить сам', ''));
st('trSrc').add(new Option('Определить сам', ''));
for (const [code, name] of LANGS) {
  st('asrLang').add(new Option(name, code));
  st('trSrc').add(new Option(name, code));
  st('trTgt').add(new Option(name, code));
}
const SETTINGS_FIELDS = [
  ['asrLang', 'asrLang'], ['asrModel', 'model'], ['trSrc', 'srcLang'], ['trTgt', 'tgtLang'], ['trScope', 'trScope'],
  ['glossary', 'glossary'], ['limCps', 'cps'], ['limLine', 'line'],
];
function fillSettings() {
  for (const [id, key] of SETTINGS_FIELDS) st(id).value = P.settings[key];
  for (const b of document.querySelectorAll('#fieldToggle button')) b.classList.toggle('on', b.dataset.field === field());
}
for (const [id, key] of SETTINGS_FIELDS) {
  st(id).addEventListener(id === 'glossary' ? 'input' : 'change', () => {
    const el = st(id);
    P.settings[key] = el.type === 'number' ? Math.max(1, +el.value || DEFAULT_SETTINGS[key]) : el.value;
    if (key === 'cps' || key === 'line') changed(true); else scheduleSave();
  });
}

// --- сдвиг таймингов ---------------------------------------------------------

function shift(onlyAfter) {
  const d = parseFloat(String($('shiftBy').value).replace(',', '.'));
  if (!d) return toast('Укажи сдвиг в секундах, например 0.5 или -1.2');
  const t = now();
  const cues = P.cues.filter(c => !onlyAfter || c.start >= t - 0.01);
  if (!cues.length) return toast('Нет строк для сдвига');
  pushUndo();
  for (const c of cues) {
    const len = c.end - c.start;
    c.start = Math.max(0, c.start + d);
    c.end = c.start + len;
  }
  sortCues();
  changed(true);
  toast(`Сдвинуто строк: ${cues.length} на ${d > 0 ? '+' : ''}${d} с`);
}
$('shiftAll').onclick = () => shift(false);
$('shiftAfter').onclick = () => shift(true);

// --- открытие файлов ---------------------------------------------------------

async function openMedia(path) {
  if (!path) return;
  await flushSave();
  try {
    const res = await api('/api/open', { path });
    media = res;
    $('fileName').textContent = res.name;
    $('fileName').title = res.path;
    document.title = res.name + ' — Sub Studio';
    P = normalize(res.project || defaultProject());
    selId = null; range = null; tl.selection = null; stopAt = null;
    undoStack.length = 0; redoStack.length = 0;
    curStyle = firstStyle();
    video.src = '/media/' + res.id;
    $('emptyHint').hidden = true;
    $('saveState').textContent = res.project ? 'Проект загружен' : '';
    fillSettings();
    renderStyles();
    updateSelInfo();
    changed(true, false);
    preloadModel();
    toast('Строю звуковую дорожку…', { ms: 0 });
    const w = await api('/api/waveform/' + res.id);
    const bin = atob(w.peaks), peaks = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) peaks[i] = bin.charCodeAt(i);
    tl.setAudio(peaks, w.rate, video.duration || w.duration);
    hideToast();
  } catch (e) {
    toast('Не получилось открыть: ' + e.message, { err: true, ms: 10000 });
  }
}

$('btnOpen').onclick = async () => {
  try { openMedia((await api('/api/pick', {})).path); } catch (e) { toast(e.message, { err: true }); }
};

// файл, перетащенный в окно: полный путь к нему передаёт окно приложения (в браузере путь недоступен)
const MEDIA_RE = /\.(mp4|mkv|webm|mov|m4a|mp3|wav|ogg|opus|flac)$/i;
window.substudioDrop = paths => {
  const p = paths.find(x => MEDIA_RE.test(x));
  if (p) openMedia(p); else toast('Перетащи сюда видео или звуковой файл');
};
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault()); // иначе файл откроется вместо приложения

function closeMenus() { for (const m of document.querySelectorAll('.menu')) m.hidden = true; }
document.addEventListener('mousedown', e => { if (!e.target.closest('.menu-wrap')) closeMenus(); });

$('btnRecent').onclick = async () => {
  const menu = $('recentMenu');
  if (!menu.hidden) return closeMenus();
  closeMenus();
  const r = await api('/api/recent');
  menu.textContent = '';
  const section = (title, paths) => {
    const h = document.createElement('div');
    h.className = 'h';
    h.textContent = title;
    menu.appendChild(h);
    if (!paths.length) {
      const e = document.createElement('div');
      e.className = 'h';
      e.textContent = '— пусто —';
      menu.appendChild(e);
    }
    for (const p of paths) {
      const b = document.createElement('button');
      b.textContent = p.split(/[\\/]/).pop();
      b.title = p;
      b.onclick = () => { closeMenus(); openMedia(p); };
      menu.appendChild(b);
    }
  };
  section('Недавние', r.recent);
  section('Скачанные (' + r.folder + ')', r.downloads);
  menu.hidden = false;
};

let importMode = 'text';
$('btnImport').onclick = () => { const m = $('importMenu'), open = m.hidden; closeMenus(); m.hidden = !open; };
for (const b of document.querySelectorAll('[data-import]')) {
  b.onclick = () => {
    closeMenus();
    if (!media) return toast('Сначала открой видео');
    importMode = b.dataset.import;
    $('fileInput').click();
  };
}
$('fileInput').onchange = async () => {
  const file = $('fileInput').files[0];
  $('fileInput').value = '';
  if (!file) return;
  const cues = parseSubs(await file.text());
  if (!cues.length) return toast('В файле не нашлось субтитров', { err: true });
  const style = firstStyle();
  if (importMode === 'text' || !P.cues.length) {
    if (P.cues.length && !confirm(`Заменить все ${P.cues.length} строк субтитрами из файла (${cues.length})?\nМожно отменить через Ctrl+Z.`)) return;
    pushUndo();
    const key = importMode === 'tr' ? 'tr' : 'text';
    P.cues = cues.map(c => ({ id: newId(), start: c.start, end: c.end, text: '', tr: '', [key]: c.text, style, pos: null }));
  } else {
    pushUndo();
    let matched = 0;
    for (const c of P.cues) {
      let best = null, bestOv = 0;
      for (const n of cues) {
        const ov = Math.min(c.end, n.end) - Math.max(c.start, n.start);
        if (ov > bestOv) { bestOv = ov; best = n; }
      }
      if (best) { c.tr = best.text; matched++; }
    }
    toast(`Перевод подставлен в ${matched} из ${P.cues.length} строк`);
  }
  sortCues();
  selId = null;
  if (importMode === 'tr') setField('tr', false);
  changed(true);
};

// --- экспорт -----------------------------------------------------------------

async function exportAs(kind) {
  if (!media) return toast('Сначала открой видео');
  await flushSave();
  const f = field();
  if (!P.cues.some(c => plainText(c[f]).trim())) return toast(f === 'tr' ? 'Нет перевода для выгрузки' : 'Нет субтитров для выгрузки');
  const lang = f === 'tr' ? P.settings.tgtLang : P.settings.srcLang || P.settings.asrLang;
  const suffix = (lang ? '.' + lang : '') + '.' + kind;
  const content = kind === 'srt' ? toSRT(P.cues, f) : toYTT(P.cues, P.styles, f, firstStyle());
  try {
    const r = await api('/api/export', { id: media.id, suffix, content });
    const name = r.path.split(/[\\/]/).pop();
    toast(`Сохранено: ${name}` + (problems.size ? ` (⚠ проблемных строк: ${problems.size})` : ''), {
      action: ['Показать в папке', () => api('/api/reveal', { id: media.id, name })], ms: 9000,
    });
  } catch (e) {
    toast('Не удалось сохранить: ' + e.message, { err: true });
  }
}
$('btnSrt').onclick = () => exportAs('srt');
$('btnYtt').onclick = () => exportAs('ytt');

// --- вшивание сабов в видео --------------------------------------------------

let burnJob = null, burnCaps = null, burnResult = null;
const burnPrefs = store.get('burn', { quality: 'normal', encoder: 'nvenc' });
$('burnQuality').value = burnPrefs.quality;
$('burnEncoder').value = burnPrefs.encoder;

function burnSuffix(scope) {
  const lang = field() === 'tr' ? P.settings.tgtLang : P.settings.srcLang || P.settings.asrLang;
  return (lang ? '.' + lang : '') + (scope === 'range' ? '.hardsub-test' : '.hardsub') + '.mp4';
}

function updateBurnForm() {
  if (!media) return;
  const scope = $('burnScope');
  scope.options[1].disabled = !range;
  if (!range && scope.value === 'range') scope.value = 'all';
  $('burnField').textContent = (field() === 'tr' ? 'Перевод' : 'Оригинал') + ' — как выбрано переключателем вверху';
  $('burnOut').textContent = media.name.replace(/\.[^.]+$/, '') + burnSuffix(scope.value);
  const inScope = c => scope.value !== 'range' || (c.end > range.a && c.start < range.b);
  const n = P.cues.filter(c => plainText(c[field()]).trim() && inScope(c)).length;
  const warns = [];
  if (!video.videoWidth) warns.push('В этом файле нет картинки (или видео ещё грузится).');
  else if (!n) warns.push('Здесь нет субтитров с текстом — вшивать нечего.');
  if (problems.size) warns.push(`⚠ Проблемных строк: ${problems.size} — их можно поправить до вшивания.`);
  if (scope.value === 'all' && !burnJob) warns.push('Совет: сначала выдели короткий кусок на дорожке и вшей только его — так быстрее проверить, как всё выглядит.');
  $('burnWarn').hidden = !warns.length;
  $('burnWarn').textContent = warns.join(' ');
  $('burnStart').disabled = !!burnJob || !n || !video.videoWidth;
  for (const id of ['burnScope', 'burnQuality', 'burnEncoder']) $(id).disabled = !!burnJob;
}

async function openBurn() {
  if (!media) return toast('Сначала открой видео');
  $('burnModal').hidden = false;
  if (!burnJob) $('burnReveal').hidden = !burnResult;
  updateBurnForm();
  if (burnCaps == null) {
    try { burnCaps = await api('/api/burn/caps'); } catch { burnCaps = { nvenc: false }; }
    if (!burnCaps.nvenc) {
      $('burnEncoder').options[0].disabled = true;
      $('burnEncoder').options[0].text = 'Видеокарта NVIDIA — недоступна';
      $('burnEncoder').value = 'x264';
    }
  }
}
const closeBurn = () => { $('burnModal').hidden = true; };

async function startBurn() {
  await flushSave();
  const scope = $('burnScope').value, r = scope === 'range' ? { ...range } : null;
  const ass = toASS(P.cues, P.styles, field(), firstStyle(), video.videoWidth, video.videoHeight, r);
  const quality = $('burnQuality').value, encoder = $('burnEncoder').value;
  store.set('burn', { quality, encoder });
  const target = { id: media.id };
  burnResult = null;
  $('burnReveal').hidden = true;
  $('burnCancel').hidden = false;
  $('burnMsg').textContent = 'Запускаю…';
  $('btnBurn').classList.add('busy');
  try {
    const { job } = await api('/api/burn', {
      id: media.id, ass, start: r ? r.a : 0, end: r ? r.b : null, quality, encoder, suffix: burnSuffix(scope),
    });
    burnJob = job;
    updateBurnForm();
    const res = await waitJob(job, $('burnProgress'), (msg, p) => {
      $('burnMsg').textContent = msg;
      $('btnBurn').textContent = `🔥 ${Math.round(p)}%`;
    });
    burnResult = { id: target.id, name: res.path.split(/[\\/]/).pop() };
    $('burnMsg').textContent = `Готово: ${burnResult.name}` + (res.encoder === 'x264' && encoder === 'nvenc' ? ' (видеокарта не справилась — кодировал процессор)' : '');
    $('burnReveal').hidden = false;
    toast('Сабы вшиты в видео', { action: ['Показать в папке', revealBurn], ms: 9000 });
  } catch (e) {
    const stopped = e.message === 'Отменено';
    $('burnMsg').textContent = stopped ? 'Остановлено — недоделанный файл удалён.' : 'Не получилось: ' + e.message;
    if (!stopped) toast('Вшить сабы не получилось — подробности в окне «Вшить в видео»', { err: true, ms: 8000 });
  } finally {
    burnJob = null;
    $('burnCancel').hidden = true;
    $('btnBurn').classList.remove('busy');
    $('btnBurn').textContent = '🔥 Вшить в видео';
    updateBurnForm();
  }
}
const revealBurn = () => burnResult && api('/api/reveal', burnResult);

$('btnBurn').onclick = openBurn;
$('burnClose').onclick = closeBurn;
$('burnStart').onclick = startBurn;
$('burnReveal').onclick = revealBurn;
$('burnScope').onchange = updateBurnForm;
$('burnCancel').onclick = () => burnJob && api(`/api/job/${burnJob}/cancel`, {});
$('burnModal').addEventListener('mousedown', e => { if (e.target === $('burnModal')) closeBurn(); });

// --- горячие клавиши ---------------------------------------------------------
// Все действия — в одном списке: отсюда строятся обработчик клавиш, окно настройки (F1) и подсказки на кнопках.
// Комбинации записываются по физическим клавишам (e.code), поэтому работают и на русской раскладке.

const TEXT_SEL = 'input:not([type=range]):not([type=checkbox]):not([type=color]), textarea, select';
const MOD_KEYS = ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'];
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const KEY_NAMES = {
  Space: 'Пробел', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Delete: 'Del',
  Insert: 'Ins', Minus: '−', Equal: '=', Slash: '/', Comma: ',', Period: '.', BracketLeft: '[', BracketRight: ']',
  Backquote: '`', Backslash: '\\', Semicolon: ';', Quote: "'", Backspace: '⌫', PageUp: 'PgUp', PageDown: 'PgDn',
};

const seekBy = d => seekTo(now() + d);
function stepSpeed(dir) {
  let i = SPEEDS.indexOf(video.playbackRate);
  if (i < 0) i = 2;
  const v = SPEEDS[clamp(i + dir, 0, SPEEDS.length - 1)];
  video.playbackRate = v;
  $('speed').value = String(v);
  toast(`Скорость ${v}×`, { ms: 1200 });
}
function toggleFollow() {
  const f = $('follow');
  f.checked = !f.checked;
  f.dispatchEvent(new Event('change'));
}
function replay() {
  if (!media) return;
  stopAt = null;
  seekTo(now() - 3, true);
}
function focusText() { if (sel()) (field() === 'tr' ? ed.tr : ed.text).focus(); }
function leaveField() {
  if (!$('keysModal').hidden) return closeKeys();
  if (!$('burnModal').hidden) return closeBurn();
  const a = document.activeElement;
  if (a && a.matches?.(TEXT_SEL)) a.blur();
  else if (range) { range = null; tl.selection = null; updateSelInfo(); tl.draw(); }
}

const ACTIONS = [
  ['Плеер', [
    ['play', 'Пуск / пауза', ['Space', 'Ctrl+Space'], togglePlay],
    ['back1', 'Назад на 1 с', ['ArrowLeft', 'Alt+ArrowLeft'], () => seekBy(-1)],
    ['fwd1', 'Вперёд на 1 с', ['ArrowRight', 'Alt+ArrowRight'], () => seekBy(1)],
    ['back5', 'Назад на 5 с', ['Shift+ArrowLeft', 'Alt+Shift+ArrowLeft'], () => seekBy(-5)],
    ['fwd5', 'Вперёд на 5 с', ['Shift+ArrowRight', 'Alt+Shift+ArrowRight'], () => seekBy(5)],
    ['replay', 'Переслушать последние 3 с', ['Alt+R'], replay],
    ['slower', 'Медленнее', ['Alt+Minus'], () => stepSpeed(-1)],
    ['faster', 'Быстрее', ['Alt+Equal'], () => stepSpeed(1)],
    ['follow', 'Карточка следует за видео — вкл/выкл', ['Alt+C'], toggleFollow],
  ]],
  ['Строки', [
    ['prev', 'Предыдущая строка', ['ArrowUp', 'Alt+ArrowUp'], () => stepCue(-1)],
    ['next', 'Следующая строка', ['ArrowDown', 'Alt+ArrowDown'], () => stepCue(1)],
    ['setStart', 'Начало строки = курсор видео', ['Alt+Q'], () => setTime('start', now())],
    ['setEnd', 'Конец строки = курсор видео', ['Alt+W'], () => setTime('end', now())],
    ['add', 'Новая строка с курсора', ['Alt+N', 'Insert'], addCue],
    ['split', 'Разрезать строку', ['Alt+S'], splitCue],
    ['merge', 'Склеить со следующей', ['Alt+M'], mergeCue],
    ['playCue', 'Проиграть строку', ['Alt+P'], playCue],
    ['delete', 'Удалить строку', ['Alt+Delete', 'Delete'], deleteCue],
    ['nextProblem', 'К следующей проблемной строке', ['Alt+E'], () => $('btnNextProblem').click()],
  ]],
  ['Текст', [
    ['edit', 'Перейти к тексту строки', ['Enter'], focusText],
    ['leave', 'Выйти из поля / снять выделение', ['Escape'], leaveField, { inText: true }],
    ['bold', 'Жирный', ['Ctrl+B'], () => wrapSelection('b'), { onlyText: true }],
    ['italic', 'Курсив', ['Ctrl+I'], () => wrapSelection('i'), { onlyText: true }],
    ['underline', 'Подчёркнутый', ['Ctrl+U'], () => wrapSelection('u'), { onlyText: true }],
    ['toggleField', 'Переключить оригинал / перевод', ['Alt+T'], () => setField(otherField())],
  ]],
  ['Файл и правка', [
    ['undo', 'Отменить', ['Ctrl+Z'], undo, { noText: true }],
    ['redo', 'Повторить', ['Ctrl+Y', 'Ctrl+Shift+Z'], redo, { noText: true }],
    ['save', 'Сохранить сейчас', ['Ctrl+S'], () => flushSave().then(() => media && toast('Сохранено ✓', { ms: 1200 }))],
    ['exportYtt', 'Экспорт YTT', ['Ctrl+E'], () => exportAs('ytt')],
    ['burn', 'Вшить сабы в видео', ['Ctrl+Shift+E'], openBurn],
    ['help', 'Окно горячих клавиш', ['F1', 'Shift+Slash'], () => toggleKeys()],
  ]],
];

// «Alt+N» → «Alt+KeyN», «Ctrl+1» → «Ctrl+Digit1»: нажатия сравниваются по e.code, и запись должна быть такой же
const normCombo = c => c.replace(/(^|\+)([A-Z])$/, '$1Key$2').replace(/(^|\+)([0-9])$/, '$1Digit$2');

const ACTION = {};
for (const [group, items] of ACTIONS) {
  for (const [id, name, defaults, fn, opts = {}] of items) {
    ACTION[id] = { id, name, defaults: defaults.map(normCombo), fn, group, ...opts };
  }
}

function loadBindings() {
  const saved = store.get('hotkeys', {});
  const b = {};
  for (const id in ACTION) b[id] = Array.isArray(saved[id]) ? [...new Set(saved[id].map(normCombo))] : [...ACTION[id].defaults];
  return b;
}
let bindings = loadBindings();
let keymap = new Map();
let recording = null;

// e.code бывает пустым у экранных клавиатур и программ-переназначалок — тогда берём код клавиши Windows,
// он тоже не зависит от раскладки
const KEYCODES = { 8: 'Backspace', 13: 'Enter', 27: 'Escape', 32: 'Space', 33: 'PageUp', 34: 'PageDown', 37: 'ArrowLeft',
  38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 45: 'Insert', 46: 'Delete', 187: 'Equal', 189: 'Minus', 191: 'Slash' };
function codeOf(e) {
  if (e.code) return e.code;
  const k = e.keyCode;
  if (k >= 65 && k <= 90) return 'Key' + String.fromCharCode(k);
  if (k >= 48 && k <= 57) return 'Digit' + (k - 48);
  if (k >= 112 && k <= 123) return 'F' + (k - 111);
  return KEYCODES[k] || '';
}
const comboOf = e => [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', codeOf(e)].filter(Boolean).join('+');
function keyLabel(combo) {
  if (combo === 'Shift+Slash') return '?';
  return combo.split('+').map(p => KEY_NAMES[p] || p.replace(/^(Key|Digit|Numpad)/, '')).join('+');
}

function applyBindings(save = true) {
  keymap = new Map();
  for (const id in bindings) for (const k of bindings[id]) keymap.set(k, id);
  if (save) store.set('hotkeys', bindings);
  renderHints();
  if (!$('keysModal').hidden) renderKeys();
}

// подсказки: всплывающая при наведении + значок на кнопке (виден всегда у главных кнопок и у всех — пока держишь Alt)
function renderHints() {
  for (const el of document.querySelectorAll('[data-action]')) {
    const id = el.dataset.action, keys = bindings[id] || [];
    if (el.dataset.title == null) el.dataset.title = el.title || ACTION[id]?.name || '';
    el.dataset.key = keys.length ? keyLabel(keys[0]) : '';
    el.title = keys.length ? `${el.dataset.title} — ${keys.map(keyLabel).join(' или ')}` : el.dataset.title;
  }
}

document.addEventListener('keydown', e => {
  if (recording) return;
  if (e.key === 'Alt') { e.preventDefault(); document.body.classList.add('show-keys'); return; }
  if (MOD_KEYS.includes(e.key) || !codeOf(e)) return;
  const id = keymap.get(comboOf(e));
  if (!id) return;
  const a = ACTION[id], t = e.target;
  const inText = !!t.matches?.(TEXT_SEL);
  if (a.onlyText) {
    if (t !== ed.text && t !== ed.tr) return;
  } else if (inText && !a.inText && (a.noText || !(e.ctrlKey || e.altKey))) {
    return; // в поле ввода «голые» клавиши печатают текст, а Ctrl+Z работает как обычно
  }
  e.preventDefault();
  const modal = !$('keysModal').hidden || !$('burnModal').hidden;
  if (modal && id !== 'help' && id !== 'leave') return;
  a.fn();
});
document.addEventListener('keyup', e => {
  if (e.key === 'Alt') { e.preventDefault(); document.body.classList.remove('show-keys'); }
});
window.addEventListener('blur', () => document.body.classList.remove('show-keys'));

// после клика мышкой кнопки и галочки не держат фокус — иначе Пробел нажмёт их снова, а не запустит видео
document.addEventListener('click', e => {
  const el = e.target.closest?.('button, input[type=checkbox], input[type=range]');
  if (el && !el.closest('.modal') && e.detail > 0) el.blur();
});
$('volume').addEventListener('change', () => $('volume').blur());

// --- окно горячих клавиш (F1) ---

function renderKeys() {
  const body = $('keysBody');
  body.textContent = '';
  for (const [group, items] of ACTIONS) {
    const g = document.createElement('div');
    g.className = 'grp';
    g.textContent = group;
    body.appendChild(g);
    for (const [id] of items) {
      const row = document.createElement('div');
      row.className = 'key-row';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = ACTION[id].name;
      row.appendChild(name);
      for (const k of bindings[id]) {
        const kb = document.createElement('kbd');
        kb.append(keyLabel(k));
        const x = document.createElement('button');
        x.textContent = '×';
        x.title = 'Убрать эту комбинацию';
        x.onclick = () => { bindings[id] = bindings[id].filter(v => v !== k); applyBindings(); };
        kb.appendChild(x);
        row.appendChild(kb);
      }
      const add = document.createElement('button');
      add.className = 'small-btn add' + (recording === id ? ' rec' : '');
      add.textContent = recording === id ? 'нажми клавиши…' : '+';
      add.title = 'Назначить комбинацию';
      add.onclick = () => { recording = recording === id ? null : id; renderKeys(); };
      row.appendChild(add);
      body.appendChild(row);
    }
  }
}

// запись новой комбинации перехватывает клавиши раньше всех остальных обработчиков
window.addEventListener('keydown', e => {
  if (!recording) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (MOD_KEYS.includes(e.key) || !codeOf(e)) return;
  const id = recording;
  recording = null;
  if (codeOf(e) === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) return renderKeys();
  const combo = comboOf(e), owner = keymap.get(combo);
  if (owner && owner !== id) {
    bindings[owner] = bindings[owner].filter(k => k !== combo);
    toast(`«${keyLabel(combo)}» забрана у действия «${ACTION[owner].name}»`);
  }
  if (!bindings[id].includes(combo)) bindings[id].push(combo);
  applyBindings();
}, true);

function openKeys() { recording = null; renderKeys(); $('keysModal').hidden = false; }
function closeKeys() { recording = null; $('keysModal').hidden = true; }
function toggleKeys() { if ($('keysModal').hidden) openKeys(); else closeKeys(); }
$('btnKeys').onclick = openKeys;
$('btnKeys2').onclick = openKeys;
$('keysClose').onclick = closeKeys;
$('keysModal').addEventListener('mousedown', e => { if (e.target === $('keysModal')) closeKeys(); });
$('keysReset').onclick = () => {
  if (!confirm('Вернуть все горячие клавиши по умолчанию?')) return;
  for (const id in ACTION) bindings[id] = [...ACTION[id].defaults];
  applyBindings();
};

// --- старт -------------------------------------------------------------------

fillSettings();
renderStyles();
changed(true, false);
updateSelInfo();
applyBindings(false);
requestAnimationFrame(tick);
if (!store.get('tipShown', false)) {
  store.set('tipShown', true);
  setTimeout(() => toast('Подсказка: держи Alt — на кнопках появятся горячие клавиши. F1 — полный список и настройка.', { ms: 9000 }), 800);
}
