/* ─────────────────────────────────────────────
   drive.js — 구글 드라이브 동기화
   · 범위는 drive.file 하나뿐입니다. 이 앱이 만든 파일만 봅니다.
   · 노트 하나 = 드라이브의 .md 파일 하나.
   · 충돌이 나면 절대 덮어쓰지 않고 사본을 하나 더 만듭니다.
   ───────────────────────────────────────────── */

import * as db from './db.js';
import { buildFrontmatter, splitFrontmatter } from './markdown.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const TOKEN_KEY = 'gdrive_token';

function loadToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (t && t.access_token && t.expires_at > Date.now() + 120_000) return t;
  } catch {}
  return null;
}
function saveToken(t) {
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify(t)); } catch {}
}
function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
}

// 앱을 다시 열어도 유효한 토큰이 남아 있으면 그대로 씁니다.
let token = loadToken();
let tokenClient = null;
let gisLoaded = null;

export const state = {
  connected: false,
  syncing: false,
  lastError: null,
  lastSync: null,
  needsReconnect: false,   // 사용자가 직접 눌러야 다시 연결됩니다
  phase: '',               // 지금 무슨 일을 하는 중인지
  done: 0,
  total: 0,
};

function progress(phase, done = 0, total = 0) {
  state.phase = phase; state.done = done; state.total = total;
}

let silentFailedAt = 0;

/* ── 설정 ──────────────────────────────────── */

export const getClientId = () => localStorage.getItem('gdrive_client_id') || '';
export const setClientId = v => localStorage.setItem('gdrive_client_id', v.trim());
export const getFolderName = () => localStorage.getItem('gdrive_folder') || 'MyNotes';
export const setFolderName = v => localStorage.setItem('gdrive_folder', (v || '').trim() || 'MyNotes');

/* ── 인증 ──────────────────────────────────── */

function loadGis() {
  if (gisLoaded) return gisLoaded;
  gisLoaded = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('구글 로그인 스크립트를 불러오지 못했습니다. 인터넷 연결을 확인하세요.'));
    document.head.appendChild(s);
  });
  return gisLoaded;
}

function tokenValid() {
  return token && token.access_token && Date.now() < token.expires_at - 60_000;
}

/**
 * 액세스 토큰을 확보합니다.
 * interactive=false 면 조용히(팝업 없이) 갱신만 시도합니다.
 */
export async function auth(interactive = false) {
  if (tokenValid()) return token.access_token;

  const clientId = getClientId();
  if (!clientId) throw new Error('설정에서 OAuth 클라이언트 ID를 먼저 넣으세요.');
  if (!navigator.onLine) throw new Error('오프라인입니다.');

  await loadGis();

  if (!tokenClient || tokenClient._clientId !== clientId) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: () => {},
    });
    tokenClient._clientId = clientId;
  }

  return new Promise((resolve, reject) => {
    tokenClient.callback = resp => {
      if (resp.error) {
        state.connected = false;
        reject(new Error(resp.error_description || resp.error));
        return;
      }
      token = {
        access_token: resp.access_token,
        expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000,
      };
      saveToken(token);
      state.connected = true;
      localStorage.setItem('gdrive_connected', '1');
      resolve(token.access_token);
    };
    try {
      tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    } catch (e) { reject(e); }
  });
}

export function disconnect() {
  try {
    if (token?.access_token) google.accounts.oauth2.revoke(token.access_token, () => {});
  } catch {}
  token = null;
  clearToken();
  state.connected = false;
  localStorage.removeItem('gdrive_connected');
}

export const wasConnected = () => localStorage.getItem('gdrive_connected') === '1';

/** 지금 당장 로그인 창 없이 드라이브를 쓸 수 있는가 */
export const hasLiveToken = () => tokenValid();

/* ── HTTP ──────────────────────────────────── */

async function api(url, opts = {}) {
  const at = await auth(false);
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${at}`, ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    token = null;
    clearToken();
    const at2 = await auth(true);
    return fetch(url, { ...opts, headers: { Authorization: `Bearer ${at2}`, ...(opts.headers || {}) } })
      .then(checkRes);
  }
  return checkRes(res);
}

async function checkRes(res) {
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch {}
    throw new Error(`드라이브 오류 ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return res;
}

/* ── 폴더 ──────────────────────────────────── */

