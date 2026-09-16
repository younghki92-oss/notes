/* ─────────────────────────────────────────────
   stats.js — 노트 분량 재기
   쪽수는 이 앱이 만드는 .docx 와 같은 판형으로 계산합니다.
   (A4, 위아래 여백 2.5cm, 좌우 2.25cm, 본문 11pt, 줄간격 1.2)
   Word 의 실제 줄바꿈과 완전히 같지는 않으므로 어림값입니다.
   ───────────────────────────────────────────── */

const PT = 20;                       // 1pt = 20 twips
const PAGE_H = (16838 - 1418 * 2) / PT;   // 본문 세로 700pt
const LINE_W = (11906 - 1276 * 2) / PT;   // 본문 가로 468pt

const BODY_PT = 11;
const LINE_H = BODY_PT * 1.5;        // 11pt 글자 + 줄간격 1.2 ≈ 16.5pt
const PARA_GAP = 6;                  // 문단 뒤 여백 6pt
const IMAGE_PT = 230;                // 그림 한 장을 대략 1/3쪽으로 봅니다

// 한글·한자·가나는 글자 하나가 영문 두 배 폭입니다.
const WIDE = /[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFF60]/;

function widthUnits(text, sizePt = BODY_PT) {
  let u = 0;
  for (const ch of text) {
    if (ch === '\t') u += 4;
    else if (WIDE.test(ch)) u += 1;
    else u += 0.5;
  }
  return u * (sizePt / BODY_PT);
}

/** 한 문단이 차지하는 세로 높이(pt) */
function paraHeight(text, sizePt = BODY_PT, indentPt = 0) {
  const perLine = Math.max(8, (LINE_W - indentPt) / sizePt);
  const lines = Math.max(1, Math.ceil(widthUnits(text, sizePt) / perLine));
  return lines * (sizePt * 1.5) + PARA_GAP;
}

/**
 * @returns {{chars:number, charsNoSpace:number, words:number,
 *            pages:number, minutes:number, images:number}}
 */
export function measure(body, { wordsPerMinuteChars = 300 } = {}) {
  const src = String(body || '').replace(/\r\n?/g, '\n');

  // 글자·단어는 마크다운 기호를 뺀 실제 읽을 글자 기준
  const plain = src
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')       // 그림
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // 링크는 글자만
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>~]/g, '');

  const chars = plain.replace(/\s/g, '').length;
  const charsWithSpace = plain.length;
  const words = (plain.trim().match(/[^\s]+/g) || []).length;
  const images = (src.match(/!\[[^\]]*\]\([^)]*\)/g) || []).length;

  // 쪽수: 문단별로 쌓아 올립니다
  let height = 0;
  const lines = src.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      i++;
      let n = 0;
      while (i < lines.length && !/^```/.test(lines[i])) { n++; i++; }
      i++;
      height += n * (9.5 * 1.5) + PARA_GAP;
      continue;
    }

    if (!line.trim()) { i++; continue; }

    const onlyImage = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line);
    if (onlyImage) { height += IMAGE_PT + PARA_GAP; i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const sz = [20, 16, 13.5, 12, 11, 11][h[1].length - 1] || 11;
      height += 13 + paraHeight(h[2], sz);   // 제목 위 여백 포함
      i++; continue;
    }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      height += paraHeight(li[3], BODY_PT, 15 + Math.floor(li[1].length / 2) * 15) - PARA_GAP + 3;
      i++; continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      height += paraHeight(buf.join(' '), BODY_PT, 21);
      continue;
    }

    const buf = [lines[i++]];   // 최소 한 줄은 반드시 소비합니다 (무한 반복 방지)
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+[.)])\s|\s*!\[)/.test(lines[i])) buf.push(lines[i++]);
    height += paraHeight(buf.join(' '));
  }

  const pages = height <= 0 ? 0 : Math.max(0.1, height / PAGE_H);
  const minutes = chars / wordsPerMinuteChars;

  return {
    chars,
    charsWithSpace,
    words,
    images,
    pages: Math.round(pages * 10) / 10,
    minutes: Math.round(minutes),
  };
}

const n = x => x.toLocaleString('ko-KR');

/** 좁은 화면용 짧은 표시 */
export function shortLabel(m) {
  if (!m.chars && !m.images) return '';
  return `${m.pages}쪽 · ${m.minutes}분`;
}

/** 넓은 화면·자세히 보기용 */
export function fullLabel(m) {
  if (!m.chars && !m.images) return '';
  const parts = [
    `${n(m.chars)}자`,
    `${n(m.words)}단어`,
    `${m.pages}쪽`,
    `약 ${m.minutes}분`,
  ];
  if (m.images) parts.push(`그림 ${m.images}`);
  return parts.join(' · ');
}
