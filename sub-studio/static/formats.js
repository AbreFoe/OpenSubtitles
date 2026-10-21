// Время, разбор/сборка SRT и экспорт в YTT (srv3) — формат YouTube со стилями и позициями.

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function fmtTime(t, sep = '.') {
  const ms = Math.max(0, Math.round((Number.isFinite(t) ? t : 0) * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

// Короткий вид для списка: 1:23.4 или 1:02:03.4
export function fmtShort(t) {
  const ds = Math.max(0, Math.round(t * 10));
  const h = Math.floor(ds / 36000), m = Math.floor(ds / 600) % 60, s = Math.floor(ds / 10) % 60;
  return (h ? `${h}:${pad(m)}` : `${m}`) + `:${pad(s)}.${ds % 10}`;
}

// Понимает 01:02:03.456, 1:02,5, 62.5, 62
export function parseTime(str) {
  const parts = String(str).trim().replace(',', '.').split(':');
  if (!parts.length || parts.length > 3 || parts.some(p => p === '' || isNaN(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}

// --- inline-разметка: <b> <i> <u> <font color="#RRGGBB"> ---

const TAG_RE = /<(\/?)(b|i|u|font)\b([^>]*)>/gi;

export function parseSpans(text) {
  const spans = [];
  const stack = [{ b: false, i: false, u: false, color: null }];
  let last = 0, m;
  const push = s => { if (s) spans.push({ text: s, ...stack[stack.length - 1] }); };
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text))) {
    push(text.slice(last, m.index).replace(/<[^>]*>/g, ''));
    last = TAG_RE.lastIndex;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      if (stack.length > 1) stack.pop();
    } else {
      const st = { ...stack[stack.length - 1] };
      if (tag === 'font') {
        const c = /color\s*=\s*["']?(#[0-9a-f]{6})/i.exec(m[3]);
        if (c) st.color = c[1].toUpperCase();
      } else st[tag] = true;
      stack.push(st);
    }
  }
  push(text.slice(last).replace(/<[^>]*>/g, ''));
  return spans;
}

export const plainText = text => String(text || '').replace(/<[^>]*>/g, '');

// --- SRT / VTT ---

const TIME_LINE = /(\d{1,2}:)?\d{1,2}:\d{1,2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{1,2}[.,]\d{1,3}/;

export function parseSubs(raw) {
  const blocks = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const ti = lines.findIndex(l => TIME_LINE.test(l));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->').map(s => s.trim().split(/\s+/)[0]);
    const start = parseTime(a), end = parseTime(b);
    if (start == null || end == null) continue;
    const text = lines.slice(ti + 1).join('\n')
      .replace(/<\d{1,2}:\d{2}[:.\d]*>/g, '')         // таймкоды караоке из VTT
      .replace(/<\/?(c|v|lang|ruby|rt)[^>]*>/gi, '')  // VTT-классы
      .trim();
    cues.push({ start, end, text });
  }
  return cues;
}

export function toSRT(cues, field) {
  let n = 0;
  return cues
    .filter(c => plainText(c[field]).trim())
    .map(c => {
      const text = c[field].replace(/<\/?font[^>]*>/gi, '').trim(); // YouTube в SRT понимает только b/i/u
      return `${++n}\n${fmtTime(c.start, ',')} --> ${fmtTime(c.end, ',')}\n${text}\n`;
    })
    .join('\n');
}

// --- YTT (srv3) ---

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const alpha = pct => Math.round(Math.max(0, Math.min(100, pct)) / 100 * 254); // 255 YouTube считает «по умолчанию»

export function cuePosition(cue, style) {
  return cue.pos || { ap: style.ap, ah: style.ah, av: style.av };
}

export function toYTT(cues, styles, field, fallbackStyle) {
  const pens = new Map(), wps = new Map(), wss = new Map();
  const idOf = (map, key) => { if (!map.has(key)) map.set(key, map.size + 1); return map.get(key); };

  const penFor = (st, span) => {
    const a = [];
    if (st.bold || span.b) a.push('b="1"');
    if (st.italic || span.i) a.push('i="1"');
    if (st.underline || span.u) a.push('u="1"');
    a.push(`fc="${span.color || st.color}"`, `fo="${alpha(st.opacity)}"`);
    a.push(`bc="${st.bg}"`, `bo="${alpha(st.bgOpacity)}"`);
    if (+st.edge) a.push(`ec="${st.edgeColor}"`, `et="${+st.edge}"`);
    if (+st.font) a.push(`fs="${+st.font}"`);
    if (+st.size !== 100) a.push(`sz="${Math.round(+st.size)}"`);
    return idOf(pens, a.join(' '));
  };

  const body = [];
  for (const c of cues) {
    if (!plainText(c[field]).trim()) continue;
    const st = styles[c.style] || styles[fallbackStyle] || Object.values(styles)[0];
    const pos = cuePosition(c, st);
    const wp = idOf(wps, `ap="${pos.ap}" ah="${Math.round(pos.ah)}" av="${Math.round(pos.av)}"`);
    const ws = idOf(wss, `ju="${st.align}"`);
    const spans = parseSpans(c[field].trim());
    const sIds = spans.map(s => penFor(st, s));
    const inner = spans.map((s, k) => `<s p="${sIds[k]}">${esc(s.text)}</s>`).join('');
    const t = Math.round(c.start * 1000), d = Math.max(1, Math.round((c.end - c.start) * 1000));
    body.push(`<p t="${t}" d="${d}" wp="${wp}" ws="${ws}" p="${sIds[0]}">${inner}</p>`);
  }

  const head = [
    '<pen id="0"/>', '<wp id="0" ap="7" ah="50" av="100"/>', '<ws id="0" ju="2"/>',
    ...[...pens].map(([k, id]) => `<pen id="${id}" ${k}/>`),
    ...[...wps].map(([k, id]) => `<wp id="${id}" ${k}/>`),
    ...[...wss].map(([k, id]) => `<ws id="${id}" ${k}/>`),
  ];
  return `<?xml version="1.0" encoding="utf-8"?>\n<timedtext format="3">\n<head>\n${head.join('\n')}\n</head>\n<body>\n${body.join('\n')}\n</body>\n</timedtext>\n`;
}

// --- шрифты и обводки YouTube ---

export const FONTS = [
  { id: 0, name: 'По умолчанию (Roboto)', css: 'Roboto, Arial, sans-serif' },
  { id: 4, name: 'Roboto', css: 'Roboto, Arial, sans-serif' },
  { id: 1, name: 'Courier New', css: '"Courier New", monospace' },
  { id: 2, name: 'Times New Roman', css: '"Times New Roman", serif' },
  { id: 3, name: 'Lucida Console', css: '"Lucida Console", monospace' },
  { id: 5, name: 'Comic Sans', css: '"Comic Sans MS", cursive' },
  { id: 6, name: 'Monotype Corsiva', css: '"Monotype Corsiva", "Segoe Script", cursive' },
  { id: 7, name: 'Капитель (Carrois Gothic SC)', css: '"Carrois Gothic SC", sans-serif', smallCaps: true },
];

export const EDGES = [
  { id: 0, name: 'Нет' },
  { id: 3, name: 'Обводка' },
  { id: 1, name: 'Жёсткая тень' },
  { id: 4, name: 'Мягкая тень' },
  { id: 2, name: 'Объём (bevel)' },
];

export function edgeShadow(edge, color, px) {
  const p = Math.max(1, px);
  switch (+edge) {
    case 1: return `${p * 1.5}px ${p * 1.5}px 0 ${color}`;
    case 2: return `${p}px ${p}px 0 ${color}, -${p * 0.5}px -${p * 0.5}px 0 rgba(255,255,255,.5)`;
    case 3: return [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]
      .map(([x, y]) => `${x * p}px ${y * p}px ${p}px ${color}`).join(', ');
    case 4: return `${p * 1.5}px ${p * 1.5}px ${p * 3}px ${color}`;
    default: return 'none';
  }
}

export function rgba(hex, pct) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${pct / 100})`;
}

// --- ASS: для вшивания сабов в видео (ffmpeg + libass) ---
// Размеры и позиции считаются так же, как в предпросмотре на видео, чтобы результат совпал с тем, что видно в редакторе.

export const PREVIEW_EM = 0.045; // размер шрифта при 100% — доля высоты кадра
const ASS_FONTS = {
  0: 'Roboto', 4: 'Roboto', 1: 'Courier New', 2: 'Times New Roman', 3: 'Lucida Console', 5: 'Comic Sans MS',
  6: 'Monotype Corsiva', 7: 'Carrois Gothic SC',
};
const AN = [7, 8, 9, 4, 5, 6, 1, 2, 3]; // наши точки привязки 0..8 → \an (цифры как на нампаде)

function assColor(hex, opacityPct = 100, withAlpha = true) {
  const n = hex.replace('#', '');
  const bgr = n.slice(4, 6) + n.slice(2, 4) + n.slice(0, 2);
  const a = Math.round((100 - Math.max(0, Math.min(100, opacityPct))) / 100 * 255).toString(16).padStart(2, '0');
  return (withAlpha ? `&H${a}${bgr}` : `&H${bgr}&`).toUpperCase();
}
function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60;
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}
// фигурные скобки в ASS — служебные, а «\n» в тексте превратился бы в команду
const assText = s => s.replace(/\\/g, '\\​').replace(/{/g, '(').replace(/}/g, ')').replace(/\n/g, '\\N');

export function toASS(cues, styles, field, fallbackStyle, w, h, range = null) {
  const names = {};
  const styleLines = Object.entries(styles).map(([key, st], k) => {
    names[key] = 'S' + (k + 1);
    const fs = h * PREVIEW_EM * st.size / 100;
    const font = ASS_FONTS[+st.font] || 'Roboto';
    const size = Math.round(fs * (font === 'Roboto' ? 1.2 : 1.12)); // libass меряет кегль по высоте строки, а не em
    const text = assColor(st.color, st.opacity);
    let border = 1, outline = 0, shadow = 0, outCol = assColor(st.edgeColor, st.opacity), backCol = outCol;
    if (+st.bgOpacity > 0) { // плашка: в ASS её цвет — это OutlineColour
      border = 3; outline = fs * 0.2; outCol = assColor(st.bg, st.bgOpacity); backCol = outCol;
    } else if (+st.edge === 3) outline = fs / 14;
    else if (+st.edge === 1) shadow = fs / 12;
    else if (+st.edge === 4) { shadow = fs / 12; backCol = assColor(st.edgeColor, st.opacity * 0.5); }
    else if (+st.edge === 2) shadow = fs / 20;
    const margin = Math.round(w * 0.02);
    return `Style: ${names[key]},${font},${size},${text},${text},${outCol},${backCol},${st.bold ? -1 : 0},`
      + `${st.italic ? -1 : 0},${st.underline ? -1 : 0},0,100,100,0,0,${border},${outline.toFixed(1)},`
      + `${shadow.toFixed(1)},2,${margin},${margin},0,1`;
  });

  const events = [];
  const offset = range ? range.a : 0;
  for (const c of cues) {
    if (!plainText(c[field]).trim()) continue;
    if (range && (c.end <= range.a || c.start >= range.b)) continue;
    const key = styles[c.style] ? c.style : fallbackStyle in styles ? fallbackStyle : Object.keys(styles)[0];
    const st = styles[key];
    const pos = cuePosition(c, st);
    const x = (w * (2 + 0.96 * pos.ah) / 100).toFixed(1), y = (h * (2 + 0.96 * pos.av) / 100).toFixed(1);
    const body = parseSpans(c[field].trim()).map(s => {
      const tags = `\\b${st.bold || s.b ? 1 : 0}\\i${st.italic || s.i ? 1 : 0}\\u${st.underline || s.u ? 1 : 0}`
        + `\\1c${assColor(s.color || st.color, 100, false)}`;
      return `{${tags}}${assText(s.text)}`;
    }).join('');
    const a = Math.max(0, c.start - offset), b = Math.min(range ? range.b - offset : Infinity, c.end - offset);
    events.push(`Dialogue: 0,${assTime(a)},${assTime(b)},${names[key]},,0,0,0,,{\\an${AN[pos.ap]}\\pos(${x},${y})}${body}`);
  }

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLines.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
}