async function ensureFolder() {
  const cached = await db.metaGet('folderId');
  if (cached) {
    try {
      const r = await api(`${API}/files/${cached}?fields=id,trashed`);
      const j = await r.json();
      if (!j.trashed) return cached;
    } catch {}
  }
  const name = getFolderName();
  const q = encodeURIComponent(`mimeType='${FOLDER_MIME}' and name='${name.replace(/'/g, "\\'")}' and trashed=false`);
  const found = await (await api(`${API}/files?q=${q}&fields=files(id,name)&pageSize=10`)).json();
  if (found.files?.length) {
    await db.metaSet('folderId', found.files[0].id);
    return found.files[0].id;
  }
  const made = await (await api(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
  })).json();
  await db.metaSet('folderId', made.id);
  return made.id;
}

/* ── 파일 입출력 ───────────────────────────── */

const fileNameFor = n => `${(n.title || '제목 없음').replace(/[\\/:*?"<>|\n\r]/g, ' ').trim().slice(0, 70) || '노트'}.md`;

function multipart(metadata, text) {
  const b = '=-=-=-notes-' + Math.random().toString(36).slice(2);
  const body = new Blob([
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata),
    `\r\n--${b}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n`,
    text,
    `\r\n--${b}--\r\n`,
  ]);
  return { body, type: `multipart/related; boundary=${b}` };
}

async function pushNote(note, folderId) {
  const text = buildFrontmatter(note) + note.body;
  const meta = {
    name: fileNameFor(note),
    mimeType: 'text/markdown',
    appProperties: { noteId: note.id },
  };
  let url, method;
  if (note.driveId) {
    url = `${UPLOAD}/files/${note.driveId}?uploadType=multipart&fields=id,modifiedTime`;
    method = 'PATCH';
  } else {
    meta.parents = [folderId];
    url = `${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`;
    method = 'POST';
  }
  const { body, type } = multipart(meta, text);
  const r = await api(url, { method, headers: { 'Content-Type': type }, body });
  const j = await r.json();
  note.driveId = j.id;
  note.driveTime = j.modifiedTime;
  note.syncedHash = db.hashText(note.body);
  note.dirty = 0;
  await db.putNote(note);
  return note;
}

async function pushAttachment(att, folderId) {
  const meta = {
    name: att.name || 'image',
    mimeType: att.type || 'application/octet-stream',
    appProperties: { attId: att.id, noteId: att.noteId || '' },
  };
  let url, method;
  if (att.driveId) {
    url = `${UPLOAD}/files/${att.driveId}?uploadType=multipart&fields=id`;
    method = 'PATCH';
  } else {
    meta.parents = [folderId];
    url = `${UPLOAD}/files?uploadType=multipart&fields=id`;
    method = 'POST';
  }
  const b = '=-=-=-att-' + Math.random().toString(36).slice(2);
  const body = new Blob([
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(meta),
    `\r\n--${b}\r\nContent-Type: ${meta.mimeType}\r\n\r\n`,
    att.blob,
    `\r\n--${b}--\r\n`,
  ]);
  const r = await api(url, { method, headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body });
  const j = await r.json();
  att.driveId = j.id;
  att.dirty = 0;
  await db.putFile(att);
}

async function pullAttachment(f) {
  const r = await api(`${API}/files/${f.id}?alt=media`);
  const blob = await r.blob();
  await db.putFile({
    id: f.appProperties.attId,
    name: f.name,
    type: blob.type || 'image/png',
    blob,
    noteId: f.appProperties.noteId || null,
    created: Date.now(),
    dirty: 0,
    driveId: f.id,
    deleted: false,
  });
}

async function pullFile(f) {
  const r = await api(`${API}/files/${f.id}?alt=media`);
  const text = await r.text();
  const { meta, body } = splitFrontmatter(text);
  return { meta, body };
}

