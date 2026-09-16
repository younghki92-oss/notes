/* ─────────────────────────────────────────────
   db.js — 로컬 저장소 (IndexedDB)
   기기의 이 데이터가 원본입니다. 드라이브는 사본입니다.
   ───────────────────────────────────────────── */

const DB_NAME = 'notes-app';
const DB_VER = 2;
const STORE = 'notes';
const META = 'meta';
const FILES = 'files';   // 노트에 딸린 이미지

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('modified', 'modified');
        s.createIndex('dirty', 'dirty');
        s.createIndex('driveId', 'driveId');
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(FILES)) {
        const f = db.createObjectStore(FILES, { keyPath: 'id' });
        f.createIndex('noteId', 'noteId');
        f.createIndex('dirty', 'dirty');
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/* ── 본문에서 끌어내는 값들 ──────────────────── */

export function titleOf(body) {
  const line = (body || '').split('\n').find(l => l.trim().length);
  if (!line) return '제목 없음';
  return line.replace(/^#{1,6}\s*/, '').replace(/[*_`>]/g, '').trim().slice(0, 120) || '제목 없음';
}

// 한글·영문·숫자·밑줄·하이픈을 태그 글자로 봅니다.
const TAG_RE = /(^|[\s(\[{"'])#([\p{L}\p{N}_/-]{1,50})/gu;

export function tagsOf(body) {
  const out = new Set();
  for (const m of (body || '').matchAll(TAG_RE)) {
    const t = m[2];
    // 마크다운 제목(# 다음 공백)은 위 정규식에서 이미 걸러집니다.
    if (t && !/^\d+$/.test(t)) out.add(t);
  }
  return [...out];
}

export function excerptOf(body) {
  const lines = (body || '').split('\n');
  const first = lines.findIndex(l => l.trim().length);
  return lines.slice(first + 1).join(' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '🖼 ')
    .replace(/[#*_`>[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

/* ── CRUD ──────────────────────────────────── */

export function newNote(body = '', extra = {}) {
  const now = Date.now();
  return {
    id: uid(),
    body,
    title: titleOf(body),
    tags: tagsOf(body),
    created: now,
    modified: now,
    deleted: false,
    dirty: 1,          // 1 = 드라이브에 올려야 함
    driveId: null,     // 드라이브 파일 id
    driveTime: null,   // 마지막으로 맞춘 원격 modifiedTime
    ...extra,
  };
}

export const allNotes = () => tx(STORE, 'readonly', s => s.getAll())
  .then(rows => rows.filter(n => !n.deleted).sort((a, b) => b.modified - a.modified));

export const allRows = () => tx(STORE, 'readonly', s => s.getAll());

export const getNote = id => tx(STORE, 'readonly', s => s.get(id));

export function putNote(note) {
  return tx(STORE, 'readwrite', s => s.put(note)).then(() => note);
}

export function saveBody(note, body) {
  note.body = body;
  note.title = titleOf(body);
  note.tags = tagsOf(body);
  note.modified = Date.now();
  note.dirty = 1;
  return putNote(note);
}

/** 삭제는 무덤(tombstone)으로 남깁니다. 동기화가 끝나야 진짜 지웁니다. */
export function trashNote(note) {
  note.deleted = true;
  note.body = '';
  note.modified = Date.now();
  note.dirty = 1;
  return putNote(note);
}

export const purge = id => tx(STORE, 'readwrite', s => s.delete(id));

export const dirtyNotes = () => allRows().then(rows => rows.filter(n => n.dirty));

/* ── 이미지 첨부 ───────────────────────────── */

/** 본문에서 att:xxxx 형태로 참조합니다. 실제 그림은 여기 따로 둡니다. */
export function newAttachment(blob, name, noteId) {
  return {
    id: uid(),
    name: name || 'image',
    type: blob.type || 'image/png',
    blob,
    noteId: noteId || null,
    created: Date.now(),
    dirty: 1,
    driveId: null,
    deleted: false,
  };
}

export const putFile = f => tx(FILES, 'readwrite', s => s.put(f)).then(() => f);
export const getFile = id => tx(FILES, 'readonly', s => s.get(id));
export const allFiles = () => tx(FILES, 'readonly', s => s.getAll());
export const purgeFile = id => tx(FILES, 'readwrite', s => s.delete(id));
export const dirtyFiles = () => allFiles().then(rows => rows.filter(f => f.dirty && !f.deleted));

/** 본문이 참조하는 첨부 id 목록 */
export function attachmentIds(body) {
  return [...new Set([...String(body || '').matchAll(/\(att:([A-Za-z0-9-]+)\)/g)].map(m => m[1]))];
}

/* ── 메타(토큰·폴더 id 등) ──────────────────── */

export const metaGet = key => tx(META, 'readonly', s => s.get(key)).then(r => (r ? r.value : null));
export const metaSet = (key, value) => tx(META, 'readwrite', s => s.put({ key, value }));

/* ── 저장 공간 ─────────────────────────────── */

export async function requestPersist() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

export async function storageInfo() {
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  let usage = 0, quota = 0;
  if (navigator.storage?.estimate) ({ usage = 0, quota = 0 } = await navigator.storage.estimate());
  return { persisted, usage, quota };
}
