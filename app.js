/* ─────────────────────────────────────────────
   app.js — 화면과 흐름
   원칙: 입력 → 즉시 로컬 저장. 동기화는 뒤에서.
   ───────────────────────────────────────────── */

import * as db from './db.js';
import * as drive from './drive.js';
import { render, splitFrontmatter, setAttachmentUrls } from './markdown.js';
import { measure, shortLabel, fullLabel } from './stats.js';
import { exportMarkdown, exportDocx, printNote, exportAllZip } from './export.js';

const $ = id => document.getElementById(id);

/* ── 문제가 생기면 화면에 보여 줍니다 ─────────
   (버튼이 조용히 먹통이 되는 것보다 낫습니다) */

const BUILD = 'v13';
const missingIds = [];

/** styles.css 가 같은 버전인지 확인합니다. 파일이 섞여 올라간 걸 잡아냅니다. */
function checkBuild() {
  const css = getComputedStyle(document.documentElement)
    .getPropertyValue('--build').replace(/['"\s]/g, '');
  if (css !== BUILD) {
    banner(`styles.css 가 최신이 아닙니다 (화면 ${css || '없음'} / 코드 ${BUILD}). `
      + '모든 파일을 다시 올리고 캐시를 비워 주세요. — 눌러서 닫기');
    return false;
  }
  return true;
}

function banner(text) {
  let b = $('banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'banner';
    b.className = 'banner';
    document.body.appendChild(b);
    b.onclick = () => b.remove();
  }
  b.textContent = text;
}

/** 요소가 없어도 조용히 넘어가는 속성 설정 */
function setProp(id, prop, value) {
  const node = $(id);
  if (node) node[prop] = value;
  return value;
}

/** 요소가 없어도 나머지 기능은 살아 있도록 연결합니다. */
function on(id, event, handler) {
  const node = $(id);
  if (!node) { missingIds.push(id); return null; }
  node.addEventListener(event, handler);
  return node;
}

window.addEventListener('error', e => {
  banner('문제가 생겼습니다: ' + (e.message || '알 수 없는 오류') + ' — 눌러서 닫기');
});
window.addEventListener('unhandledrejection', e => {
  banner('문제가 생겼습니다: ' + (e.reason?.message || e.reason) + ' — 눌러서 닫기');
});

const el = {
  app: $('app'), list: $('noteList'), search: $('search'), tagBar: $('tagBar'),
  editor: $('editor'), preview: $('preview'), empty: $('empty'), stamp: $('stamp'),
  syncDot: $('syncDot'), syncLabel: $('syncLabel'), toast: $('toast'),
  sheet: $('sheet'), moreMenu: $('moreMenu'), stats: $('stats'),
};

let notes = [];
let current = null;
let query = '';
let activeTag = null;
let saveTimer = null;
let statsFull = false;
let selectMode = false;
const selected = new Set();
let syncTimer = null;

/* ── 첨부 이미지 ───────────────────────────── */

const attUrlCache = new Map();   // 첨부 id → blob 주소

async function urlsFor(body) {
  const ids = db.attachmentIds(body);
  for (const id of ids) {
    if (attUrlCache.has(id)) continue;
    const f = await db.getFile(id);
    if (f && f.blob) attUrlCache.set(id, URL.createObjectURL(f.blob));
  }
  return attUrlCache;
}

async function renderBody(body) {
  setAttachmentUrls(await urlsFor(body));
  return render(body);
}

/* ── 공통 ──────────────────────────────────── */

let toastTimer = null;
function toast(msg, ms = 2400) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}

function when(ms) {
  const d = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 60_000) return '방금';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}분 전`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (ms >= today.getTime()) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === new Date().getFullYear())
    return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
}

/* ── 목록 ──────────────────────────────────── */

function visible() {
  const q = query.trim().toLowerCase();
  return notes.filter(n => {
    if (activeTag && !(n.tags || []).includes(activeTag)) return false;
    if (!q) return true;
    return (n.title + '\n' + n.body).toLowerCase().includes(q);
  });
}

function setSelectMode(on) {
  selectMode = on;
  if (!on) selected.clear();
  el.app.dataset.select = on ? 'on' : '';
  setProp('selBar', 'hidden', !on);
  $('btnSelect')?.setAttribute('aria-pressed', String(on));
  drawSelCount();
  drawList();
}

function drawSelCount() {
  setProp('selCount', 'textContent', `${selected.size}개 선택`);
  setProp('selDelete', 'disabled', selected.size === 0);
  const rows = visible();
  setProp('selAll', 'textContent',
    rows.length && rows.every(n => selected.has(n.id)) ? '선택 해제' : '전체 선택');
}

/** 노트와 딸린 그림을 지웁니다. 드라이브를 쓰면 무덤으로 남겨 나중에 정리합니다. */
async function removeNotes(ids) {
  const linked = drive.wasConnected();
  for (const id of ids) {
    const n = await db.getNote(id);
    if (!n) continue;
    if (linked) {
      await db.trashNote(n);
    } else {
      for (const att of (await db.allFiles()).filter(a => a.noteId === id)) {
        attUrlCache.delete(att.id);
        await db.purgeFile(att.id);
      }
      await db.purge(id);
    }
    if (current && current.id === id) {
      current = null;
      el.editor.value = '';
      showEditor(false);
    }
  }
  await reload();
  if (linked) scheduleSync(800);
}

function drawTags() {
  const count = new Map();
  for (const n of notes) for (const t of n.tags || []) count.set(t, (count.get(t) || 0) + 1);
  const sorted = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
  el.tagBar.innerHTML = '';
  for (const [tag, c] of sorted.slice(0, 40)) {
    const b = document.createElement('button');
    b.className = 'tag-chip';
    b.type = 'button';
    b.textContent = `#${tag} ${c}`;
    b.setAttribute('aria-pressed', String(activeTag === tag));
    b.onclick = () => { activeTag = activeTag === tag ? null : tag; drawTags(); drawList(); };
    el.tagBar.appendChild(b);
  }
}