/** 지금 연결 상태를 조사해 사람이 읽을 수 있는 보고서로 돌려줍니다. */
export async function diagnose() {
  const L = [];
  const add = (k, v) => L.push(`${k}: ${v}`);

  add('인터넷', navigator.onLine ? '연결됨' : '끊김');
  add('클라이언트ID', getClientId() ? '…' + getClientId().slice(-28) : '없음');
  add('폴더이름', getFolderName());
  add('연결기록', wasConnected() ? '있음' : '없음');
  add('토큰', tokenValid() ? '살아있음' : '없음/만료');
  add('재연결필요', state.needsReconnect ? '예' : '아니오');
  const last = await db.metaGet('lastSync');
  add('마지막동기화', last ? new Date(last).toLocaleString('ko-KR') : '한 번도 없음');
  add('직전오류', state.lastError || '없음');

  const rows = await db.allRows();
  const files = await db.allFiles();
  add('이기기 노트', `${rows.filter(n => !n.deleted).length}개 (올릴 것 ${rows.filter(n => n.dirty && !n.deleted).length})`);
  add('이기기 그림', `${files.length}개 (올릴 것 ${files.filter(f => f.dirty).length})`);

  try {
    await auth(true);
    add('로그인', '성공');
  } catch (e) {
    add('로그인', '실패 — ' + e.message);
    return L.join('\n');
  }

  try {
    const folderId = await ensureFolder();
    add('폴더ID', folderId.slice(0, 12) + '…');
    let notes = 0, imgs = 0, pageToken = null;
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
      const j = await (await api(`${API}/files?q=${q}&fields=nextPageToken,files(id,appProperties)&pageSize=200`
        + (pageToken ? '&pageToken=' + pageToken : ''))).json();
      for (const f of j.files || []) (f.appProperties?.attId ? imgs++ : notes++);
      pageToken = j.nextPageToken || null;
    } while (pageToken);
    add('드라이브 노트', notes + '개');
    add('드라이브 그림', imgs + '개');
  } catch (e) {
    add('드라이브 조회', '실패 — ' + e.message);
  }

  return L.join('\n');
}

/** 드라이브 폴더의 노트·그림을 모두 지웁니다. (되돌릴 수 없습니다) */
export async function wipeRemote() {
  await auth(true);
  const folderId = await ensureFolder();
  let removed = 0, pageToken = null;
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const url = `${API}/files?q=${q}&fields=nextPageToken,files(id)&pageSize=200`
      + (pageToken ? '&pageToken=' + pageToken : '');
    const j = await (await api(url)).json();
    for (const f of j.files || []) {
      try { await api(`${API}/files/${f.id}`, { method: 'DELETE' }); removed++; } catch {}
    }
    pageToken = j.nextPageToken || null;
  } while (pageToken);
  return removed;
}

/** 한 번에 여러 건을 처리합니다. 800개를 하나씩 올리면 너무 느립니다. */
async function pool(items, limit, worker, onTick) {
  let i = 0, done = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try { await worker(item); } catch (e) { if (!/404/.test(e.message)) throw e; }
      done++;
      onTick?.(done, items.length);
    }
  });
  await Promise.all(runners);
  return done;
}

/* ── 동기화 본체 ───────────────────────────── */

/**
 * 한 번의 동기화. 되도록 자주 불러도 안전하도록 만들었습니다.
 * @returns {{pushed:number, pulled:number, conflicts:number, deleted:number}}
 */
