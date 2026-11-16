// (c) Carlos Botero. Own tool. All rights reserved. Service worker of site_lock.py (version 665de1862d88).
// Decrypts the lab's files in the browser. Holds no password; the key comes from the unlock page.
'use strict';
const BASE = new URL('./', self.registration.scope).pathname;   // folder of the site
const APP = BASE + 'app/';
let key = null, manifest = null;

const idb = () => new Promise((ok, bad) => {
  const r = indexedDB.open('sitelock', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('k');
  r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
});
async function store(value) {
  const db = await idb();
  await new Promise((ok, bad) => { const t = db.transaction('k', 'readwrite');
    value ? t.objectStore('k').put(value, 'key') : t.objectStore('k').delete('key');
    t.oncomplete = ok; t.onerror = () => bad(t.error); });
}
async function load() {
  const db = await idb();
  return new Promise((ok) => { const r = db.transaction('k').objectStore('k').get('key');
    r.onsuccess = () => ok(r.result || null); r.onerror = () => ok(null); });
}
async function open(bytes, k) {
  const buf = new Uint8Array(bytes);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, k, buf.slice(12));
}
async function getManifest(k) {
  const res = await fetch(BASE + 'm.bin', { cache: 'no-cache' });
  if (!res.ok) throw new Error('manifest');
  return JSON.parse(new TextDecoder().decode(await open(await res.arrayBuffer(), k)));
}
async function ensure() {
  if (key && manifest) return true;
  const saved = await load();
  if (!saved || saved.until < Date.now()) { await store(null); return false; }
  try {
    const k = await crypto.subtle.importKey('raw', saved.raw, 'AES-GCM', false, ['decrypt']);
    manifest = await getManifest(k); key = k; return true;
  } catch (e) { await store(null); key = manifest = null; return false; }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => {
  const d = e.data || {};
  const reply = (m) => e.ports[0] && e.ports[0].postMessage(m);
  if (d.type === 'unlock') {
    e.waitUntil((async () => {
      try {
        const k = await crypto.subtle.importKey('raw', d.raw, 'AES-GCM', false, ['decrypt']);
        manifest = await getManifest(k); key = k;
        await store({ raw: d.raw, until: Date.now() + d.hours * 3600e3 });
        reply({ ok: true });
      } catch (err) { reply({ ok: false }); }
    })());
  } else if (d.type === 'lock') {
    key = manifest = null; e.waitUntil(store(null).then(() => reply({ ok: true })));
  } else if (d.type === 'status') {
    e.waitUntil(ensure().then((ok) => reply({ ok })));
  }
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(APP)) return;   // network as usual
  e.respondWith(serve(e.request, url));
});

async function serve(request, url) {
  if (!(await ensure())) {
    if (request.mode === 'navigate') return Response.redirect(BASE + 'index.html' + url.search, 302);
    return new Response('Locked', { status: 403 });
  }
  let rel = decodeURIComponent(url.pathname.slice(APP.length));
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const item = manifest[rel];
  if (!item) return new Response('Not found', { status: 404 });
  const res = await fetch(BASE + item.f);
  if (!res.ok) return new Response('Not available', { status: 502 });
  const plain = new Uint8Array(await open(await res.arrayBuffer(), key));
  const headers = { 'Content-Type': item.t, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const range = request.headers.get('Range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m) {                                   // video/audio seeking (required by Safari)
    let start = m[1] === '' ? plain.length - Number(m[2]) : Number(m[1]);
    let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : plain.length - 1;
    start = Math.max(0, start); end = Math.min(end, plain.length - 1);
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${plain.length}` } });
    return new Response(plain.slice(start, end + 1), { status: 206, headers: { ...headers,
      'Content-Range': `bytes ${start}-${end}/${plain.length}`, 'Content-Length': String(end - start + 1) } });
  }
  return new Response(plain, { status: 200, headers: { ...headers, 'Content-Length': String(plain.length) } });
}
