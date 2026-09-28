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

/**
 * 비교용으로 글을 가지런히 합니다.
 * 줄 끝 공백, 빈 줄 개수, 보이지 않는 줄 구분자처럼
 * 사람이 보기에 같은 글이면 같은 모양이 되도록.
 */
export function canon(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{2,}/g, '\n')   // 빈 줄의 개수·위치 차이는 같은 글로 봅니다
    .trim();
}

/** 짧은 내용 지문. 공백 차이는 무시합니다. (c2: 는 이 방식의 표식) */
export function hashText(text) {
  let h = 0x811c9dc5;
  const t = canon(text);
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'c2:' + h.toString(36) + ':' + t.length;
}

/** 예전 방식으로 만든 지문은 믿지 않습니다 (비교 기준이 달라서) */
export const trustedHash = h => typeof h === 'string' && h.startsWith('c2:') ? h : null;

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
    syncedHash: null,  // 마지막으로 양쪽이 같았을 때의 본문 지문
    syncedBody: null,  // 그때의 본문 자체 (두 기기의 변경을 합칠 때 기준으로 씁니다)
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

/**
 * 한 번의 거래 안에서 가장 최신 기록을 읽고, 필요한 칸만 고쳐 씁니다.
 *
 * 편집 화면과 동기화가 같은 노트의 서로 다른 사본을 들고 있다가
 * 통째로 덮어쓰면, 한쪽이 적어 둔 내용을 다른 쪽이 지워 버립니다.
 * (충돌이 반복되던 진짜 원인) 그래서 모든 수정은 이 길로만 합니다.
 *
 * fn 은 최신 기록을 받아 고칩니다. false 를 돌려주면 쓰지 않습니다.
 * fn 안에서는 기다리는 일(await)을 하면 안 됩니다.
 */
export function updateNote(id, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const s = t.objectStore(STORE);
    let result = null;
    const req = s.get(id);
    req.onsuccess = () => {
      const rec = req.result;
      if (!rec) return;
      if (fn(rec) === false) { result = rec; return; }
      s.put(rec);
      result = rec;
    };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

/** 본문만 고칩니다. 동기화 기록(드라이브 id, 시각, 기준본)은 건드리지 않습니다. */
export async function saveBody(note, body) {
  const now = Date.now();
  const apply = r => {
    r.body = body;
    r.title = titleOf(body);
    r.tags = tagsOf(body);
    r.modified = now;
    r.dirty = 1;
  };
  const rec = await updateNote(note.id, apply);
  if (rec) Object.assign(note, rec);          // 들고 있던 사본도 최신으로
  else { apply(note); await putNote(note); }  // 아직 저장된 적 없는 새 노트
  return note;
}

/** 삭제는 무덤(tombstone)으로 남깁니다. 동기화가 끝나야 진짜 지웁니다. */
export async function trashNote(note) {
  const apply = r => {
    r.deleted = true;
    r.body = '';
    r.modified = Date.now();
    r.dirty = 1;
  };
  const rec = await updateNote(note.id, apply);
  if (rec) Object.assign(note, rec);
  else { apply(note); await putNote(note); }
  return note;
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