export async function sync({ interactive = false } = {}) {
  if (state.syncing) return null;
  if (!navigator.onLine) throw new Error('오프라인입니다. 연결되면 자동으로 올립니다.');

  // 조용한 갱신이 방금 실패했다면, 사용자가 누르기 전까지 다시 시도하지 않습니다.
  // (그래야 로그인 창이 불쑥 뜨는 일이 없습니다.)
  if (!interactive && !tokenValid() && Date.now() - silentFailedAt < 30 * 60_000) {
    state.needsReconnect = true;
    throw new Error('구글 재연결이 필요합니다. 상태 표시를 눌러 주세요.');
  }
  if (interactive) { silentFailedAt = 0; state.needsReconnect = false; }

  state.syncing = true;
  state.lastError = null;
  const tally = { pushed: 0, pulled: 0, conflicts: 0, deleted: 0 };

  try {
    try {
      await auth(interactive);
      state.needsReconnect = false;
    } catch (e) {
      if (!interactive) { silentFailedAt = Date.now(); state.needsReconnect = true; }
      throw e;
    }
    progress('목록 읽는 중');
    const folderId = await ensureFolder();

    // 1) 원격 목록
    const remote = new Map();   // noteId 또는 file.id → file
    const remoteIds = new Set(); // 지우기 판단용 (그림 포함 전체)
    let listingComplete = false;
    let remoteSeen = 0;
    let pageToken = null;
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
      const url = `${API}/files?q=${q}&fields=nextPageToken,files(id,name,modifiedTime,appProperties)`
        + `&pageSize=200${pageToken ? '&pageToken=' + pageToken : ''}`;
      const j = await (await api(url)).json();
      for (const f of j.files || []) { remote.set(f.id, f); remoteIds.add(f.id); remoteSeen++; }
      pageToken = j.nextPageToken || null;
    } while (pageToken);
    listingComplete = true;

    // 그림 파일은 따로 다룹니다.
    const remoteAtts = [];
    for (const [fid, f] of [...remote]) {
      if (f.appProperties?.attId) { remoteAtts.push(f); remote.delete(fid); }
    }

    const localFiles = await db.allFiles();
    const haveAtt = new Set(localFiles.map(a => a.id));
    const attsToPull = remoteAtts.filter(f => !haveAtt.has(f.appProperties.attId));
    if (attsToPull.length) {
      progress('그림 받는 중', 0, attsToPull.length);
      tally.pulled += await pool(attsToPull, 3, f => pullAttachment(f),
        (d, t) => progress('그림 받는 중', d, t));
    }

    const local = await db.allRows();
    const byDriveId = new Map(local.filter(n => n.driveId).map(n => [n.driveId, n]));
    const byNoteId = new Map(local.map(n => [n.id, n]));

    // 2) 삭제(무덤) 먼저 처리
    for (const n of local) {
      if (!n.deleted || !n.dirty) continue;
      if (n.driveId && remote.has(n.driveId)) {
        try {
          await api(`${API}/files/${n.driveId}`, { method: 'DELETE' });
          remote.delete(n.driveId);
        } catch (e) { if (!/404/.test(e.message)) throw e; }
      }
      for (const att of (await db.allFiles()).filter(a => a.noteId === n.id)) {
        if (att.driveId) {
          try { await api(`${API}/files/${att.driveId}`, { method: 'DELETE' }); } catch {}
        }
        await db.purgeFile(att.id);
      }
      await db.purge(n.id);
      tally.deleted++;
    }

    // 3) 원격 → 로컬
    //    896개를 하나씩 받으면 너무 느려 중간에 끊깁니다.
    //    먼저 무엇을 할지 분류한 뒤, 여러 건을 동시에 처리합니다.
    const toCreate = [];   // 이 기기에 없는 노트
    const toUpdate = [];   // 다른 기기에서 고친 노트
    const toResolve = [];  // 양쪽에서 고친 노트 (충돌)
    const toPushNow = [];  // 여기서만 고친 노트

    for (const [fid, f] of remote) {
      const noteId = f.appProperties?.noteId;
      const n = byDriveId.get(fid) || (noteId ? byNoteId.get(noteId) : null);

      if (!n) { toCreate.push(f); continue; }
      if (n.deleted) continue;

      const remoteChanged = n.driveTime !== f.modifiedTime;
      if (remoteChanged && n.dirty) toResolve.push([n, f]);
      else if (remoteChanged) toUpdate.push([n, f]);
      else if (n.dirty && Date.now() - n.modified > 6000) toPushNow.push(n);
    }

    if (toCreate.length) {
      progress('노트 받는 중', 0, toCreate.length);
      tally.pulled += await pool(toCreate, 6, async f => {
        const noteId = f.appProperties?.noteId;
        const { meta, body } = await pullFile(f);
        const created = meta.created ? Date.parse(meta.created) : Date.parse(f.modifiedTime);
        const fresh = db.newNote(body, {
          id: noteId || meta.id || db.uid(),
          created: created || Date.now(),
          modified: Date.parse(f.modifiedTime),
          driveId: f.id,
          driveTime: f.modifiedTime,
          syncedHash: db.hashText(body),
          dirty: 0,
        });
        fresh.title = meta.title || fresh.title;
        if (Array.isArray(meta.tags) && meta.tags.length) {
          fresh.tags = [...new Set([...fresh.tags, ...meta.tags])];
        }
        await db.putNote(fresh);
      }, (d, t) => progress('노트 받는 중', d, t));
    }

    if (toUpdate.length) {
      progress('노트 갱신 중', 0, toUpdate.length);
      tally.pulled += await pool(toUpdate, 6, async ([n, f]) => {
        const { meta, body } = await pullFile(f);
        n.body = body;
        n.title = meta.title || db.titleOf(body);
        n.tags = db.tagsOf(body);
        n.modified = Date.parse(f.modifiedTime);
        n.driveId = f.id;
        n.driveTime = f.modifiedTime;
        n.syncedHash = db.hashText(body);
        n.dirty = 0;
        await db.putNote(n);
      }, (d, t) => progress('노트 갱신 중', d, t));
    }

    // 충돌 후보: 시각만으로는 알 수 없습니다. 내용을 직접 비교합니다.
    for (const [n, f] of toResolve) {
      const { meta, body } = await pullFile(f);
      const remoteHash = db.hashText(body);
      const localHash = db.hashText(n.body);

      if (remoteHash === localHash) {
        // 사실 같은 글입니다. 시각만 어긋난 것이니 맞춰만 둡니다.
        n.driveTime = f.modifiedTime;
        n.syncedHash = remoteHash;
        n.dirty = 0;
        await db.putNote(n);
        continue;
      }

      // 저쪽이 우리가 마지막으로 맞췄던 그대로라면, 바뀐 건 이쪽뿐입니다.
      if (n.syncedHash && remoteHash === n.syncedHash) {
        await pushNote(n, folderId);
        tally.pushed++;
        continue;
      }

      // 이쪽이 마지막으로 맞췄던 그대로라면, 바뀐 건 저쪽뿐입니다.
      if (n.syncedHash && localHash === n.syncedHash) {
        n.body = body;
        n.title = meta.title || db.titleOf(body);
        n.tags = db.tagsOf(body);
        n.modified = Date.parse(f.modifiedTime);
        n.driveTime = f.modifiedTime;
        n.syncedHash = remoteHash;
        n.dirty = 0;
        await db.putNote(n);
        tally.pulled++;
        continue;
      }

      // 한쪽이 다른 쪽을 그대로 품고 있으면(이어 쓰는 중) 긴 쪽을 남깁니다.
      const a = n.body.trim(), b = body.trim();
      if (a.startsWith(b) || b.startsWith(a)) {
        if (a.length >= b.length) {
          await pushNote(n, folderId);
          tally.pushed++;
        } else {
          n.body = body;
          n.title = meta.title || db.titleOf(body);
          n.tags = db.tagsOf(body);
          n.driveTime = f.modifiedTime;
          n.syncedHash = remoteHash;
          n.dirty = 0;
          await db.putNote(n);
          tally.pulled++;
        }
        continue;
      }

      // 여기까지 오면 진짜 충돌입니다. 어느 쪽도 버리지 않습니다.
      const stamp = new Date().toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
      const copy = db.newNote(body, { created: n.created, dirty: 1 });
      copy.title = `${n.title} (충돌 ${stamp})`;
      copy.body = `# ${copy.title}\n\n` + body;
      await db.putNote(copy);
      tally.conflicts++;
      await pushNote(n, folderId);
      tally.pushed++;
    }

    if (toPushNow.length) {
      progress('올리는 중', 0, toPushNow.length);
      tally.pushed += await pool(toPushNow, 4, n => pushNote(n, folderId),
        (d, t) => progress('올리는 중', d, t));
    }

    // 3-2) 다른 기기에서 지운 노트를 이 기기에서도 지웁니다.
    //      한 번 올라간 적이 있고(driveTime 있음), 여기서 고친 것도 아닌데
    //      드라이브 목록에 없다면 = 다른 기기에서 지운 것입니다.
    if (listingComplete && remoteSeen > 0) {
      for (const n of await db.allRows()) {
        if (n.deleted || n.dirty) continue;
        if (!n.driveId || !n.driveTime) continue;
        if (remoteIds.has(n.driveId)) continue;
        for (const att of (await db.allFiles()).filter(a => a.noteId === n.id)) {
          await db.purgeFile(att.id);
        }
        await db.purge(n.id);
        tally.deleted++;
      }
    }

    // 4) 아직 드라이브에 없는 로컬 노트 올리기
    const QUIET = 6000;   // 방금 고친 노트는 손이 멈출 때까지 기다립니다
    const toPush = (await db.allRows()).filter(n =>
      !n.deleted && n.dirty && Date.now() - n.modified > QUIET
      && !(n.driveId && remote.has(n.driveId)));
    if (toPush.length) {
      progress('올리는 중', 0, toPush.length);
      tally.pushed += await pool(toPush, 4, n => pushNote(n, folderId),
        (d, t) => progress('올리는 중', d, t));
    }

    // 아직 안 올라간 그림 올리기
    const atts = await db.dirtyFiles();
    if (atts.length) {
      progress('그림 올리는 중', 0, atts.length);
      tally.pushed += await pool(atts, 3, a => pushAttachment(a, folderId),
        (d, t) => progress('그림 올리는 중', d, t));
    }

    state.lastSync = Date.now();
    await db.metaSet('lastSync', state.lastSync);
    return tally;
  } catch (e) {
    state.lastError = e.message;
    throw e;
  } finally {
    state.syncing = false;
    progress('');
  }
}
