/* ─────────────────────────────────────────────
   sw.js — 오프라인 구동용 서비스 워커
   앱 파일을 고칠 때마다 VERSION 을 올리세요.
   ───────────────────────────────────────────── */

const VERSION = 'v6';
const CACHE = `notes-shell-${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'db.js',
  'drive.js',
  'markdown.js',
  'export.js',
  'stats.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 구글 API·로그인은 절대 캐시하지 않습니다.
  if (url.origin !== self.location.origin) return;

  // 문서 요청: 네트워크 먼저, 실패하면 캐시(오프라인)
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('index.html', copy));
          return res;
        })
        .catch(() => caches.match('index.html'))
    );
    return;
  }

  // 나머지 자기 파일: 캐시 먼저, 없으면 네트워크
  e.respondWith(
    caches.match(request).then(hit => hit || fetch(request).then(res => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(request, copy));
      }
      return res;
    }).catch(() => new Response('', { status: 503, statusText: 'offline' })))
  );
});
