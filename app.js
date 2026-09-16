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
  $('selBar').hidden = !on;
  $('btnSelect').setAttribute('aria-pressed', String(on));
  drawSelCount();
  drawList();
}

function drawSelCount() {
  $('selCount').textContent = `${selected.size}개 선택`;
  $('selDelete').disabled = selected.size === 0;
  const rows = visible();
  $('selAll').textContent =
    rows.length && rows.every(n => selected.has(n.id)) ? '선택 해제' : '전체 선택';
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

function showEditor(on) {
  el.empty.hidden = on;
  el.editor.hidden = !on;
  if (!on) { el.preview.hidden = true; $('btnPreview').setAttribute('aria-pressed', 'false'); }
  if (window.matchMedia('(max-width: 760px)').matches) {
    el.app.dataset.view = on ? 'editor' : 'list';
  }
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
  if (!window.matchMedia('(max-width: 760px)').matches) el.editor.focus();
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
    $('syncMsg').textContent = e.message;
  } finally {
    await updateSyncBadge();
  }
}

/* ── 가져오기 ─────────────────────────────── */

async function importFiles(fileList) {
  const all = [...fileList];
  const mdFiles = all.filter(f => /\.(md|markdown|txt)$/i.test(f.name));
  const imgFiles = all.filter(f => /\.(png|jpe?g|gif|webp|heic|tiff?)$/i.test(f.name));

  if (!mdFiles.length) { $('importMsg').textContent = '마크다운 파일을 찾지 못했습니다.'; return; }

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
  let done = 0, attached = 0, missing = 0;

  for (const f of mdFiles) {
    msg.textContent = `가져오는 중… ${done + 1} / ${mdFiles.length}`;

    const text = await f.text();
    const { meta, body } = splitFrontmatter(text);
    const titleFromName = f.name.replace(/\.(md|markdown|txt)$/i, '');
    const firstLine = body.split('\n').find(l => l.trim()) || '';
    const hasHeading = /^\s*#{1,6}\s/.test(firstLine);
    let full = hasHeading ? body : `# ${meta.title || titleFromName}\n\n${body}`;

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

  msg.textContent = `노트 ${done}개, 그림 ${attached}장을 가져왔습니다.`
    + (missing ? ` 그림 ${missing}장은 파일을 찾지 못했습니다 — 폴더째 고르셨는지 확인해 주세요.` : '');
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
  $('clientId').value = drive.getClientId();
  $('folderName').value = drive.getFolderName();
  $('syncMsg').textContent = drive.state.lastError || (drive.wasConnected() ? '연결되어 있습니다.' : '');
  el.sheet.hidden = false;
  const { persisted, usage, quota } = await db.storageInfo();
  const mb = b => (b / 1048576).toFixed(1) + 'MB';
  $('storageMsg').textContent =
    `${persisted ? '보호됨' : '보호 안 됨'} · 사용 ${mb(usage)} / 가용 ${mb(quota)} · 노트 ${notes.length}개`;
}

/* ── 이벤트 ───────────────────────────────── */

el.stats.onclick = () => { statsFull = !statsFull; drawStats(); };

// 그림 붙여넣기
el.editor.addEventListener('paste', e => {
  const imgs = [...(e.clipboardData?.files || [])].filter(f => /^image\//.test(f.type));
  if (!imgs.length) return;
  e.preventDefault();
  insertImages(imgs);
});

el.editor.addEventListener('input', queueSave);
el.editor.addEventListener('blur', flushSave);

el.search.addEventListener('input', e => {
  query = e.target.value;
  drawList();
  if (selectMode) drawSelCount();
});

$('btnNew').onclick = createNote;
$('btnNewEmpty').onclick = createNote;
$('fab').onclick = createNote;

$('btnSelect').onclick = () => setSelectMode(!selectMode);
$('selCancel').onclick = () => setSelectMode(false);

$('selAll').onclick = () => {
  const rows = visible();
  if (rows.length && rows.every(n => selected.has(n.id))) selected.clear();
  else rows.forEach(n => selected.add(n.id));
  drawSelCount();
  drawList();
};

$('selDelete').onclick = async () => {
  const ids = [...selected];
  if (!ids.length) return;
  if (!confirm(`노트 ${ids.length}개를 삭제할까요? 딸린 그림도 함께 지워집니다.`)) return;
  const n = ids.length;
  setSelectMode(false);
  await removeNotes(ids);
  toast(`${n}개를 삭제했습니다`);
};
$('btnBack').onclick = () => { flushSave(); el.app.dataset.view = 'list'; };

$('btnPreview').onclick = async e => {
  await flushSave();
  const on = el.preview.hidden;
  el.preview.hidden = !on;
  el.editor.hidden = on;
  e.currentTarget.setAttribute('aria-pressed', String(on));
  if (on && current) el.preview.innerHTML = await renderBody(current.body);
};

$('btnMore').onclick = e => {
  const open = el.moreMenu.hidden;
  el.moreMenu.hidden = !open;
  e.currentTarget.setAttribute('aria-expanded', String(open));
};
document.addEventListener('click', e => {
  if (!e.target.closest('.menu-wrap')) {
    el.moreMenu.hidden = true;
    $('btnMore').setAttribute('aria-expanded', 'false');
  }
});
el.moreMenu.addEventListener('click', async e => {
  const act = e.target.dataset.act;
  if (!act) return;
  el.moreMenu.hidden = true;
  await flushSave();
  if (!current) return toast('노트를 먼저 고르세요');
  if (act === 'image') { $('imgInput').click(); return; }
  if (act === 'md') exportMarkdown(current);
  if (act === 'docx') {
    toast('Word 파일을 만드는 중…');
    exportDocx(current, await attachmentBytes(current.body));
    toast('Word 파일을 내려받았습니다');
  }
  if (act === 'pdf') { setAttachmentUrls(await urlsFor(current.body)); printNote(current); }
  if (act === 'delete') deleteCurrent();
});

$('btnSync').onclick = () => runSync(true);
$('btnSettings').onclick = openSheet;
$('btnCloseSheet').onclick = () => { el.sheet.hidden = true; };
el.sheet.addEventListener('click', e => { if (e.target === el.sheet) el.sheet.hidden = true; });

$('clientId').addEventListener('change', e => drive.setClientId(e.target.value));
$('folderName').addEventListener('change', e => drive.setFolderName(e.target.value));

$('btnConnect').onclick = async () => {
  drive.setClientId($('clientId').value);
  drive.setFolderName($('folderName').value);
  $('syncMsg').textContent = '연결 중…';
  try {
    await drive.auth(true);
    $('syncMsg').textContent = '연결됐습니다. 첫 동기화를 시작합니다.';
    await runSync(true);
    $('syncMsg').textContent = drive.state.lastError || '동기화 완료.';
  } catch (e) {
    $('syncMsg').textContent = e.message;
  }
};

$('btnDisconnect').onclick = () => {
  drive.disconnect();
  $('syncMsg').textContent = '연결을 끊었습니다. 노트는 이 기기에 그대로 있습니다.';
  updateSyncBadge();
};

$('btnImportFiles').onclick = () => $('fileInput').click();
$('btnImportDir').onclick = () => $('dirInput').click();
$('fileInput').onchange = e => importFiles(e.target.files);
$('imgInput').onchange = e => { insertImages(e.target.files); e.target.value = ''; };
$('dirInput').onchange = e => importFiles(e.target.files);

$('btnPersist').onclick = async () => {
  const ok = await db.requestPersist();
  toast(ok ? '이제 브라우저가 이 데이터를 함부로 지우지 않습니다' : '브라우저가 거절했습니다. 홈 화면에 설치하면 승인될 확률이 높습니다');
  openSheet();
};

$('btnBackup').onclick = async () => {
  const all = await db.allNotes();
  if (!all.length) return toast('내보낼 노트가 없습니다');
  exportAllZip(all);
};

document.addEventListener('keydown', e => {
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === 'n') { e.preventDefault(); createNote(); }
  if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); el.search.focus(); el.search.select(); }
  if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); flushSave().then(() => runSync(true)); }
  if (selectMode && (e.key === 'Delete' || e.key === 'Backspace')
      && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    $('selDelete').click();
  }
  if (meta && e.key.toLowerCase() === 'a' && selectMode
      && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    $('selAll').click();
  }
  if (e.key === 'Escape') {
    if (!el.sheet.hidden) el.sheet.hidden = true;
    else if (!el.moreMenu.hidden) el.moreMenu.hidden = true;
    else if (selectMode) setSelectMode(false);
  }
});

// 폴드를 접고 펼 때 한 화면/두 화면 배치를 다시 맞춥니다.
const narrowQuery = window.matchMedia('(max-width: 760px)');
function fitLayout() {
  if (narrowQuery.matches) {
    if (!el.app.dataset.view) el.app.dataset.view = current ? 'editor' : 'list';
  } else {
    delete el.app.dataset.view;
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
  if (!window.matchMedia('(max-width: 760px)').matches && notes.length) await select(notes[0].id);

  if (drive.wasConnected()) scheduleSync(1500);
  updateSyncBadge();

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch {}
  }
})();
