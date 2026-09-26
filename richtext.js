/* ─────────────────────────────────────────────
   richtext.js — 보이는 대로 쓰는 편집기의 속살

   화면에서는 서식이 입혀진 모습으로 다루고,
   저장은 계속 마크다운(.md)으로 합니다.
   그래야 드라이브의 파일이 그대로 남고,
   나중에 다른 앱으로 옮겨도 글이 살아 있습니다.
   ───────────────────────────────────────────── */

/** 애플 노트가 섞어 넣는 보이지 않는 줄 구분자(U+2028/U+2029)를 정상 줄바꿈으로 */
export const normalizeText = t => String(t || '')
  .replace(/\r\n?/g, '\n')
  .replace(/[\u2028\u2029]/g, '\n')
  .replace(/\u0000/g, '');

const TAG_RE = /(^|[\s(\[{"'])#([\p{L}\p{N}_/-]{1,50})(?![\p{L}\p{N}_/-])/gu;

/* ── 1. 편집기 HTML → 마크다운 ────────────────── */

const esc = s => s.replace(/([*_`~=])/g, '\\$1');

function inlineToMd(node) {
  let out = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) { out += n.nodeValue; continue; }
    if (n.nodeType !== 1) continue;

    const tag = n.tagName;
    const inner = () => inlineToMd(n);

    if (tag === 'BR') { out += '\n'; continue; }
    if (tag === 'IMG') {
      const id = n.dataset.att;
      const alt = n.getAttribute('alt') || '';
      out += id ? `![${alt}](att:${id})` : `![${alt}](${n.getAttribute('src') || ''})`;
      continue;
    }
    if (tag === 'INPUT') continue;   // 체크박스는 줄 단위에서 다룹니다

    const t = inner();
    if (!t.trim() && tag !== 'A') { out += t; continue; }

    switch (tag) {
      case 'STRONG': case 'B': out += `**${t}**`; break;
      case 'EM': case 'I': out += `*${t}*`; break;
      case 'U': out += `<u>${t}</u>`; break;
      case 'MARK': out += `==${t}==`; break;
      case 'DEL': case 'S': case 'STRIKE': out += `~~${t}~~`; break;
      case 'CODE': out += `\`${t}\``; break;
      case 'A': out += `[${t}](${n.getAttribute('href') || ''})`; break;
      default: out += t;
    }
  }
  return out;
}

function blockToMd(el, depth = 0) {
  const tag = el.tagName;

  if (tag === 'HR') return '---';
  if (/^H[1-6]$/.test(tag)) {
    const lv = Number(tag[1]);
    return '#'.repeat(lv) + ' ' + inlineToMd(el).trim();
  }
  if (tag === 'BLOCKQUOTE') {
    return inlineToMd(el).split('\n').map(l => '> ' + l).join('\n');
  }
  if (tag === 'PRE') {
    return '```\n' + (el.textContent || '') + '\n```';
  }
  if (tag === 'UL' || tag === 'OL') {
    const lines = [];
    let i = Number(el.getAttribute('start')) || 1;
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      const box = li.querySelector(':scope > input[type="checkbox"]');
      const pad = '  '.repeat(depth);
      const body = inlineToMd(li).trim();
      if (box) lines.push(`${pad}- [${box.checked ? 'x' : ' '}] ${body}`);
      else if (tag === 'OL') lines.push(`${pad}${i++}. ${body}`);
      else lines.push(`${pad}- ${body}`);
      for (const sub of li.children) {
        if (sub.tagName === 'UL' || sub.tagName === 'OL') lines.push(blockToMd(sub, depth + 1));
      }
    }
    return lines.join('\n');
  }
  // P, DIV, 그 밖의 모든 것
  return inlineToMd(el);
}

/** 편집기 안의 내용을 마크다운 글로 바꿉니다. */
export function htmlToMarkdown(root) {
  const parts = [];
  for (const node of root.childNodes) {
    if (node.nodeType === 3) {
      const t = node.nodeValue;
      if (t.trim()) parts.push(t);
      continue;
    }
    if (node.nodeType !== 1) continue;
    if (node.tagName === 'BR') { parts.push(''); continue; }
    parts.push(blockToMd(node));
  }

  return normalizeText(parts.join('\n\n'))
    .replace(/\u00a0/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/* ── 2. 마크다운 → 편집기 HTML ────────────────── */

const h = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function mdInline(text, attUrls) {
  let t = h(text);
  t = t.replace(/\\([*_`~=])/g, '$1');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
    if (url.startsWith('att:')) {
      const id = url.slice(4);
      const src = attUrls?.get(id);
      return src
        ? `<img src="${src}" data-att="${id}" alt="${alt}">`
        : `<span class="img-missing" data-att="${id}">그림 없음</span>`;
    }
    return `<img src="${url}" alt="${alt}">`;
  });
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  t = t.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<u>$1</u>');
  t = t.replace(TAG_RE, (m, p, tag) =>
    /^\d+$/.test(tag) ? m : `${p}<span class="tag">#${tag}</span>`);
  return t || '<br>';
}

/** 저장된 마크다운을 편집기에 넣을 HTML 로 바꿉니다. */
export function markdownToHtml(md, attUrls) {
  const lines = normalizeText(md).split('\n');
  const out = [];
  let i = 0;
  let stuck = 0, last = -1;

  while (i < lines.length) {
    // 안전장치: 어떤 줄에서도 제자리걸음 하지 않도록
    if (i === last) { if (++stuck > 2) { i++; stuck = 0; continue; } } else { stuck = 0; last = i; }
    const line = lines[i];

    if (/^```/.test(line)) {
      i++;
      const buf = [];
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre>${h(buf.join('\n'))}</pre>`);
      continue;
    }

    if (!line.trim()) { i++; continue; }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    const hd = line.match(/^(#{1,6})\s+(.*)$/);
    if (hd) {
      const lv = Math.min(hd[1].length, 6);
      out.push(`<h${lv}>${mdInline(hd[2], attUrls)}</h${lv}>`);
      i++; continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${mdInline(buf.join('\n'), attUrls).replace(/\n/g, '<br>')}</blockquote>`);
      continue;
    }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const ordered = /^\d/.test(li[2]);
      const startNum = ordered ? (parseInt(li[2], 10) || 1) : 1;
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m || (/^\d/.test(m[2])) !== ordered) break;
        let body = m[3];
        const cb = body.match(/^\[([ xX])\]\s*(.*)$/);
        if (cb) {
          const on = cb[1].toLowerCase() === 'x';
          items.push(`<li class="todo"><input type="checkbox"${on ? ' checked' : ''}>`
            + `<span>${mdInline(cb[2], attUrls)}</span></li>`);
        } else {
          items.push(`<li>${mdInline(body, attUrls)}</li>`);
        }
        i++;
      }
      out.push(ordered
        ? `<ol start="${startNum}">${items.join('')}</ol>`
        : `<ul>${items.join('')}</ul>`);
      continue;
    }

    const buf = [];
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${mdInline(buf.join('\n'), attUrls).replace(/\n/g, '<br>')}</p>`);
  }

  return out.join('') || '<p><br></p>';
}

/* ── 3. 쓰는 도중 태그에 색 입히기 ──────────────── */

/**
 * 커서 바로 앞에 완성된 #태그가 있으면 색을 입힙니다.
 * 스페이스나 엔터를 친 순간에만 부르므로 커서가 흔들리지 않습니다.
 */
export function highlightTagAtCaret(root) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== 3) return;
  if (node.parentElement?.closest('.tag')) return;

  const text = node.nodeValue || '';
  const upto = text.slice(0, range.startOffset);
  const m = upto.match(/(^|[\s(\[{"'])#([\p{L}\p{N}_/-]{1,50})[\s]$/u);
  if (!m || /^\d+$/.test(m[2])) return;

  const tagText = '#' + m[2];
  const start = upto.length - tagText.length - 1;   // 끝의 공백 한 칸 제외
  if (start < 0) return;

  const after = node.splitText(start);
  after.splitText(tagText.length);

  const span = document.createElement('span');
  span.className = 'tag';
  span.textContent = tagText;
  after.parentNode.replaceChild(span, after);

  // 커서를 태그 뒤로 옮깁니다
  const r = document.createRange();
  r.setStartAfter(span);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}
