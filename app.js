/* ─────────────────────────────────────────────
   app.js — 화면과 흐름
   원칙: 입력 → 즉시 로컬 저장. 동기화는 뒤에서.
   ───────────────────────────────────────────── */

import * as db from './db.js';
import * as drive from './drive.js';
import { render, splitFrontmatter } from './markdown.js';
import { exportMarkdown, exportDocx, printNote, exportAllZip } from './export.js';

const $ = id => document.getElementById(id);

const el = {
  app: $('app'), list: $('noteList'), search: $('search'), tagBar: $('tagBar'),
  editor: $('editor'), preview: $('preview'), empty: $('empty'), stamp: $('stamp'),
  syncDot: $('syncDot'), syncLabel: $('syncLabel'), toast: $('toast'),
  sheet: $('sheet'), moreMenu: $('moreMenu'),
};

let notes = [];
let current = null;
let query = '';
let activeTag = null;
let saveTimer = null;
let syncTimer = null;

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
    if (current && n.id === current.id) b.setAttribute('aria-current', 'true');

    const h = document.createElement('h4');
    h.textContent = n.title || '제목 없음';
    const p = document.createElement('p');
    p.textContent = db.excerptOf(n.body) || '내용 없음';
    const m = document.createElement('div');
    m.className = 'meta';
    if (n.dirty) { const dot = document.createElement('span'); dot.className = 'pending'; m.appendChild(dot); }
    m.appendChild(document.createTextNode(when(n.modified)));

    b.append(h, p, m);
    b.onclick = () => select(n.id);
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
  showEditor(true);
  drawList();
  if (!el.preview.hidden) el.preview.innerHTML = render(current.body);
  if (!window.matchMedia('(max-width: 760px)').matches) el.editor.focus();
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
  await db.trashNote(current);
  current = null;
  el.editor.value = '';
  showEditor(false);
  await reload();
  scheduleSync();
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
  const files = [...fileList].filter(f => /\.(md|markdown|txt)$/i.test(f.name));
  if (!files.length) { $('importMsg').textContent = '마크다운 파일을 찾지 못했습니다.'; return; }

  let n = 0;
  for (const f of files) {
    const text = await f.text();
    const { meta, body } = splitFrontmatter(text);
    const titleFromName = f.name.replace(/\.(md|markdown|txt)$/i, '');
    const hasHeading = /^\s*#{1,6}\s/.test(body.split('\n').find(l => l.trim()) || '');
    const full = hasHeading ? body : `# ${meta.title || titleFromName}\n\n${body}`;

    const note = db.newNote(full, {
      created: meta.created ? Date.parse(meta.created) || Date.now() : (f.lastModified || Date.now()),
      modified: meta.modified ? Date.parse(meta.modified) || Date.now() : (f.lastModified || Date.now()),
    });
    if (Array.isArray(meta.tags) && meta.tags.length) {
      note.tags = [...new Set([...note.tags, ...meta.tags.map(t => String(t).replace(/^#/, ''))])];
    } else if (typeof meta.tags === 'string' && meta.tags.trim()) {
      note.tags = [...new Set([...note.tags, ...meta.tags.split(/[,\s]+/).filter(Boolean).map(t => t.replace(/^#/, ''))])];
    }
    await db.putNote(note);
    n++;
  }
  $('importMsg').textContent = `${n}개를 가져왔습니다.`;
  await reload();
  scheduleSync(1500);
  toast(`${n}개 노트를 가져왔습니다`);
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

el.editor.addEventListener('input', queueSave);
el.editor.addEventListener('blur', flushSave);

el.search.addEventListener('input', e => { query = e.target.value; drawList(); });

$('btnNew').onclick = createNote;
$('btnNewEmpty').onclick = createNote;
$('btnBack').onclick = () => { flushSave(); el.app.dataset.view = 'list'; };

$('btnPreview').onclick = async e => {
  await flushSave();
  const on = el.preview.hidden;
  el.preview.hidden = !on;
  el.editor.hidden = on;
  e.currentTarget.setAttribute('aria-pressed', String(on));
  if (on && current) el.preview.innerHTML = render(current.body);
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
  if (act === 'md') exportMarkdown(current);
  if (act === 'docx') { exportDocx(current); toast('Word 파일을 내려받았습니다'); }
  if (act === 'pdf') printNote(current);
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
  if (e.key === 'Escape') {
    if (!el.sheet.hidden) el.sheet.hidden = true;
    else if (!el.moreMenu.hidden) el.moreMenu.hidden = true;
  }
});

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