function drawList() {
  const rows = visible();
  el.list.innerHTML = '';

  if (!rows.length) {
    const d = document.createElement('div');
    d.className = 'list-empty';
    d.textContent = notes.length
      ? '조건에 맞는 노트가 없습니다.'
      : '아직 노트가 없습니다. 오른쪽 위 + 로 시작하세요.';
    el.list.appendChild(d);
    return;
  }

  for (const n of rows) {
    const b = document.createElement('button');
    b.className = 'note-item';
    b.type = 'button';
    b.setAttribute('role', 'listitem');
    if (current && n.id === current.id && !selectMode) b.setAttribute('aria-current', 'true');

    if (selectMode) {
      b.dataset.checked = String(selected.has(n.id));
      const c = document.createElement('span');
      c.className = 'check';
      b.appendChild(c);
    }

    const h = document.createElement('h4');
    h.textContent = n.title || '제목 없음';
    const p = document.createElement('p');
    p.textContent = db.excerptOf(n.body) || '내용 없음';
    const m = document.createElement('div');
    m.className = 'meta';
    if (n.dirty) { const dot = document.createElement('span'); dot.className = 'pending'; m.appendChild(dot); }
    m.appendChild(document.createTextNode(when(n.modified)));

    b.append(h, p, m);

    b.onclick = () => {
      if (!selectMode) return select(n.id);
      if (selected.has(n.id)) selected.delete(n.id); else selected.add(n.id);
      b.dataset.checked = String(selected.has(n.id));
      drawSelCount();
    };

    // 길게 누르면 선택 모드로 들어갑니다 (애플 노트와 같은 방식)
    let hold = null;
    const startHold = () => {
      hold = setTimeout(() => {
        hold = null;
        if (!selectMode) { selected.add(n.id); setSelectMode(true); }
      }, 480);
    };
    const cancelHold = () => { clearTimeout(hold); hold = null; };
    b.addEventListener('touchstart', startHold, { passive: true });
    b.addEventListener('touchend', cancelHold);
    b.addEventListener('touchmove', cancelHold);
    b.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (!selectMode) { selected.add(n.id); setSelectMode(true); }
    });

    el.list.appendChild(b);
  }
}

async function reload() {
  notes = await db.allNotes();
  drawTags();
  drawList();
  updateSyncBadge();
}

/* ── 편집 ──────────────────────────────────── */

const narrowQuery = window.matchMedia('(max-width: 640px)');

/** 지금 화면이 좁은가 (한 번에 한 칸만 보여야 하는가) */
const isNarrow = () => narrowQuery.matches;

