/* ─────────────────────────────────────────────
   export.js — 마크다운 / Word(.docx) / PDF
   외부 라이브러리 없이 .docx(=zip)를 직접 만듭니다.
   ───────────────────────────────────────────── */

import { render, esc, buildFrontmatter } from './markdown.js';

/* ── 내려받기 도우미 ────────────────────────── */

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function safeName(s, fallback = 'note') {
  const t = String(s || '').replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
  return (t || fallback).slice(0, 80);
}

/* ── 1. 마크다운 ───────────────────────────── */

export function exportMarkdown(note, withFrontmatter = true) {
  const text = (withFrontmatter ? buildFrontmatter(note) : '') + note.body;
  download(new Blob([text], { type: 'text/markdown;charset=utf-8' }), `${safeName(note.title)}.md`);
}

/* ── 2. PDF (브라우저 인쇄) ─────────────────── */

export function printNote(note) {
  const area = document.getElementById('printArea');
  const when = new Date(note.modified).toLocaleString('ko-KR');
  area.innerHTML =
    `<h1>${esc(note.title || '제목 없음')}</h1>` +
    `<div class="print-meta">${esc(when)}${note.tags?.length ? ' · ' + note.tags.map(t => '#' + esc(t)).join(' ') : ''}</div>` +
    render(stripFirstHeading(note.body, note.title));
  const done = () => { area.innerHTML = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

// 제목이 본문 첫 줄에서 나온 것이면 본문에서 한 번 더 찍지 않습니다.
function stripFirstHeading(body, title) {
  const lines = String(body || '').split('\n');
  const idx = lines.findIndex(l => l.trim().length);
  if (idx < 0) return body;
  const bare = lines[idx].replace(/^#{1,6}\s*/, '').replace(/[*_`>]/g, '').trim();
  if (bare && bare === String(title || '').trim()) return lines.slice(idx + 1).join('\n');
  return body;
}

/* ── 3. DOCX ───────────────────────────────── */

const X = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** 인라인 마크다운 → Word 런(run) 목록 */
function runs(text, base = {}) {
  const parts = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*|~~[^~]+~~)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ t: text.slice(last, m.index), ...base });
    const tok = m[0];
    if (tok.startsWith('**')) parts.push({ t: tok.slice(2, -2), ...base, b: true });
    else if (tok.startsWith('~~')) parts.push({ t: tok.slice(2, -2), ...base, strike: true });
    else if (tok.startsWith('`')) parts.push({ t: tok.slice(1, -1), ...base, mono: true });
    else parts.push({ t: tok.slice(1, -1), ...base, i: true });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ t: text.slice(last), ...base });
  if (!parts.length) parts.push({ t: '', ...base });

  return parts.map(p => {
    const rPr = [];
    if (p.b) rPr.push('<w:b/>');
    if (p.i) rPr.push('<w:i/>');
    if (p.strike) rPr.push('<w:strike/>');
    if (p.mono) rPr.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="D2Coding"/>');
    if (p.sz) rPr.push(`<w:sz w:val="${p.sz}"/><w:szCs w:val="${p.sz}"/>`);
    if (p.color) rPr.push(`<w:color w:val="${p.color}"/>`);
    const props = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';
    return `<w:r>${props}<w:t xml:space="preserve">${X(p.t)}</w:t></w:r>`;
  }).join('');
}

function para(inner, { indent = 0, spaceBefore = 0, spaceAfter = 120, align } = {}) {
  const pPr = [];
  if (indent) pPr.push(`<w:ind w:left="${indent}"/>`);
  pPr.push(`<w:spacing w:before="${spaceBefore}" w:after="${spaceAfter}" w:line="288" w:lineRule="auto"/>`);
  if (align) pPr.push(`<w:jc w:val="${align}"/>`);
  return `<w:p><w:pPr>${pPr.join('')}</w:pPr>${inner}</w:p>`;
}

/** 마크다운 본문 → document.xml 의 본문 조각 */
function mdToWordBody(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      i++;
      const buf = [];
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      for (const l of buf) out.push(para(runs(l, { mono: true, sz: 19 }), { indent: 360, spaceAfter: 0 }));
      out.push(para('', { spaceAfter: 120 }));
      continue;
    }

    if (!line.trim()) { i++; continue; }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(`<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>`);
      i++; continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      const sz = [40, 32, 27, 24, 22, 22][lv - 1] || 22;
      out.push(para(runs(h[2], { b: true, sz }), { spaceBefore: 260, spaceAfter: 110 }));
      i++; continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(para(runs(buf.join(' '), { i: true, color: '555555' }), { indent: 420 }));
      continue;
    }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const depth = Math.floor(li[1].length / 2);
      const marker = /^\d/.test(li[2]) ? li[2] + ' ' : '• ';
      let txt = li[3].replace(/^\[([ xX])\]\s+/, (_, c) => (c.toLowerCase() === 'x' ? '☑ ' : '☐ '));
      out.push(para(runs(marker + txt), { indent: 300 + depth * 300, spaceAfter: 60 }));
      i++; continue;
    }

    const buf = [];
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) buf.push(lines[i++]);
    out.push(para(runs(buf.join(' '))));
  }

  return out.join('');
}

function docxXml(note) {
  const when = new Date(note.modified).toLocaleString('ko-KR');
  const metaLine = when + (note.tags?.length ? ' · ' + note.tags.map(t => '#' + t).join(' ') : '');
  const head =
    para(runs(note.title || '제목 없음', { b: true, sz: 40 }), { spaceAfter: 60 }) +
    para(runs(metaLine, { sz: 17, color: '777777' }), { spaceAfter: 300 });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${head}${mdToWordBody(stripFirstHeading(note.body, note.title))}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1276" w:bottom="1418" w:left="1276" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;
}

export function exportDocx(note) {
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    'word/document.xml': docxXml(note),
  };
  const blob = zipStore(files,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  download(blob, `${safeName(note.title)}.docx`);
}

/* ── 최소 ZIP 작성기 (무압축 store) ─────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/** { 경로: 문자열 } 을 ZIP Blob 으로. 무압축이라 짧고 안전합니다. */
export function zipStore(files, mimeType = 'application/zip') {
  const enc = new TextEncoder();
  const { time, date } = dosTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const crc = crc32(data);

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0x0800, true);      // UTF-8 이름 플래그
    lv.setUint16(8, 0, true);           // 무압축
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);

    locals.push(lh, data);
    centrals.push(cd);
    offset += lh.length + data.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...locals, ...centrals, eocd], { type: mimeType });
}

/* ── 전체 백업 (.zip 안에 .md 여럿) ─────────── */

export function exportAllZip(notes) {
  const files = {};
  const used = new Set();
  for (const n of notes) {
    let name = safeName(n.title) + '.md';
    let k = 2;
    while (used.has(name)) name = `${safeName(n.title)} (${k++}).md`;
    used.add(name);
    files[name] = buildFrontmatter(n) + n.body;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  download(zipStore(files), `노트-백업-${stamp}.zip`);
}
