'use strict';
// ══════════════════════════════════════════════════════════════════════
// MUTFAK FİŞ KUYRUĞU (print_jobs)
//
// Mutfak fişlerinin TEK doğru kaynağı. Ekran artık "bunu daha önce gördüm mü?"
// diye tahmin etmiyor; hangi kalemin kaç adedinin mutfağa bildirildiği bu
// bilgisayarın veritabanında (kitchen_sent) tutulur ve her fark için kalıcı
// bir fiş kaydı (print_jobs) oluşur. Ana bilgisayardaki yazdırma servisi bu
// kayıtları sırayla basar ve "basıldı" işaretler.
//
//  • Fiş kaybolmaz: basılamayan kayıt "failed" kalır, tekrar denenir, ekranda görünür.
//  • Çift basılmaz: her kaydın tek bir durumu var.
//  • Adet değişikliği karışmaz: +1 → "Pizza 1" fişi, −1 → "İPTAL Pizza 1" fişi.
//  • İnternetsiz aynı çalışır: her şey bu bilgisayarın içinde.
// ══════════════════════════════════════════════════════════════════════
const { getDB } = require('./db');
const H = require('./helpers');

const DEBOUNCE_MS = 1200;      // aynı gönderimdeki kalemler TEK fişte toplansın
const STALE_PRINTING_MS = 90000; // "basılıyor"da takılı kalan iş yeniden denenir
let timer = null;
let lastRun = 0;

function ensureSchema() {
  const db = getDB();
  db.exec(`
    CREATE TABLE IF NOT EXISTS kitchen_sent (
      item_id TEXT PRIMARY KEY,
      order_id TEXT,
      product_id TEXT,
      product_name TEXT,
      variant_name TEXT,
      qty INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS print_jobs (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT,
      order_id TEXT,
      table_id TEXT,
      kind TEXT NOT NULL DEFAULT 'kitchen',
      station_id TEXT,
      station_name TEXT,
      printer_name TEXT,
      paper_mm INTEGER,
      items_json TEXT NOT NULL,
      note TEXT,
      employee_name TEXT,
      order_created_at TEXT,
      warning TEXT,
      reprint_of TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at INTEGER DEFAULT 0,
      claimed_at INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      printed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);
  `);
  // İLK KURULUM: güncellemeden önce var olan kalemler "zaten bildirildi" sayılır —
  // yoksa güncelleme sonrası açılışta tüm eski siparişlerin fişi yeniden basılırdı.
  if (!H.cfgGet('kitchen_jobs_baseline')) {
    db.prepare(`INSERT OR IGNORE INTO kitchen_sent (item_id, order_id, product_id, product_name, variant_name, qty)
                SELECT id, order_id, product_id, product_name, variant_name, quantity FROM order_items`).run();
    H.cfgSet('kitchen_jobs_baseline', new Date().toISOString());
  }
}

function parseJson(v, d) { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return d; } }
function truthy(v) { return v === 1 || v === true || v === '1' || v === 'true'; }

function settingsFor(db, rid) {
  const row = db.prepare('SELECT * FROM settings WHERE restaurant_id=?').get(rid) || db.prepare('SELECT * FROM settings LIMIT 1').get() || {};
  return {
    stations: parseJson(row.kitchen_stations, []) || [],
    sentAuto: truthy(row.kitchen_auto_print) || truthy(row.pos_send_auto_print),
    newAuto: truthy(row.phone_order_auto_print),
    width: Number(row.printer_width_mm) === 58 ? 58 : 80,
  };
}

// Admin paneldeki _stationHasFilter / _isProductInStation ile BİREBİR aynı kural.
function stationFor(stations, prod) {
  if (!prod) return null;
  for (const st of stations) {
    const cats = Array.isArray(st.categories) ? st.categories : [];
    const prods = Array.isArray(st.products) ? st.products : [];
    if (!cats.length && !prods.length) continue;
    if ((cats.length && cats.includes(prod.category_id)) || (prods.length && prods.includes(prod.id))) return st;
  }
  return null;
}