/**
 * 화면 배치를 정합니다. 'both' | 'list' | 'editor'
 * 좁은 화면에서는 both 를 쓰지 않습니다.
 */
function setPane(mode) {
  let m = mode;
  if (isNarrow() && m === 'both') m = current ? 'editor' : 'list';
  if (!isNarrow() && m === 'list') m = 'both';
  if (m === 'editor' && !current) m = isNarrow() ? 'list' : 'both';
  el.app.dataset.pane = m;
  const showing = m !== 'list';
  $('btnBack')?.setAttribute('aria-pressed', String(m === 'both'));
  return m;
}

const pane = () => el.app.dataset.pane || 'both';

/** 목록 보이기/숨기기 (애플 노트의 사이드바 버튼과 같은 역할) */
function toggleList() {
  flushSave();
  if (isNarrow()) {
    setPane(pane() === 'list' ? 'editor' : 'list');
  } else {
    setPane(pane() === 'both' ? 'editor' : 'both');
  }
}

function showEditor(on) {
  el.empty.hidden = on;
  el.editor.hidden = !on;
  if (!on) {
    el.preview.hidden = true;
    $('btnPreview')?.setAttribute('aria-pressed', 'false');
  }
  if (on) setPane(isNarrow() ? 'editor' : 'both');
  else setPane(isNarrow() ? 'list' : 'both');
}

async function select(id) {
  await flushSave();
  current = await db.getNote(id);
  if (!current) return;
  el.editor.value = current.body;
  el.stamp.textContent = when(current.modified);
  drawStats();
  showEditor(true);
  drawList();
  if (!el.preview.hidden) el.preview.innerHTML = await renderBody(current.body);
  if (!isNarrow()) el.editor.focus();
}

function drawStats() {
  if (!current) { el.stats.textContent = ''; return; }
  const m = measure(current.body);
  const full = fullLabel(m);
  el.stats.textContent = statsFull ? full : shortLabel(m);
  el.stats.title = full ? full + ' (이 앱이 만드는 Word 판형 기준 어림값)' : '';
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (!current) return;
  const body = el.editor.value;
  if (body === current.body) return;
  await db.saveBody(current, body);
  el.stamp.textContent = when(current.modified);
  drawStats();
  await reload();
  scheduleSync();
}

async function createNote() {
  await flushSave();
  const n = db.newNote('');
  await db.putNote(n);
  await reload();
  await select(n.id);
  el.editor.focus();
}

async function deleteCurrent() {
  if (!current) return;
  if (!confirm(`"${current.title}" 을(를) 삭제할까요? 드라이브에서도 지워집니다.`)) return;
  await removeNotes([current.id]);
  toast('삭제했습니다');
}

/* ── 동기화 ───────────────────────────────── */

function setDot(stateName, label) {
  el.syncDot.dataset.state = stateName;
  el.syncLabel.textContent = label;
}

async function updateSyncBadge() {
  if (drive.state.syncing) return setDot('syncing', '동기화 중');
  if (!drive.wasConnected()) return setDot('off', '연결 안 됨');
  if (drive.state.needsReconnect) return setDot('error', '눌러서 재연결');
  if (drive.state.lastError) return setDot('error', '동기화 실패');
  const pending = (await db.dirtyNotes()).length;
  if (!navigator.onLine) return setDot('pending', pending ? `대기 ${pending}` : '오프라인');
  if (pending) return setDot('pending', `대기 ${pending}`);
  const last = drive.state.lastSync || (await db.metaGet('lastSync'));
  setDot('ok', last ? `동기화 ${when(last)}` : '연결됨');
}

function scheduleSync(delay = 4000) {
  if (!drive.wasConnected()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(false), delay);
  updateSyncBadge();
}

async function runSync(interactive) {
  if (!drive.wasConnected() && !interactive) return;
  try {
    await updateSyncBadge();
    const r = await drive.sync({ interactive });
    if (!r) return;
    await reload();
    if (r.conflicts) toast(`충돌 ${r.conflicts}건 — 사본을 따로 만들어 두었습니다`, 5000);
    else if (interactive) toast(`올림 ${r.pushed} · 내림 ${r.pulled}`);
  } catch (e) {
    if (interactive) toast(e.message, 4000);
    setProp('syncMsg', 'textContent', e.message);
  } finally {
    await updateSyncBadge();
  }
}

