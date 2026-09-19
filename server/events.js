// server/events.js — LOCAL GERÇEK ZAMANLI OLAY KATMANI
// ------------------------------------------------------------------
// admin.html/api.js zaten SSE (?table=realtime) + uzun-bekleyen yedek
// (?table=events_wait) + hafif yoklama (?table=events_ping) protokolünü
// biliyor; ama local Electron sunucusu bu uç noktaları hiç sunmadığı için
// arayüz 45 saniyelik yedek yoklamalara düşüyordu.
//
// Burada bu üç uç noktayı da local olarak uyguluyoruz. Olaylar hem
// SQLite'a yazılır (yeniden bağlanan istemci kaçırdığı olayları alabilsin)
// hem de bellekteki abonelere ANINDA (0 ms) iletilir.
const { getDB } = require('./db');

const subscribers = new Set(); // { restaurantId, fn }
let _lastId = null;

// Açık SSE yanıtları. Bunlar kapatılmazsa http server.close() ASLA bitmez
// (soketler keep-alive olarak açık kalır) ve uygulama kapansa bile port
// tutulu kalır. Kapanışta hepsini elle sonlandırıyoruz.
const openStreams = new Set();
function closeAllStreams() {
  for (const fn of Array.from(openStreams)) { try { fn(); } catch (e) {} }
  openStreams.clear();
  subscribers.clear();
}

function lastEventId() {
  if (_lastId === null) {
    const r = getDB().prepare('SELECT COALESCE(MAX(id),0) AS n FROM events').get();
    _lastId = r.n;
  }
  return _lastId;
}

// Olayı kalıcılaştır + tüm dinleyicilere anında ilet.
function publish(restaurantId, event, payload = {}) {
  if (!restaurantId || !event) return null;
  const db = getDB();
  const info = db.prepare('INSERT INTO events (restaurant_id,event,payload) VALUES (?,?,?)')
    .run(restaurantId, event, JSON.stringify(payload || {}));
  const row = { id: info.lastInsertRowid, restaurant_id: restaurantId, event, payload: payload || {} };
  _lastId = row.id;
  for (const s of subscribers) {
    if (s.restaurantId !== restaurantId) continue;
    try { s.fn(row); } catch (e) { /* kopmuş bağlantı — temizleme aşağıda */ }
  }
  // Olay defteri sonsuza kadar büyümesin: 2 günden eskiyi at (nadiren çalışsın diye ~%2 şans)
  if (Math.random() < 0.02) {
    try { db.prepare(`DELETE FROM events WHERE created_at < datetime('now','-2 days')`).run(); } catch (e) {}
  }
  return row;
}

function subscribe(restaurantId, fn) {
  const s = { restaurantId, fn };
  subscribers.add(s);
  return () => subscribers.delete(s);
}

function backlog(restaurantId, sinceId, limit = 100) {
  return getDB().prepare(
    'SELECT id,event,payload FROM events WHERE restaurant_id=? AND id>? ORDER BY id ASC LIMIT ?'
  ).all(restaurantId, Number(sinceId) || 0, limit);
}

// ── SSE: GET /api/index.php?table=realtime&restaurant_id=..&last_id=.. ──
// İstemcinin "watchdog"u 12 sn içinde bir canlılık sinyali bekliyor; 8 sn'de
// bir ping atıyoruz ki asla yedek moda düşmesin.
const PING_MS = 8000;

function sseHandler(req, res) {
  const rid = req.query.restaurant_id;
  if (!rid) { res.status(400).json({ error: 'restaurant_id gerekli' }); return; }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  const send = (row) => {
    res.write(`id: ${row.id}\n`);
    res.write(`event: ${row.event}\n`);
    res.write(`data: ${JSON.stringify({ payload: row.payload })}\n\n`);
  };

  // Kaçırılan olaylar (yeniden bağlanma senaryosu)
  const since = Number(req.headers['last-event-id'] || req.query.last_id || 0);
  try {
    for (const r of backlog(rid, since)) send({ id: r.id, event: r.event, payload: safeParse(r.payload) });
  } catch (e) {}

  const unsub = subscribe(rid, send);
  const ping = setInterval(() => {
    try { res.write(`event: ping\ndata: {}\n\n`); } catch (e) {}
  }, PING_MS);
  res.write(`event: ping\ndata: {}\n\n`); // bağlantı anında ilk canlılık sinyali

  const close = () => {
    clearInterval(ping);
    unsub();
    openStreams.delete(close);
    try { res.end(); } catch (e) {}
    try { req.socket && req.socket.destroy(); } catch (e) {}
  };
  openStreams.add(close);
  req.on('close', close);
  req.on('error', close);
}

// ── UZUN BEKLEYEN YEDEK: ?table=events_wait&since_id=.. ──
const WAIT_MS = 20000;

function waitHandler(req, res) {
  const rid = req.query.restaurant_id;
  if (!rid) { res.status(400).json({ error: 'restaurant_id gerekli' }); return; }
  const since = Number(req.query.since_id || 0);
  const current = lastEventId();
  if (!since || current > since) { res.json({ last_id: current, timed_out: false }); return; }

  let done = false;
  const finish = (timedOut) => {
    if (done) return; done = true;
    clearTimeout(timer); unsub();
    try { res.json({ last_id: lastEventId(), timed_out: timedOut }); } catch (e) {}
  };
  // 'sync_status' salt bilgilendirme amaçlıdır; veri değişmediği için yedek
  // moddaki istemciyi uyandırıp gereksiz tam tazeleme yaptırmamalı.
  const unsub = subscribe(rid, (row) => { if (row.event !== 'sync_status') finish(false); });
  const timer = setTimeout(() => finish(true), WAIT_MS);
  const abort = () => { if (!done) { done = true; clearTimeout(timer); unsub(); try { res.end(); } catch (e) {} } openStreams.delete(abort); };
  openStreams.add(abort);
  req.on('close', abort);
}

// ── EN HAFİF YOKLAMA: ?table=events_ping ──
function pingHandler(req, res) {
  res.json({ last_id: lastEventId() });
}

function safeParse(v) { try { return typeof v === 'string' ? JSON.parse(v) : (v || {}); } catch (e) { return {}; } }

module.exports = { publish, subscribe, backlog, lastEventId, sseHandler, waitHandler, pingHandler, closeAllStreams };