function findProduct(db, item) {
  if (item.product_id) {
    const p = db.prepare('SELECT id, category_id, name FROM products WHERE id=?').get(item.product_id);
    if (p) return p;
  }
  if (item.product_name) {
    const p = db.prepare('SELECT id, category_id, name FROM products WHERE lower(trim(name))=lower(trim(?)) LIMIT 1').get(item.product_name);
    if (p) return p;
  }
  return null;
}

// Kalemleri istasyonlara ayırıp her istasyon için bir fiş kaydı oluşturur.
function createJobs(db, order, lines, kind, cfg) {
  const groups = new Map();
  for (const ln of lines) {
    const prod = findProduct(db, ln);
    let key, st = null, warning = null;
    if (!cfg.stations.length) key = '__all__';
    else {
      st = stationFor(cfg.stations, prod);
      if (st) key = 'st:' + st.id;
      else { key = '__none__'; warning = 'ISTASYON YOK'; }
    }
    if (!groups.has(key)) groups.set(key, { st, warning, items: [] });
    groups.get(key).items.push({
      id: ln.id, product_id: ln.product_id || null, product_name: ln.product_name,
      variant_name: ln.variant_name || null, quantity: ln.quantity,
    });
  }
  const ins = db.prepare(`INSERT INTO print_jobs (id, restaurant_id, order_id, table_id, kind, station_id, station_name, printer_name, paper_mm,
      items_json, note, employee_name, order_created_at, warning) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  for (const g of groups.values()) {
    const st = g.st;
    const pw = st && (Number(st.paper_width_mm) === 58 || Number(st.paper_width_mm) === 80) ? Number(st.paper_width_mm) : cfg.width;
    ins.run(H.uuid(), order.restaurant_id, order.id, order.table_id || null, kind,
      st ? st.id : null, st ? ((st.icon || '') + ' ' + (st.name || '')).trim() : '', st ? (st.printer_name || '') : '', pw,
      JSON.stringify(g.items), kind === 'kitchen' ? (order.note || null) : null, order.employee_name || null, order.created_at || null, g.warning);
    n++;
  }
  return n;
}

const OPEN_SQL = `COALESCE(o.status,'pending') NOT IN ('completed','cancelled','canceled') AND o.voided_at IS NULL`;

// Veritabanındaki durumu "mutfağa bildirilen" kayıtla karşılaştırıp farklar için fiş üretir.
function generate() {
  lastRun = Date.now();
  const db = getDB();
  let created = 0;
  db.transaction(() => {
    const cfgCache = new Map();
    const cfgOf = (rid) => { if (!cfgCache.has(rid)) cfgCache.set(rid, settingsFor(db, rid)); return cfgCache.get(rid); };
    const upsertSent = db.prepare(`INSERT INTO kitchen_sent (item_id, order_id, product_id, product_name, variant_name, qty, updated_at)
      VALUES (?,?,?,?,?,?,datetime('now')) ON CONFLICT(item_id) DO UPDATE SET qty=excluded.qty, order_id=excluded.order_id, updated_at=datetime('now')`);

    // 1) Silinen kalemler: senkronda id'si değişen kalem "silindi + yeni geldi" gibi
    //    görünür → önce aynı siparişte eşleşen yeni kalem aranır ve kayıt ona AKTARILIR
    //    (iptal + yeni fiş basılmaz). Eşleşme yoksa ve sipariş hâlâ açıksa İPTAL fişi.
    const orphans = db.prepare(`SELECT ks.* FROM kitchen_sent ks LEFT JOIN order_items oi ON oi.id=ks.item_id WHERE oi.id IS NULL`).all();
    const cancelByOrder = new Map();
    for (const ks of orphans) {
      const twin = db.prepare(`SELECT oi.* FROM order_items oi LEFT JOIN kitchen_sent k2 ON k2.item_id=oi.id
          WHERE oi.order_id=? AND k2.item_id IS NULL AND COALESCE(oi.product_id,'')=COALESCE(?, '')
            AND oi.product_name=? AND COALESCE(oi.variant_name,'')=COALESCE(?, '') LIMIT 1`)
        .get(ks.order_id, ks.product_id, ks.product_name, ks.variant_name);
      db.prepare('DELETE FROM kitchen_sent WHERE item_id=?').run(ks.item_id);
      if (twin) { upsertSent.run(twin.id, twin.order_id, twin.product_id, twin.product_name, twin.variant_name, Math.min(ks.qty, twin.quantity)); continue; }
      const o = db.prepare(`SELECT o.* FROM orders o WHERE o.id=? AND ${OPEN_SQL}`).get(ks.order_id);
      if (!o || ks.qty <= 0) continue;
      if (!cancelByOrder.has(o.id)) cancelByOrder.set(o.id, { order: o, lines: [] });
      cancelByOrder.get(o.id).lines.push({ id: ks.item_id, product_id: ks.product_id, product_name: ks.product_name, variant_name: ks.variant_name, quantity: ks.qty });
    }

    // 2) Açık siparişlerdeki kalemler: bildirilen adetle gerçek adet farkı
    const rows = db.prepare(`SELECT oi.*, ks.qty AS sent_qty, o.restaurant_id AS o_rid
        FROM order_items oi JOIN orders o ON o.id=oi.order_id
        LEFT JOIN kitchen_sent ks ON ks.item_id=oi.id
        WHERE ${OPEN_SQL}`).all();
    const addByOrder = new Map();
    for (const it of rows) {
      const cfg = cfgOf(it.o_rid);
      const sent = Number(it.sent_qty || 0);
      const qty = Number(it.quantity || 0);
      const isSent = truthy(it.sent_to_kitchen);
      if (qty > sent) {
        // Gönderildi işaretliyse (Mutfağa Gönder/Hazırlanıyor) ya da "yeni sipariş otomatik fiş" açıksa bildir.
        if (!(isSent || cfg.newAuto)) continue;
        upsertSent.run(it.id, it.order_id, it.product_id, it.product_name, it.variant_name, qty);
        if (!(isSent ? cfg.sentAuto || cfg.newAuto : cfg.newAuto)) continue; // ayar kapalı: kaydet ama basma
        if (!addByOrder.has(it.order_id)) addByOrder.set(it.order_id, []);
        addByOrder.get(it.order_id).push({ ...it, quantity: qty - sent });
      } else if (qty < sent) {
        upsertSent.run(it.id, it.order_id, it.product_id, it.product_name, it.variant_name, qty);
        if (!cancelByOrder.has(it.order_id)) cancelByOrder.set(it.order_id, { order: null, lines: [] });
        cancelByOrder.get(it.order_id).lines.push({ ...it, quantity: sent - qty });
      }
    }
    for (const [oid, lines] of addByOrder) {
      const o = db.prepare('SELECT * FROM orders WHERE id=?').get(oid);
      if (o) created += createJobs(db, o, lines, 'kitchen', cfgOf(o.restaurant_id));
    }
    for (const [oid, g] of cancelByOrder) {
      const o = g.order || db.prepare('SELECT * FROM orders WHERE id=?').get(oid);
      if (!o) continue;
      const cfg = cfgOf(o.restaurant_id);
      if (!(cfg.sentAuto || cfg.newAuto)) continue;
      created += createJobs(db, o, g.lines, 'cancel', cfg);
    }

    // 3) Kapanan siparişlerin kayıtlarını ve eski basılmış fişleri temizle
    db.prepare(`DELETE FROM kitchen_sent WHERE order_id IN (SELECT id FROM orders o WHERE NOT (${OPEN_SQL}))`).run();
    db.prepare(`DELETE FROM print_jobs WHERE status='printed' AND created_at < datetime('now','-3 days')`).run();
  })();
  if (created) {
    console.log(`[fiş] ${created} yeni mutfak fişi kuyruğa eklendi`);
    try { const E = require('./events'); const r = getDB().prepare('SELECT restaurant_id FROM settings LIMIT 1').get(); if (r && E.publish) E.publish(r.restaurant_id, 'print_jobs', {}); } catch (e) {}
  }
  return created;
}

// Yazmalardan sonra kısa gecikmeyle çalışır: "Mutfağa Gönder" 14 kalemi tek tek
// işaretlese bile hepsi TEK fişte toplanır.
function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; try { generate(); } catch (e) { console.error('[fiş] üretim hatası:', e); } }, DEBOUNCE_MS);
}

// ── Yazdırma servisinin kullandığı işlemler ──
function listPending() {
  const db = getDB();
  const now = Date.now();
  // Çökme/kapanma yüzünden "basılıyor"da kalan işler geri alınır
  db.prepare(`UPDATE print_jobs SET status='pending' WHERE status='printing' AND claimed_at < ?`).run(now - STALE_PRINTING_MS);
  return db.prepare(`SELECT * FROM print_jobs WHERE (status='pending' OR (status='failed' AND attempts < 6 AND next_attempt_at <= ?))
                     ORDER BY created_at ASC LIMIT 20`).all(now).map(decode);
}
function listRecent(limit) {
  return getDB().prepare(`SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT ?`).all(Math.min(Number(limit) || 50, 200)).map(decode);
}
function counts() {
  const r = getDB().prepare(`SELECT
      SUM(CASE WHEN status IN ('pending','printing') THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM print_jobs`).get();
  return { waiting: r.waiting || 0, failed: r.failed || 0 };
}
function claim(id) {
  const db = getDB();
  const ch = db.prepare(`UPDATE print_jobs SET status='printing', claimed_at=? WHERE id=? AND status IN ('pending','failed')`).run(Date.now(), id).changes;
  return ch ? decode(db.prepare('SELECT * FROM print_jobs WHERE id=?').get(id)) : null;
}
function markPrinted(id) {
  getDB().prepare(`UPDATE print_jobs SET status='printed', printed_at=datetime('now'), last_error=NULL WHERE id=?`).run(id);
}
function markFailed(id, err) {
  const db = getDB();
  const j = db.prepare('SELECT attempts FROM print_jobs WHERE id=?').get(id);
  const a = (j ? j.attempts : 0) + 1;
  const wait = [3000, 8000, 20000, 45000, 90000, 180000][Math.min(a - 1, 5)];
  db.prepare(`UPDATE print_jobs SET status='failed', attempts=?, last_error=?, next_attempt_at=? WHERE id=?`).run(a, String(err || 'hata').slice(0, 300), Date.now() + wait, id);
}
function reprint(id) {
  const db = getDB();
  const j = db.prepare('SELECT * FROM print_jobs WHERE id=?').get(id);
  if (!j) return null;
  const nid = H.uuid();
  db.prepare(`INSERT INTO print_jobs (id, restaurant_id, order_id, table_id, kind, station_id, station_name, printer_name, paper_mm, items_json, note,
      employee_name, order_created_at, warning, reprint_of) SELECT ?, restaurant_id, order_id, table_id, kind, station_id, station_name, printer_name,
      paper_mm, items_json, note, employee_name, order_created_at, warning, id FROM print_jobs WHERE id=?`).run(nid, id);
  return nid;
}
function dismiss(id) {
  getDB().prepare(`UPDATE print_jobs SET status='printed', printed_at=datetime('now'), last_error=COALESCE(last_error,'')||' (elle kapatıldı)' WHERE id=?`).run(id);
}
function decode(j) { if (!j) return j; j.items = parseJson(j.items_json, []); delete j.items_json; return j; }

function init() {
  ensureSchema();
  // Güvenlik ağı: herhangi bir tetik kaçsa bile 10 sn'de bir kontrol
  setInterval(() => { if (!timer && Date.now() - lastRun > 9000) schedule(); }, 10000).unref?.();
  schedule();
}

module.exports = { init, schedule, generate, listPending, listRecent, counts, claim, markPrinted, markFailed, reprint, dismiss };
