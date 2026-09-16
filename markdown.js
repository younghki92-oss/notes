/* ─────────────────────────────────────────────
   markdown.js — 외부 라이브러리 없는 소형 렌더러
   미리보기와 인쇄(PDF)에 함께 씁니다.
   ───────────────────────────────────────────── */

export const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => `<img src="${u}" alt="${a}">`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, a, u) => `<a href="${u}" rel="noopener" target="_blank">${a}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // 해시태그
  t = t.replace(/(^|[\s(\["'])#([\p{L}\p{N}_/-]{1,50})/gu, (m, p, tag) =>
    /^\d+$/.test(tag) ? m : `${p}<span class="tag">#${tag}</span>`);
  return t;
}

/** 마크다운 → HTML 문자열 */
export function render(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const closeList = stack => { while (stack.length) out.push(`</${stack.pop()}>`); };
  const listStack = [];

  while (i < lines.length) {
    const line = lines[i];

    // 코드 블록
    if (/^```/.test(line)) {
      closeList(listStack);
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 빈 줄
    if (!line.trim()) { closeList(listStack); i++; continue; }

    // 수평선
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList(listStack); out.push('<hr>'); i++; continue;
    }

    // 제목
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList(listStack);
      const lv = Math.min(h[1].length, 6);
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      i++; continue;
    }

    // 인용
    if (/^\s*>\s?/.test(line)) {
      closeList(listStack);
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // 목록 (체크박스 포함)
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const kind = /^\d/.test(li[2]) ? 'ol' : 'ul';
      if (listStack[listStack.length - 1] !== kind) { closeList(listStack); listStack.push(kind); out.push(`<${kind}>`); }
      let txt = li[3];
      const cb = txt.match(/^\[([ xX])\]\s+(.*)$/);
      if (cb) {
        const on = cb[1].toLowerCase() === 'x';
        txt = `<input type="checkbox" disabled${on ? ' checked' : ''}> ${inline(cb[2])}`;
        out.push(`<li style="list-style:none;margin-left:-1.2em">${txt}</li>`);
      } else {
        out.push(`<li>${inline(txt)}</li>`);
      }
      i++; continue;
    }

    // 문단
    closeList(listStack);
    const buf = [];
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }

  closeList(listStack);
  return out.join('\n');
}

/* ── YAML 앞머리 ────────────────────────────── */

/** `---` 로 감싼 앞머리를 떼어내고 {meta, body} 로 돌려줍니다. */
export function splitFrontmatter(text) {
  const t = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = t.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: t };
  const meta = {};
  for (const raw of m[1].split('\n')) {
    const kv = raw.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim().replace(/^["']|["']$/g, '');
    if (/^\[.*\]$/.test(v)) {
      v = v.slice(1, -1).split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    meta[kv[1].toLowerCase()] = v;
  }
  return { meta, body: t.slice(m[0].length) };
}

export function buildFrontmatter(note) {
  const iso = ms => new Date(ms).toISOString();
  const tags = (note.tags || []).map(t => `"${t}"`).join(', ');
  return [
    '---',
    `id: ${note.id}`,
    `title: ${JSON.stringify(note.title || '')}`,
    `created: ${iso(note.created)}`,
    `modified: ${iso(note.modified)}`,
    `tags: [${tags}]`,
    '---',
    '',
  ].join('\n');
}