/* ── 가져오기 ─────────────────────────────── */

async function importFiles(fileList) {
  const all = [...fileList];
  const mdFiles = all.filter(f => /\.(md|markdown|txt)$/i.test(f.name));
  const imgFiles = all.filter(f => /\.(png|jpe?g|gif|webp|heic|tiff?)$/i.test(f.name));

  if (!mdFiles.length) { setProp('importMsg', 'textContent', '마크다운 파일을 찾지 못했습니다.'); return; }

  // 그림을 경로와 파일이름 두 가지로 찾을 수 있게 정리해 둡니다.
  const byPath = new Map();
  const byName = new Map();
  for (const f of imgFiles) {
    const rel = (f.webkitRelativePath || f.name).replace(/^\.?\//, '');
    byPath.set(rel, f);
    byPath.set(rel.split('/').slice(1).join('/'), f);   // 최상위 폴더 이름을 뺀 경로
    byName.set(f.name, f);
  }

  const msg = $('importMsg');
  let done = 0, attached = 0, missing = 0, cleanedLines = 0;

  for (const f of mdFiles) {
    msg.textContent = `가져오는 중… ${done + 1} / ${mdFiles.length}`;

    const text = await f.text();
    const { meta, body } = splitFrontmatter(text);
    const titleFromName = f.name.replace(/\.(md|markdown|txt)$/i, '');
    const firstLine = body.split('\n').find(l => l.trim()) || '';
    const hasHeading = /^\s*#{1,6}\s/.test(firstLine);
    let full = hasHeading ? body : `# ${meta.title || titleFromName}\n\n${body}`;

    if ($('cleanOnImport')?.checked !== false) {
      const c = cleanAppleExport(full);
      full = c.text;
      cleanedLines += c.removed;
    }

    const noteId = db.uid();
    const dir = (f.webkitRelativePath || '').split('/').slice(0, -1).join('/');

    // 본문이 가리키는 그림을 찾아 앱 안으로 옮기고, 참조를 바꿔 줍니다.
    const refs = [...full.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)];
    for (const [whole, alt, rawUrl] of refs) {
      if (/^(https?:|data:|att:)/i.test(rawUrl)) continue;
      const url = decodeURIComponent(rawUrl);
      const base = url.split('/').pop();
      const file =
        byPath.get(dir ? `${dir}/${url}` : url) ||
        byPath.get(url) ||
        byPath.get(dir ? `${dir}/${url}`.split('/').slice(1).join('/') : url) ||
        byName.get(base);

      if (!file) { missing++; continue; }
      const att = db.newAttachment(file, file.name, noteId);
      await db.putFile(att);
      full = full.replace(whole, `![${alt || file.name}](att:${att.id})`);
      attached++;
    }

    const note = db.newNote(full, {
      id: noteId,
      created: meta.created ? Date.parse(meta.created) || Date.now() : (f.lastModified || Date.now()),
      modified: meta.modified ? Date.parse(meta.modified) || Date.now() : (f.lastModified || Date.now()),
    });
    if (Array.isArray(meta.tags) && meta.tags.length) {
      note.tags = [...new Set([...note.tags, ...meta.tags.map(t => String(t).replace(/^#/, ''))])];
    } else if (typeof meta.tags === 'string' && meta.tags.trim()) {
      note.tags = [...new Set([...note.tags, ...meta.tags.split(/[,\s]+/).filter(Boolean).map(t => t.replace(/^#/, ''))])];
    }
    await db.putNote(note);
    done++;
  }

  setProp('importMsg', 'textContent',
    `노트 ${done}개, 그림 ${attached}장을 가져왔습니다.`
    + (cleanedLines ? ` 애플 내보내기 오류로 중복된 ${cleanedLines.toLocaleString('ko-KR')}줄을 정리했습니다.` : '')
    + (missing ? ` 그림 ${missing}장은 파일을 찾지 못했습니다 — 폴더째 고르셨는지 확인해 주세요.` : ''));
  await reload();
  scheduleSync(1500);
  toast(`노트 ${done}개를 가져왔습니다`);
}

/* ── 이미지 넣기 ───────────────────────────── */

async function insertImages(fileList) {
  if (!current) return toast('노트를 먼저 고르세요');
  await flushSave();
  let md = '';
  for (const f of fileList) {
    if (!/^image\//.test(f.type)) continue;
    const att = db.newAttachment(f, f.name, current.id);
    await db.putFile(att);
    md += `\n\n![${f.name}](att:${att.id})\n`;
  }
  if (!md) return;
  const pos = el.editor.selectionStart ?? el.editor.value.length;
  el.editor.value = el.editor.value.slice(0, pos) + md + el.editor.value.slice(pos);
  await flushSave();
  if (!el.preview.hidden) el.preview.innerHTML = await renderBody(current.body);
  scheduleSync(1200);
  toast('그림을 넣었습니다');
}

/**
 * 연달아 똑같이 반복된 줄을 한 번만 남깁니다.
 * (붙여서 반복된 것만 지웁니다. 떨어져 있는 같은 문장은 건드리지 않습니다.)
 */
function dedupeLines(body) {
  const lines = String(body || '').split('\n');
  const out = [];
  let removed = 0;
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (line.trim() && prev !== undefined && prev.trim() === line.trim()) { removed++; continue; }
    out.push(line);
  }
  return { text: out.join('\n'), removed };
}

/**
 * 애플 노트의 마크다운 내보내기 오류를 바로잡습니다.
 * 애플이 같은 줄을 제각각 여러 번 써 내보내는 문제가 있어,
 * 붙어서 반복된 줄을 한 번만 남기고 군더더기를 정리합니다.
 */
function cleanAppleExport(text) {
  const { text: deduped, removed } = dedupeLines(text);
  const cleaned = deduped
    .split('\n')
    .map(l => (/^\s*#+\s*$/.test(l) ? '' : l))   // 내용 없는 제목 줄 제거
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n');              // 지나친 빈 줄 줄이기
  return { text: cleaned, removed };
}

async function dedupeCurrent() {
  if (!current) return;
  const { text, removed } = cleanAppleExport(current.body);
  if (!removed) return toast('반복된 줄이 없습니다');
  if (!confirm(`연달아 반복된 줄 ${removed}개를 지웁니다. 계속할까요?`)) return;
  el.editor.value = text;
  await flushSave();
  if (!el.preview.hidden) el.preview.innerHTML = await renderBody(current.body);
  toast(`${removed}줄을 정리했습니다`);
}

/** Word 내보내기에 넣을 그림들을 준비합니다. */
async function attachmentBytes(body) {
  const out = new Map();
  for (const id of db.attachmentIds(body)) {
    const f = await db.getFile(id);
    if (!f || !f.blob) continue;
    let w = 0, h = 0;
    try {
      const bmp = await createImageBitmap(f.blob);
      w = bmp.width; h = bmp.height;
      bmp.close?.();
    } catch {}
    out.set(id, {
      bytes: new Uint8Array(await f.blob.arrayBuffer()),
      type: f.type || f.blob.type || 'image/png',
      name: f.name, w, h,
    });
  }
  return out;
}

/* ── 설정 시트 ────────────────────────────── */

async function openSheet() {
  setProp('clientId', 'value', drive.getClientId());
  setProp('folderName', 'value', drive.getFolderName());
  setProp('syncMsg', 'textContent', drive.state.lastError || (drive.wasConnected() ? '연결되어 있습니다.' : ''));
  el.sheet.hidden = false;
  const { persisted, usage, quota } = await db.storageInfo();
  const mb = b => (b / 1048576).toFixed(1) + 'MB';
  const cssBuild = getComputedStyle(document.documentElement)
    .getPropertyValue('--build').replace(/['"\s]/g, '') || '없음';
  setProp('storageMsg', 'textContent',
    `버전 ${BUILD} (화면 ${cssBuild}) · ${persisted ? '보호됨' : '보호 안 됨'}`
    + ` · 사용 ${mb(usage)} / 가용 ${mb(quota)} · 노트 ${notes.length}개`);
}

/* ── 이벤트 ───────────────────────────────── */

on('stats', 'click', () => { statsFull = !statsFull; drawStats(); });

// 그림 붙여넣기
on('editor', 'paste', e => {
  const imgs = [...(e.clipboardData?.files || [])].filter(f => /^image\//.test(f.type));
  if (!imgs.length) return;
  e.preventDefault();
  insertImages(imgs);
});

on('editor', 'input', queueSave);
on('editor', 'blur', flushSave);

on('search', 'input', e => {
  query = e.target.value;
  drawList();
  if (selectMode) drawSelCount();
});

on('btnNew', 'click', createNote);
on('btnNewEmpty', 'click', createNote);
on('fab', 'click', createNote);

on('btnSelect', 'click', () => setSelectMode(!selectMode));
on('selCancel', 'click', () => setSelectMode(false));

on('selAll', 'click', () => {
  const rows = visible();
  if (rows.length && rows.every(n => selected.has(n.id))) selected.clear();
  else rows.forEach(n => selected.add(n.id));
  drawSelCount();
  drawList();
});

on('selDelete', 'click', async () => {
  const ids = [...selected];
  if (!ids.length) return;
  if (!confirm(`노트 ${ids.length}개를 삭제할까요? 딸린 그림도 함께 지워집니다.`)) return;
  const n = ids.length;
  setSelectMode(false);
  await removeNotes(ids);
  toast(`${n}개를 삭제했습니다`);
});
on('btnBack', 'click', toggleList);

on('btnPreview', 'click', async e => {
  await flushSave();
  const on = el.preview.hidden;
  el.preview.hidden = !on;
  el.editor.hidden = on;
  e.currentTarget.setAttribute('aria-pressed', String(on));
  if (on && current) el.preview.innerHTML = await renderBody(current.body);
});

on('btnMore', 'click', e => {
  const open = el.moreMenu.hidden;
  el.moreMenu.hidden = !open;
  e.currentTarget.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', e => {
  if (!e.target.closest('.menu-wrap')) {
    el.moreMenu.hidden = true;
    $('btnMore')?.setAttribute('aria-expanded', 'false');
  }
});
on('moreMenu', 'click', async e => {
  const act = e.target.dataset.act;
  if (!act) return;
  el.moreMenu.hidden = true;
  await flushSave();
  if (!current) return toast('노트를 먼저 고르세요');
  if (act === 'image') { $('imgInput')?.click(); return; }
  if (act === 'dedupe') { dedupeCurrent(); return; }
  if (act === 'md') exportMarkdown(current);
  if (act === 'docx') {
    toast('Word 파일을 만드는 중…');
    exportDocx(current, await attachmentBytes(current.body));
    toast('Word 파일을 내려받았습니다');
  }
  if (act === 'pdf') { setAttachmentUrls(await urlsFor(current.body)); printNote(current); }
  if (act === 'delete') deleteCurrent();
});

on('btnSync', 'click', () => runSync(true));
on('btnSettings', 'click', openSheet);
on('btnCloseSheet', 'click', () => { el.sheet.hidden = true; });
on('sheet', 'click', e => { if (e.target === el.sheet) el.sheet.hidden = true; });

on('clientId', 'change', e => drive.setClientId(e.target.value));
on('folderName', 'change', e => drive.setFolderName(e.target.value));

on('btnConnect', 'click', async () => {
  drive.setClientId($('clientId')?.value);
  drive.setFolderName($('folderName')?.value);
  setProp('syncMsg', 'textContent', '연결 중…');
  try {
    await drive.auth(true);
    setProp('syncMsg', 'textContent', '연결됐습니다. 첫 동기화를 시작합니다.');
    await runSync(true);
    setProp('syncMsg', 'textContent', drive.state.lastError || '동기화 완료.');
  } catch (e) {
    setProp('syncMsg', 'textContent', e.message);
  }
});

on('btnDisconnect', 'click', () => {
  drive.disconnect();
  setProp('syncMsg', 'textContent', '연결을 끊었습니다. 노트는 이 기기에 그대로 있습니다.');
  updateSyncBadge();
});

on('btnImportFiles', 'click', () => $('fileInput')?.click());
on('btnImportDir', 'click', () => $('dirInput')?.click());
on('fileInput', 'change', e => importFiles(e.target.files));
on('imgInput', 'change', e => { insertImages(e.target.files); e.target.value = ''; });
on('dirInput', 'change', e => importFiles(e.target.files));

on('btnPersist', 'click', async () => {
  const ok = await db.requestPersist();
  toast(ok ? '이제 브라우저가 이 데이터를 함부로 지우지 않습니다' : '브라우저가 거절했습니다. 홈 화면에 설치하면 승인될 확률이 높습니다');
  openSheet();
});

on('btnWipe', 'click', async () => {
  if (!confirm('모든 노트를 지웁니다. 되돌릴 수 없습니다. 계속할까요?')) return;
  if (!confirm('정말 지울까요? 백업을 받아 두셨는지 다시 한 번 확인해 주세요.')) return;

  const msg = $('wipeMsg');
  setProp('wipeMsg', 'textContent', '지우는 중…');

  try {
    if (drive.wasConnected()) {
      const n = await drive.wipeRemote();
      setProp('wipeMsg', 'textContent', `드라이브에서 ${n}개를 지웠습니다. 이 기기를 정리하는 중…`);
    }
    for (const row of await db.allRows()) await db.purge(row.id);
    for (const f of await db.allFiles()) await db.purgeFile(f.id);
    attUrlCache.clear();
    current = null;
    el.editor.value = '';
    showEditor(false);
    await reload();
    setProp('wipeMsg', 'textContent', '모두 지웠습니다. 이제 다시 가져오시면 됩니다.');
    toast('모든 노트를 지웠습니다');
  } catch (e) {
    setProp('wipeMsg', 'textContent', '문제가 생겼습니다: ' + e.message);
  }
});

on('btnBackup', 'click', async () => {
  const all = await db.allNotes();
  if (!all.length) return toast('내보낼 노트가 없습니다');
  exportAllZip(all);
});

document.addEventListener('keydown', e => {
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === 'n') { e.preventDefault(); createNote(); }
  if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); el.search.focus(); el.search.select(); }
  if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); flushSave().then(() => runSync(true)); }
  if (selectMode && (e.key === 'Delete' || e.key === 'Backspace')
      && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    $('selDelete')?.click();
  }
  if (meta && e.key.toLowerCase() === 'a' && selectMode
      && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    $('selAll')?.click();
  }
  if (e.key === 'Escape') {
    if (!el.sheet.hidden) el.sheet.hidden = true;
    else if (!el.moreMenu.hidden) el.moreMenu.hidden = true;
    else if (selectMode) setSelectMode(false);
  }
});

// 폴드를 접고 펼 때 배치를 다시 맞춥니다.
function fitLayout() {
  if (isNarrow()) {
    if (pane() === 'both') setPane(current ? 'editor' : 'list');
  } else {
    if (pane() === 'list') setPane('both');
    if (!current && notes.length) select(notes[0].id);
  }
}
narrowQuery.addEventListener('change', fitLayout);
window.addEventListener('resize', fitLayout);

window.addEventListener('online', () => { updateSyncBadge(); scheduleSync(800); });
window.addEventListener('offline', updateSyncBadge);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleSync(600);
  else flushSave();
});
window.addEventListener('pagehide', () => { if (current && el.editor.value !== current.body) db.saveBody(current, el.editor.value); });

setInterval(() => { if (document.visibilityState === 'visible') scheduleSync(0); }, 180_000);

/* ── 시작 ─────────────────────────────────── */

(async function start() {
  checkBuild();
  if (missingIds.length) {
    banner('화면 구성요소를 찾지 못했습니다 (' + missingIds.slice(0, 4).join(', ')
      + '). 파일 일부만 올라간 상태로 보입니다. 모든 파일을 다시 올려 주세요. — 눌러서 닫기');
  }
  await db.requestPersist();
  await reload();

  if (!notes.length) {
    await db.putNote(db.newNote(
`# 시작하기

이 노트는 지워도 됩니다.

첫 줄이 곧 제목입니다. 본문 아무 데나 #태그 를 적으면 왼쪽 위에 모입니다. #예시

- 쓰는 즉시 이 기기에 저장됩니다. 비행기 모드에서도 됩니다.
- 구글 드라이브를 연결하면 뒤에서 조용히 올라갑니다. 설정에서 연결하세요.
- 오른쪽 위 점 세 개로 Word, PDF, 마크다운으로 내보낼 수 있습니다.

**굵게**, *기울임*, \`코드\`, > 인용, 목록 모두 마크다운 그대로 씁니다.`));
    await reload();
  }

  showEditor(false);
  setPane(isNarrow() ? 'list' : 'both');
  if (!isNarrow() && notes.length) await select(notes[0].id);

  if (drive.wasConnected()) scheduleSync(1500);
  updateSyncBadge();

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch {}
  }
})();
