/* ─────────────────────────────────────────────
   merge.js — 두 기기의 변경을 합칩니다

   맥에서 첫 문단을, 갤럭시에서 마지막 문단을 고쳤다면
   둘 다 살려서 하나로 합칩니다. (애플 노트가 하는 일)

   기준본(마지막으로 두 기기가 같았던 글)과 비교해
   각자 어디를 고쳤는지 줄 단위로 찾아냅니다.
   같은 줄을 양쪽에서 다르게 고친 경우에만 합치지 못합니다.
   ───────────────────────────────────────────── */

const split = t => String(t || '')
  .replace(/\r\n?/g, '\n')
  .replace(/[\u2028\u2029]/g, '\n')
  .split('\n')
  .map(l => l.replace(/[ \t\u00a0]+$/, ''));

/**
 * a 의 각 줄이 b 의 몇 번째 줄과 짝인지 (가장 긴 공통 부분열).
 * 짝이 없으면 -1. 너무 크면 null.
 */
function matchLines(a, b) {
  const n = a.length, m = b.length;
  const map = new Array(n).fill(-1);

  // 앞뒤로 같은 부분은 바로 짝지어 계산을 줄입니다
  let p = 0;
  while (p < n && p < m && a[p] === b[p]) { map[p] = p; p++; }
  let q = 0;
  while (q < n - p && q < m - p && a[n - 1 - q] === b[m - 1 - q]) {
    map[n - 1 - q] = m - 1 - q; q++;
  }

  const A = a.slice(p, n - q), B = b.slice(p, m - q);
  const N = A.length, M = B.length;
  if (!N || !M) return map;
  if (N * M > 6_000_000) return null;   // 긴 글을 통째로 갈아엎은 경우

  const W = M + 1;
  const dp = new Uint32Array((N + 1) * W);
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      dp[i * W + j] = A[i] === B[j]
        ? dp[(i + 1) * W + j + 1] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < N && j < M) {
    if (A[i] === B[j]) { map[p + i] = p + j; i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++;
    else j++;
  }
  return map;
}

const same = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);

/**
 * @param base   마지막으로 두 기기가 같았던 글
 * @param mine   이 기기의 글
 * @param theirs 다른 기기의 글
 * @returns {{ok:true, text:string} | {ok:false}}
 */
export function merge3(base, mine, theirs) {
  const O = split(base), A = split(mine), B = split(theirs);
  const ma = matchLines(O, A), mb = matchLines(O, B);
  if (!ma || !mb) return { ok: false };

  const out = [];
  let oi = 0, ai = 0, bi = 0;

  // 기준본의 한 구간과, 그에 대응하는 양쪽 구간을 비교합니다
  const settle = (oEnd, aEnd, bEnd) => {
    const o = O.slice(oi, oEnd), a = A.slice(ai, aEnd), b = B.slice(bi, bEnd);
    if (same(a, o)) out.push(...b);          // 이쪽은 안 고침 → 저쪽 것
    else if (same(b, o)) out.push(...a);     // 저쪽은 안 고침 → 이쪽 것
    else if (same(a, b)) out.push(...a);     // 똑같이 고침
    else return false;                       // 같은 곳을 서로 다르게 고침
    return true;
  };

  for (let i = 0; i < O.length; i++) {
    const ja = ma[i], jb = mb[i];
    if (ja < 0 || jb < 0) continue;          // 어느 한쪽에서 바뀐 줄
    if (!settle(i, ja, jb)) return { ok: false };
    out.push(O[i]);                          // 양쪽 모두 그대로 둔 줄
    oi = i + 1; ai = ja + 1; bi = jb + 1;
  }
  if (!settle(O.length, A.length, B.length)) return { ok: false };

  return { ok: true, text: out.join('\n') };
}
