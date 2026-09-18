// server/routes.js — GET/POST/PUT/DELETE /api/index.php?table=...&action=...&id=...
// admin.html + api.js HİÇ DEĞİŞTİRİLMEDEN bu server'a karşı çalışır (aynı URL şeması).
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDB, getDataDir } = require('./db');
const H = require('./helpers');
const { queueWrite, queueUpload, getStatus, retryFailed, failedItems, clearFailed, triggerSync, pendingCount, diagnose } = require('./sync');
const E = require('./events');

const router = express.Router();

// Body her zaman JSON bekleniyor (upload hariç) — app.js'te express.json() zaten mount edilecek.

function wrap(fn) {
  return (req, res) => {
    // Yanıt gövdesini yakala: POST'ta local'de üretilen id'yi kuyruğa da
    // yazabilmek için gerekli (online sunucu AYNI id ile kaydetsin diye).
    let captured = null;
    const origJson = res.json.bind(res);
    res.json = (payload) => { captured = payload; return origJson(payload); };
    try {
      fn(req, res);
      if (res.statusCode < 400) {
        // Başarılı yazma: offline-sync kuyruğuna ekle + arayüzlere anlık olay yayınla
        enqueueIfWrite(req, captured);
        emitRealtime(req, captured);
      }
    } catch (e) {
      if (e instanceof H.ApiError) {
        const body = e.extra ? { error: e.extra.error || e.message, ...e.extra } : { error: e.message };
        res.status(e.code).json(body);
      } else {
        console.error(e);
        res.status(500).json({ error: 'Sunucu hatası: ' + e.message });
      }
    }
  };
}

function j(res, data, code = 200) { res.status(code).json(data); }

function parseJsonField(v, def) {
  if (v === null || v === undefined || v === '') return def;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return def; }
}

// Bu tablolar tamamen cihaza özeldir / online tarafta karşılığı yoktur —
// kuyruğa hiç girmezler.
const NO_SYNC_TABLES = ['auth', 'upload', 'events_ping', 'events_wait', 'realtime', 'sync'];

// Yazma isteklerini (POST/PUT/DELETE), yanıt üretildikten sonra local'de zaten
// uygulanmış olarak kabul edip offline-sync kuyruğuna ekler (idempotent).
function enqueueIfWrite(req, responseBody) {
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return;
  const table = req.query.table;
  if (!table || NO_SYNC_TABLES.includes(table)) return;

  // ── KRİTİK: id tutarlılığı ──
  // POST'ta id'yi local ürettik. Gövdede yoksa online sunucu KENDİ id'sini
  // üretir ve iki taraf kalıcı olarak ayrışır (aynı sipariş iki farklı id).
  // Yanıttan aldığımız id'yi gövdeye yazarak bunu engelliyoruz.
  // DİKKAT: gövde DİZİ olabilir (ör. toplu order_items ekleme). Diziyi obje gibi
  // kopyalamak {"0":{...}} üretir ve sunucuya bozuk istek gider — kalemler hiç
  // kaydedilmezdi. Diziyi dizi olarak koruyoruz.
  let body = Array.isArray(req.body)
    ? (req.body.length ? req.body.slice() : null)
    : (req.body && Object.keys(req.body).length ? { ...req.body } : null);
  let entityId = req.query.id || null;
  const respId = responseBody && !Array.isArray(responseBody) ? responseBody.id : null;
  if (req.method === 'POST' && respId && !Array.isArray(body)) {
    body = { ...(body || {}), id: respId };
    entityId = respId;
  }
  if (!entityId && body && !Array.isArray(body) && body.id) entityId = body.id;

  queueWrite({
    idempotency_key: req.headers['x-idempotency-key'] || H.uuid(),
    method: req.method,
    path: req.originalUrl,
    body: body ? JSON.stringify(body) : (req.body ? JSON.stringify(req.body) : null),
    entity_table: table,
    entity_id: entityId,
  });
}

// ── ANLIK OLAY YAYINI ────────────────────────────────────────
// api.js'in SSE istemcisi bu olay adlarını tanıyor; böylece bir cihazda yapılan
// değişiklik diğer tüm pencerelerde/cihazlarda ANINDA görünür (45 sn'lik yedek
// yoklamayı beklemeden).
function eventNameFor(req) {
  const t = req.query.table, m = req.method, a = req.query.action || '';
  if (t === 'orders') {
    if (a === 'void_and_reopen') return 'order_voided';
    if (a === 'close_day') return 'order_update';
    if (m === 'POST') return 'new_order';
    if (m === 'DELETE') return 'order_deleted';
    return 'order_update';
  }
  if (t === 'order_items') return 'order_update';
  if (t === 'order_refunds') return 'order_refunded';
  if (t === 'tables') return 'table_update';
  return 'data_update'; // menü, ayarlar, stok vb. → arayüz genel tazeleme yapar
}

function emitRealtime(req, responseBody) {
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return;
  const table = req.query.table;
  if (!table || ['auth', 'events_ping', 'events_wait', 'realtime', 'sync'].includes(table)) return;
  try {
    const rid = resolveEventRestaurantId(req, responseBody);
    if (!rid) return;
    const payload = responseBody && !Array.isArray(responseBody) ? responseBody : {};
    E.publish(rid, eventNameFor(req), { table, payload, id: req.query.id || payload.id || null });
  } catch (e) { /* olay yayını asıl isteği asla bozmasın */ }
}

function resolveEventRestaurantId(req, responseBody) {
  if (responseBody && responseBody.restaurant_id) return responseBody.restaurant_id;
  if (req.body && req.body.restaurant_id) return req.body.restaurant_id;
  if (req.query.restaurant_id) return req.query.restaurant_id;
  const u = H.getAuthUser(req);
  return u ? u.restaurant_id : null;
}

// ── GERÇEK ZAMANLI UÇ NOKTALAR ───────────────────────────────
// api.js bunları zaten biliyor ama local sunucu şimdiye kadar sunmuyordu;
// bu yüzden arayüz 45 sn'lik yedek yoklamalara düşüyordu. Artık anlık.
router.use('/api/index.php', (req, res, next) => {
  const t = req.query.table;
  if (t === 'realtime') return E.sseHandler(req, res);
  if (t === 'events_wait') return E.waitHandler(req, res);
  if (t === 'events_ping') return E.pingHandler(req, res);
  next();
});

// ── SENKRON DURUMU / KONTROLÜ ────────────────────────────────
router.get('/api/sync/status', (req, res) => res.json({ ...getStatus(), pending: pendingCount() }));
router.get('/api/sync/failed', (req, res) => res.json(failedItems()));
router.get('/api/sync/diagnose', async (req, res) => { try { res.json(await diagnose()); } catch (e) { res.status(500).json({ error: String(e.message || e) }); } });
router.post('/api/sync/retry', (req, res) => res.json(retryFailed()));
router.post('/api/sync/clear-failed', (req, res) => res.json(clearFailed()));
router.post('/api/sync/now', (req, res) => { triggerSync({ reason: 'manual' }); res.json({ ok: true }); });

// ── UPLOAD (api.js: POST /api/index.php?table=upload&bucket=X, multipart 'file') ──
// Genel router.all handler'ından ÖNCE tanımlanmalı ki multer devreye girebilsin.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
router.post('/api/index.php', (req, res, next) => {
  if (req.query.table === 'upload') return next();
  next('route');
}, upload.single('file'), wrap((req, res) => {
  const bucket = req.query.bucket || 'products';
  if (!['products', 'logos', 'categories', 'carousel', 'stories'].includes(bucket)) H.errorResponse('Geçersiz bucket');
  if (bucket !== 'stories') H.requireAuthActive(req);
  if (!req.file) H.errorResponse('Dosya bulunamadı');
  const ext = path.extname(req.file.originalname || '').replace('.', '').toLowerCase() || 'jpg';
  const dir = path.join(getDataDir(), 'uploads', bucket);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${H.uuid()}.${ext}`;
  const absPath = path.join(dir, filename);
  fs.writeFileSync(absPath, req.file.buffer);
  const publicUrl = `/uploads/${bucket}/${filename}`;
  // Dosyayı da kuyruğa al: internet gelince online sunucuya yüklenir ve
  // dönen gerçek URL, bu local yolu içeren tüm bekleyen isteklerde otomatik
  // olarak değiştirilir (sync.js → rewriteLocalUrls). Böylece offline'da
  // eklenen ürün görselleri de online tarafta kaybolmaz.
  try {
    getDB().prepare(`INSERT OR IGNORE INTO url_map (local_url, bucket, file_path) VALUES (?,?,?)`)
      .run(publicUrl, bucket, absPath);
    queueUpload({ bucket, filePath: absPath, localUrl: publicUrl });
  } catch (e) { console.warn('upload kuyruğa alınamadı:', e.message); }
  const mediaType = ['mp4', 'mov', 'webm'].includes(ext) ? 'video' : 'image';
  j(res, { url: publicUrl, publicUrl, path: publicUrl, mediaType });
}));

router.all('/api/index.php', wrap((req, res) => {
  const db = getDB();
  const method = req.method;
  const table = req.query.table || '';
  const action = req.query.action || '';
  const id = req.query.id || '';
  const body = req.body || {};

  // ── AUTH ──────────────────────────────────────────────
  if (table === 'auth') {
    if (method === 'POST' && action === 'login') {
      const email = (body.email || '').trim();
      const password = body.password || '';
      if (!email || !password) H.errorResponse('Email ve şifre gerekli');
      const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      if (!user || !H.bcrypt.compareSync(password, user.password)) H.errorResponse('Email veya şifre hatalı', 401);
      db.prepare(`DELETE FROM sessions WHERE user_id=? AND expires_at < datetime('now')`).run(user.id);
      const token = require('crypto').randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      db.prepare('INSERT INTO sessions (id,user_id,token,expires_at) VALUES (?,?,?,?)').run(H.uuid(), user.id, token, expiresAt);
      let restaurant = null;
      if (user.restaurant_id) restaurant = db.prepare('SELECT * FROM restaurants WHERE id=?').get(user.restaurant_id) || null;
      return j(res, {
        token,
        user: { id: user.id, email: user.email, role: user.role, restaurant_id: user.restaurant_id, permissions: H.resolveUserPermissions(user), role_key: user.role_key || null },
        restaurant,
      });
    }
    if (method === 'POST' && action === 'logout') {
      const h = req.headers['authorization'] || '';
      if (h.startsWith('Bearer ')) db.prepare('DELETE FROM sessions WHERE token=?').run(h.slice(7));
      return j(res, { success: true });
    }
    if (method === 'GET' && action === 'me') {
      const user = H.requireAuth(req);
      const h = req.headers['authorization'] || '';
      const token = h.slice(7);
      const expiresAt = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      db.prepare('UPDATE sessions SET expires_at=? WHERE token=?').run(expiresAt, token);
      let restaurant = null;
      if (user.restaurant_id) restaurant = db.prepare('SELECT * FROM restaurants WHERE id=?').get(user.restaurant_id) || null;
      return j(res, {
        user: { id: user.id, email: user.email, role: user.role, restaurant_id: user.restaurant_id, permissions: H.resolveUserPermissions(user), role_key: user.role_key || null },
        restaurant,
      });
    }
    H.errorResponse('Geçersiz istek', 404);
  }

  // ── RESTAURANTS (sadece okuma + kendi kaydını güncelleme; superadmin CRUD hariç) ──
  if (table === 'restaurants') {
    if (method === 'GET' && !id) {
      if (req.query.public_id) {
        const row = db.prepare(`SELECT * FROM restaurants WHERE id=? AND is_active=1 LIMIT 1`).get(req.query.public_id);
        return j(res, row || null);
      }
      if (req.query.auth_user_id) {
        let sql = 'SELECT * FROM restaurants WHERE auth_user_id=?';
        const params = [req.query.auth_user_id];
        if (req.query.is_active !== undefined) { sql += ' AND is_active=?'; params.push(Number(req.query.is_active)); }
        const row = db.prepare(sql + ' LIMIT 1').get(...params);
        return j(res, row || null);
      }
      if (req.query.restaurant_id) {
        const row = db.prepare('SELECT * FROM restaurants WHERE id=? LIMIT 1').get(req.query.restaurant_id);
        return j(res, row || null);
      }
      const user = H.requireSuperadmin(req);
      return j(res, db.prepare('SELECT * FROM restaurants ORDER BY created_at DESC').all());
    }
    if (method === 'GET' && id) {
      const row = db.prepare('SELECT * FROM restaurants WHERE id=? LIMIT 1').get(id);
      return j(res, row || null);
    }
    if (method === 'PUT' && id) {
      const authUser = H.requireAuthActive(req);
      const fields = [], values = [];
      for (const f of ['name', 'email', 'logo_url', 'phone', 'address', 'city', 'country', 'description', 'plan', 'is_active', 'slug', 'primary_color', 'theme', 'custom_menu_url']) {
        if (Object.prototype.hasOwnProperty.call(body, f)) { fields.push(`${f}=?`); values.push(body[f]); }
      }
      if (!fields.length) H.errorResponse('Alan yok');
      values.push(id);
      db.prepare(`UPDATE restaurants SET ${fields.join(',')} WHERE id=?`).run(...values);
      return j(res, db.prepare('SELECT * FROM restaurants WHERE id=?').get(id));
    }
  }

  // ── CATEGORIES ────────────────────────────────────────
  if (table === 'categories') {
    if (method === 'GET') {
      const rid = req.query.restaurant_id; if (!rid) H.errorResponse('restaurant_id gerekli');
      const rows = db.prepare('SELECT * FROM categories WHERE restaurant_id=? ORDER BY sort_order ASC').all(rid);
      rows.forEach(r => r.translations = parseJsonField(r.translations, {}));
      return j(res, rows);
    }
    if (method === 'POST') {
      const user = H.requireAuthActive(req);
      const rid = H.assertOwnsRestaurant(body.restaurant_id || null, user);
      const cid = H.uuid();
      const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM categories WHERE restaurant_id=?').get(rid).n;
      db.prepare('INSERT INTO categories (id,restaurant_id,name,icon,image_url,sort_order,translations) VALUES (?,?,?,?,?,?,?)')
        .run(cid, rid, body.name, body.icon || null, body.image_url || null, body.sort_order ?? maxSort, JSON.stringify(body.translations || {}));
      const row = db.prepare('SELECT * FROM categories WHERE id=?').get(cid);
      row.translations = parseJsonField(row.translations, {});
      return j(res, row, 201);
    }
    if (method === 'PUT' && id) {
      const user = H.requireAuthActive(req); H.assertOwnsRow('categories', id, user);
      const fields = [], values = [];
      for (const f of ['name', 'icon', 'image_url', 'sort_order', 'translations', 'is_active']) {
        if (Object.prototype.hasOwnProperty.call(body, f)) { fields.push(`${f}=?`); values.push(f === 'translations' ? JSON.stringify(body[f]) : body[f]); }
      }
      if (!fields.length) H.errorResponse('Alan yok');
      values.push(id);
      db.prepare(`UPDATE categories SET ${fields.join(',')} WHERE id=?`).run(...values);
      const row = db.prepare('SELECT * FROM categories WHERE id=?').get(id);
      row.translations = parseJsonField(row.translations, {});
      return j(res, row);
    }
    if (method === 'DELETE' && id) {
      const user = H.requireAuthActive(req); H.assertOwnsRow('categories', id, user);
      db.prepare('DELETE FROM categories WHERE id=?').run(id);
      return j(res, { success: true });
    }
  }

  // ── PRODUCTS ──────────────────────────────────────────
  if (table === 'products') {
    if (method === 'GET') {
      const rid = req.query.restaurant_id; if (!rid) H.errorResponse('restaurant_id gerekli');
      const rows = db.prepare('SELECT * FROM products WHERE restaurant_id=? ORDER BY is_featured DESC, created_at DESC').all(rid);
      rows.forEach(r => r.translations = parseJsonField(r.translations, {}));
      return j(res, rows);
    }
    if (method === 'POST') {
      const user = H.requireAuthActive(req);
      const rid = H.assertOwnsRestaurant(body.restaurant_id || null, user);
      const pid = H.resolveEntityId(body);
      let isAvailable = (body.is_available !== undefined && body.is_available !== '') ? Number(body.is_available) : 1;
      const isFeatured = (body.is_featured !== undefined && body.is_featured !== '') ? Number(body.is_featured) : 0;
      const isHidden = (body.hidden_from_menu !== undefined && body.hidden_from_menu !== '') ? Number(body.hidden_from_menu) : 0;
      const isVatExempt = (body.vat_exempt !== undefined && body.vat_exempt !== '') ? Number(body.vat_exempt) : 0;
      let stockVal = (body.stock !== undefined && body.stock !== '' && body.stock !== null) ? Number(body.stock) : null;
      if (stockVal !== null && stockVal <= 0) isAvailable = 0;
      db.prepare(`INSERT INTO products (id,restaurant_id,category_id,name,description,price,image_url,is_available,is_featured,translations,stock,hidden_from_menu,vat_exempt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(pid, rid, body.category_id || null, body.name, body.description || null, Number(body.price), body.image_url || null, isAvailable, isFeatured, JSON.stringify(body.translations || {}), stockVal, isHidden, isVatExempt);
      const row = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
      row.translations = parseJsonField(row.translations, {});
      return j(res, row, 201);
    }
    if (method === 'PUT' && id) {
      const user = H.requireAuthActive(req); H.assertOwnsRow('products', id, user);
      const fields = [], values = [];
      let oldRow = null;
      if (Object.prototype.hasOwnProperty.call(body, 'stock')) oldRow = db.prepare('SELECT stock, restaurant_id FROM products WHERE id=?').get(id);
      for (const f of ['category_id', 'name', 'description', 'price', 'image_url', 'is_available', 'is_featured', 'translations', 'stock', 'hidden_from_menu', 'vat_exempt']) {
        if (Object.prototype.hasOwnProperty.call(body, f)) {
          fields.push(`${f}=?`);
          if (f === 'translations') values.push(JSON.stringify(body[f]));
          else if (['is_available', 'is_featured', 'hidden_from_menu', 'vat_exempt'].includes(f)) values.push(body[f] !== '' ? Number(body[f]) : 0);
          else if (f === 'price') values.push(Number(body[f]));
          else values.push(body[f]);
        }
      }
      if (!fields.length) H.errorResponse('Alan yok');
      values.push(id);
      db.prepare(`UPDATE products SET ${fields.join(',')} WHERE id=?`).run(...values);
      if (oldRow !== null) {
        const newStockVal = (body.stock !== undefined && body.stock !== '' && body.stock !== null) ? Number(body.stock) : null;
        const oldStockVal = (oldRow.stock !== null && oldRow.stock !== undefined) ? Number(oldRow.stock) : null;
        if (newStockVal !== null && oldStockVal !== newStockVal) {
          const note = body._note ? String(body._note).slice(0, 255) : null;
          db.prepare(`INSERT INTO product_stock_logs (id,restaurant_id,product_id,change_type,qty_before,qty_change,qty_after,note) VALUES (?,?,?,'manual',?,?,?,?)`)
            .run(H.uuid(), oldRow.restaurant_id, id, oldStockVal || 0, newStockVal - (oldStockVal || 0), newStockVal, note);
        }
      }
      const row = db.prepare('SELECT * FROM products WHERE id=?').get(id);
      row.translations = parseJsonField(row.translations, {});
      return j(res, row);
    }
    if (method === 'DELETE' && id) {
      const user = H.requireAuthActive(req); H.assertOwnsRow('products', id, user);
      db.prepare('DELETE FROM products WHERE id=?').run(id);
      return j(res, { success: true });
    }
  }

  // ── PRODUCT VARIANTS ────────────────────────────────────
  if (table === 'product_variants') {
    if (method === 'GET') {
      const pid = req.query.product_id, rid = req.query.restaurant_id;
      let rows;
      if (pid) rows = db.prepare('SELECT * FROM product_variants WHERE product_id=? ORDER BY sort_order ASC').all(pid);
      else if (rid) rows = db.prepare('SELECT * FROM product_variants WHERE restaurant_id=? ORDER BY sort_order ASC').all(rid);
      else H.errorResponse('product_id veya restaurant_id gerekli');
      rows.forEach(r => r.translations = parseJsonField(r.translations, {}));
      return j(res, rows);
    }
    if (method === 'POST') {
      const user = H.requireAuthActive(req);
      const rid = H.assertOwnsRestaurant(body.restaurant_id || null, user);
      if (!body.product_id) H.errorResponse('product_id gerekli');
      const vid = H.uuid();
      db.prepare('INSERT INTO product_variants (id,restaurant_id,product_id,name,price,sort_order,translations) VALUES (?,?,?,?,?,?,?)')
        .run(vid, rid, body.product_id, body.name, Number(body.price), body.sort_order || 0, JSON.stringify(body.translations || {}));
      const row = db.prepare('SELECT * FROM product_variants WHERE id=?').get(vid);
      row.translations = parseJsonField(row.translations, {});
      return j(res, row, 201);
    }
    if (method === 'PUT' && id) {
      const user = H.requireAuthActive(req); H.assertOwnsRow('product_variants', id, user);
      const fields = [], values = [];
      for (const f of ['name', 'price', 'sort_order', 'translations']) {
        if (Object.prototype.hasOwnProperty.call(body, f)) {
          fields.push(`${f}=?`);
          values.push(f === 'translations' ? JSON.stringify(body[f]) : (f === 'price' ? Number(body[f]) : body[f]));
        }
      }
      if (!fields.length) H.errorResponse('Alan yok');
      values.push(id);
      db.prepare(`UPDATE product_variants SET ${fields.join(',')} WHERE id=?`).run(...values);
      const row = db.prepare('SELECT * FROM product_variants WHERE id=?').get(id);
      row.translations = parseJsonField(row.translations, {});
      return j(res, row);
    }
    if (method === 'DELETE' && id) {
      const user = H.requireAuthActive(req); H.assertOwnsRow('product_variants', id, user);
      db.prepare('DELETE FROM product_variants WHERE id=?').run(id);
      return j(res, { success: true });
    }
    if (method === 'DELETE' && !id && req.query.product_id) {
      const user = H.requireAuthActive(req);
      const prow = db.prepare('SELECT restaurant_id FROM products WHERE id=?').get(req.query.product_id);
      if (!prow) H.errorResponse('Ürün bulunamadı', 404);
      H.assertOwnsRestaurant(prow.restaurant_id, user);
      db.prepare('DELETE FROM product_variants WHERE product_id=?').run(req.query.product_id);
      return j(res, { success: true });
    }
  }

  // ── TABLES ────────────────────────────────────────────
  if (table === 'tables') {
    if (method === 'GET') {
      const rid = req.query.restaurant_id; if (!rid) H.errorResponse('restaurant_id gerekli');
      if (req.query.number !== undefined) {
        const row = db.prepare('SELECT * FROM tables WHERE restaurant_id=? AND number=? LIMIT 1').get(rid, req.query.number);
        return j(res, row || null);
      }
      return j(res, db.prepare('SELECT * FROM tables WHERE restaurant_id=? ORDER BY number ASC').all(rid));
    }
    if (method === 'POST') {
      const user = H.requireAuthActive(req);
      const rid = H.assertOwnsRestaurant(body.restaurant_id || null, user);
      const items = Array.isArray(body.rows) ? body.rows : (Array.isArray(body.tables) ? body.tables : [body]);
      const ins = db.prepare('INSERT OR IGNORE INTO tables (id,restaurant_id,number,status,color,label,is_takeaway) VALUES (?,?,?,?,?,?,?)');
      for (const t of items) {
        t.id = t.id || H.uuid();
        ins.run(t.id, rid, t.number, t.status || 'empty', t.color || '#1a1a2e', t.label || null, t.is_takeaway ? 1 : 0);
      }
      return j(res, db.prepare('SELECT * FROM tables WHERE restaurant_id=? ORDER BY number').all(rid), 201);
    }
    if (method === 'PUT' && !id && req.query.restaurant_id) {
      const user = H.requireAuthActive(req);
      const rid = H.assertOwnsRestaurant(req.query.restaurant_id, user);
      const fields = [], values = [];
      for (const f of ['status', 'color']) if (Object.prototype.hasOwnProperty.call(body, f)) { fields.push(`${f}=?`); values.push(body[f]); }
      if (body.status === 'empty') fields.push('opened_at=NULL');
      if (fields.length) {
        const where = ['restaurant_id=?']; const wvals = [rid];
        for (const [k, v] of Object.entries(req.query)) {
          if (k.startsWith('neq_')) { const col = k.slice(4); if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) H.errorResponse('Geçersiz filtre'); where.push(`${col}!=?`); wvals.push(v); }
        }
        db.prepare(`UPDATE tables SET ${fields.join(',')} WHERE ${where.join(' AND ')}`).run(...values, ...wvals);
      }
      return j(res, { success: true });
    }
    if (method === 'PUT' && id) {
      const user = H.requireAuthActive(req); H.assertOwnsRow('tables', id, user);
      const fields = [], values = [];
      for (const f of ['number', 'status', 'color', 'label', 'is_takeaway', 'opened_at', 'zone']) {
        if (Object.prototype.hasOwnProperty.call(body, f)) { fields.push(`${f}=?`); values.push(body[f]); }
      }
      if (Object.prototype.hasOwnProperty.call(body, 'status') && !Object.prototype.hasOwnProperty.call(body, 'opened_at')) {
        if (body.status === 'occupied') fields.push(`opened_at=datetime('now')`);
        else if (body.status === 'empty') fields.push('opened_at=NULL');
      }
      if (!fields.length) H.errorResponse('Alan yok');
      values.push(id);
      db.prepare(`UPDATE tables SET ${fields.join(',')} WHERE id=?`).run(...values);
      const row = db.prepare('SELECT * FROM tables WHERE id=?').get(id);
      return j(res, row);
    }
    if (method === 'DELETE' && id) {
      const user = H.requireAuthActive(req); H.assertOwnsRow('tables', id, user);
      db.prepare('DELETE FROM tables WHERE id=?').run(id);
      return j(res, { success: true });
    }
    if (method === 'DELETE' && !id) {
      H.requireAuthActive(req);
      if (req.query.restaurant_id && req.query.number !== undefined) db.prepare('DELETE FROM tables WHERE restaurant_id=? AND number=?').run(req.query.restaurant_id, req.query.number);
      else if (req.query.restaurant_id) db.prepare('DELETE FROM tables WHERE restaurant_id=?').run(req.query.restaurant_id);
      return j(res, { success: true });
    }
  }

  // ── ORDERS ────────────────────────────────────────────
  if (table === 'orders') {
    if (method === 'POST' && action === 'void_and_reopen') {
      const user = H.requireAuthActive(req);
      if (!body.order_id) H.errorResponse('order_id gerekli');
      const order = H.assertOwnsRow('orders', body.order_id, user);
      if (!(Number(order.is_paid) === 1)) H.errorResponse('Sadece ödenmiş/kapanmış siparişler için bu işlem kullanılabilir.', 400);
      if (order.voided_at) H.errorResponse('Bu sipariş zaten iptal edilmiş', 400);
      const reason = (body.reason || '').trim();
      if (!reason) H.errorResponse('İptal sebebi gerekli', 400);
      const targetTableId = Object.prototype.hasOwnProperty.call(body, 'table_id') ? body.table_id : order.table_id;
      if (targetTableId) {
        const t = db.prepare('SELECT id FROM tables WHERE id=? AND restaurant_id=? LIMIT 1').get(targetTableId, order.restaurant_id);
        if (!t) return res.status(409).json({ error: 'Orijinal masa artık mevcut değil. Lütfen yeni sipariş için bir masa seçin.', table_missing: true });
      }
      const origItems = db.prepare('SELECT product_id, product_name, variant_name, quantity, price FROM order_items WHERE order_id=?').all(body.order_id);
      const newId = body.new_order_id || H.uuid();
      body.new_order_id = newId; // sunucu da aynı id'yi kullansın
      const vatInfo = H.getRestaurantVat(order.restaurant_id);
      let subtotal = 0; for (const it of origItems) subtotal += Number(it.price) * Number(it.quantity);
      const vatAmt = vatInfo.enabled ? Math.round(subtotal * (vatInfo.rate / 100) * 100) / 100 : 0;
      const newTotal = Math.round((subtotal + vatAmt) * 100) / 100;
      db.prepare(`INSERT INTO orders (id,restaurant_id,table_id,status,total,discount_amount,note,is_paid,vat_amount,employee_name) VALUES (?,?,?,?,?,0,?,0,?,?)`)
        .run(newId, order.restaurant_id, targetTableId || null, 'pending', newTotal, 'Düzeltme: iptal edilen siparişin yerine açıldı', vatAmt, order.employee_name);
      if (origItems.length) {
        const itemCosts = H.deductRecipeStock(order.restaurant_id, origItems, newId);
        const insItem = db.prepare('INSERT INTO order_items (id,restaurant_id,order_id,product_id,product_name,variant_name,quantity,price,ingredient_cost) VALUES (?,?,?,?,?,?,?,?,?)');
        body.new_item_ids = Array.isArray(body.new_item_ids) ? body.new_item_ids : [];
        origItems.forEach((item, idx) => {
          const iid = body.new_item_ids[idx] || H.uuid();
          body.new_item_ids[idx] = iid;
          insItem.run(iid, order.restaurant_id, newId, item.product_id, item.product_name, item.variant_name, item.quantity, item.price, itemCosts[idx] ?? null);
        });
      }
      db.prepare('UPDATE orders SET voided_at=datetime(\'now\'), void_reason=?, replacement_order_id=? WHERE id=?').run(reason, newId, body.order_id);
      if (targetTableId) db.prepare(`UPDATE tables SET status='occupied' WHERE id=?`).run(targetTableId);
      const voidedOrder = db.prepare('SELECT * FROM orders WHERE id=?').get(body.order_id);
      const newOrder = db.prepare('SELECT * FROM orders WHERE id=?').get(newId);
      return j(res, { voided_order: voidedOrder, new_order: newOrder }, 201);
    }

    if (method === 'POST' && action === 'close_day') {
      const user = H.requireAuthActive(req);
      const rid = H.getMyRestaurantId(user);
      db.prepare(`UPDATE orders SET status='completed' WHERE restaurant_id=? AND status NOT IN ('completed')`).run(rid);
      db.prepare(`UPDATE tables SET status='empty' WHERE restaurant_id=? AND status!='empty'`).run(rid);
      db.prepare(`UPDATE settings SET is_day_closed=1, last_closed_at=datetime('now') WHERE restaurant_id=?`).run(rid);
      return j(res, { success: true });
    }

    if (method === 'GET') {
      let rid = req.query.restaurant_id || '';
      const byTable = req.query.table_id !== undefined;
      if (!rid && byTable) {
        const t = db.prepare('SELECT restaurant_id FROM tables WHERE id=? LIMIT 1').get(req.query.table_id);
        rid = t ? t.restaurant_id : '';
      }
      if (!rid) H.errorResponse('restaurant_id veya table_id gerekli', 400);
      if (!byTable) { const user = H.requireAuthActive(req); H.assertOwnsRestaurant(rid, user); }

      let sql = 'SELECT * FROM orders WHERE restaurant_id=?';
      const params = [rid];
      if (req.query.status) { const statuses = req.query.status.split(',').map(s => s.trim()); sql += ` AND status IN (${statuses.map(() => '?').join(',')})`; params.push(...statuses); }
      if (req.query.table_id !== undefined) { sql += ' AND table_id=?'; params.push(req.query.table_id); }
      if (req.query.date_from) { sql += ' AND created_at>=?'; params.push(req.query.date_from); }
      if (req.query.date_to) { sql += ' AND created_at<=?'; params.push(req.query.date_to); }
      const allowedFilterCols = ['id', 'created_at', 'updated_at', 'total', 'status', 'is_paid', 'ready_at', 'served_at', 'paid_at', 'discount_amount'];
      for (const [k, v] of Object.entries(req.query)) {
        let col = null, op = null;
        if (k.startsWith('gte_')) { col = k.slice(4); op = '>='; }
        else if (k.startsWith('lte_')) { col = k.slice(4); op = '<='; }
        else if (k.startsWith('gt_')) { col = k.slice(3); op = '>'; }
        else if (k.startsWith('lt_')) { col = k.slice(3); op = '<'; }
        if (col !== null) {
          if (!allowedFilterCols.includes(col)) H.errorResponse('Geçersiz filtre alanı');
          const val = H.toMysqlDate(v);
          if (col === 'paid_at') { sql += ` AND (paid_at ${op} ? OR (paid_at IS NULL AND created_at ${op} ?))`; params.push(val, val); }
          else { sql += ` AND ${col} ${op} ?`; params.push(val); }
        }
      }
      sql += ' ORDER BY created_at ASC';
      const rows = db.prepare(sql).all(...params);
      const itemStmt = db.prepare('SELECT id,product_id,product_name,variant_name,quantity,price,created_at,is_ready,sent_to_kitchen,ingredient_cost FROM order_items WHERE order_id=?');
      for (const r of rows) { r.order_items = itemStmt.all(r.id); r.total = Number(r.total || 0); r.is_paid = Number(r.is_paid || 0); }
      return j(res, rows);
    }

    if (method === 'POST' && action !== 'close_day') {
      const oid = H.resolveEntityId(body);
      let rid;
      if (body.table_id) {
        const t = db.prepare('SELECT restaurant_id FROM tables WHERE id=? LIMIT 1').get(body.table_id);
        if (!t) H.errorResponse('Masa bulunamadı', 404);
        rid = t.restaurant_id;
      } else {
        const user = H.requireAuthActive(req);
        rid = H.assertOwnsRestaurant(body.restaurant_id || null, user);
      }
      if (body.order_items && body.order_items.length) {
        for (const item of body.order_items) {
          if (item.product_id) {
            const p = db.prepare('SELECT id FROM products WHERE id=? AND restaurant_id=? LIMIT 1').get(item.product_id, rid);
            if (!p) H.errorResponse('Geçersiz ürün', 400);
          }
        }
      }
      H.checkRestaurantOpen(rid);
      if (body.order_items && body.order_items.length) {
        H.checkRecipeStockSufficiency(rid, body.order_items);
        H.checkProductStockSufficiency(rid, body.order_items);
      }
      const discountAmt = Number(body.discount_amount || 0);
      const vatInfo = H.getRestaurantVat(rid);
      let finalTotal, vatAmt;
      if (body.order_items && body.order_items.length) {
        let subtotalCalc = 0;
        for (const it of body.order_items) subtotalCalc += Number(it.price || 0) * Number(it.quantity || 0);
        const afterDiscount = Math.max(0, subtotalCalc - discountAmt);
        vatAmt = vatInfo.enabled ? Math.round(afterDiscount * (vatInfo.rate / 100) * 100) / 100 : 0;
        finalTotal = Math.round((afterDiscount + vatAmt) * 100) / 100;
      } else {
        const baseTotal = Number(body.total || 0);
        vatAmt = vatInfo.enabled ? Math.round(baseTotal * (vatInfo.rate / 100) * 100) / 100 : 0;
        finalTotal = Math.round((baseTotal + vatAmt) * 100) / 100;
      }
      db.prepare(`INSERT INTO orders (id,restaurant_id,table_id,status,total,discount_amount,note,is_paid,vat_amount,employee_name) VALUES (?,?,?,?,?,?,?,0,?,?)`)
        .run(oid, rid, body.table_id || null, 'pending', finalTotal, discountAmt, body.note || null, vatAmt, body.employee_name || null);
      let itemCosts = {};
      if (body.order_items && body.order_items.length) {
        itemCosts = H.deductRecipeStock(rid, body.order_items, oid);
        const ins = db.prepare('INSERT INTO order_items (id,restaurant_id,order_id,product_id,product_name,variant_name,quantity,price,ingredient_cost) VALUES (?,?,?,?,?,?,?,?,?)');
        // KRİTİK (id tutarlılığı): kalem id'leri BURADA üretilip req.body'ye de
        // yazılıyor. Böylece aynı id'ler sync kuyruğuyla online sunucuya gider.
        // Eskiden id gönderilmediği için sunucu kendi id'lerini üretiyor, sonraki
        // her PUT/DELETE o kalemi bulamayıp hata veriyordu (hatalar katlanıyordu).
        body.order_items.forEach((item, idx) => {
          item.id = item.id || H.uuid();
          ins.run(item.id, rid, oid, item.product_id || null, item.product_name, item.variant_name || null, item.quantity, item.price, itemCosts[idx] ?? null);
        });
        H.deductSimpleProductStock(rid, body.order_items);
      }
      if (body.table_id) db.prepare(`UPDATE tables SET status='occupied' WHERE id=?`).run(body.table_id);
      const newOrder = db.prepare('SELECT * FROM orders WHERE id=?').get(oid);
      newOrder.order_items = db.prepare('SELECT id,product_name,variant_name,quantity,price,ingredient_cost FROM order_items WHERE order_id=?').all(oid);
      return j(res, newOrder, 201);
    }

    if (method === 'PUT' && id) {
      const user = H.requireAuthActive(req);
      const existing = H.assertOwnsRow('orders', id, user);
      const wasPaid = Number(existing.is_paid) === 1;
      if (wasPaid) {
        const onlyReprint = Object.keys(body).every(k => k === 'receipt_printed_at');
        if (!onlyReprint) H.errorResponse('Ödenmiş sipariş kaydı değiştirilemez. Düzeltme gerekiyorsa iade/iptal kaydı oluşturun.', 400);
      }
      const fields = [], values = [];
      for (const f of ['status', 'total', 'note', 'is_paid', 'table_id', 'ready_at', 'served_at', 'payment_method', 'discount_amount', 'paid_at', 'bank_name', 'delivery_company', 'receipt_printed_at']) {
        if (Object.prototype.hasOwnProperty.call(body, f)) {
          fields.push(`${f}=?`);
          if (['ready_at', 'served_at', 'paid_at', 'receipt_printed_at'].includes(f) && body[f]) values.push(H.toMysqlDate(body[f]));
          else values.push(body[f]);
        }
      }
      if (!fields.length) H.errorResponse('Alan yok');
      values.push(id);
      db.prepare(`UPDATE orders SET ${fields.join(',')} WHERE id=?`).run(...values);
      const order = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
      return j(res, order);
    }

    if (method === 'PUT' && !id && req.query.restaurant_id) {
      const user = H.requireAuthActive(req);
      const rid = H.assertOwnsRestaurant(req.query.restaurant_id, user);
      const payFields = [], payValues = [], statusOnly = [], statusValues = [];
      for (const f of ['is_paid', 'payment_method', 'discount_amount', 'paid_at', 'bank_name', 'delivery_company']) {
        if (Object.prototype.hasOwnProperty.call(body, f)) { payFields.push(`${f}=?`); payValues.push(f === 'paid_at' && body[f] ? H.toMysqlDate(body[f]) : body[f]); }
      }
      if (Object.prototype.hasOwnProperty.call(body, 'status')) { statusOnly.push('status=?'); statusValues.push(body.status); }
      const where = ['restaurant_id=?']; const wvals = [rid];
      if (req.query.table_id !== undefined) { where.push('table_id=?'); wvals.push(req.query.table_id); }
      if (req.query.neq_status !== undefined) { where.push('status!=?'); wvals.push(req.query.neq_status); }
      if (req.query.status !== undefined) { const statuses = req.query.status.split(',').map(s => s.trim()); where.push(`status IN (${statuses.map(() => '?').join(',')})`); wvals.push(...statuses); }
      const allowedFilterCols = ['id', 'created_at', 'updated_at', 'total', 'status'];
      for (const [k, v] of Object.entries(req.query)) {
        if (k.startsWith('gt_')) { const col = k.slice(3); if (!allowedFilterCols.includes(col)) H.errorResponse('Geçersiz filtre alanı'); where.push(`${col}>?`); wvals.push(v); }
      }
      const whereSql = where.join(' AND ');
      if (payFields.length) db.prepare(`UPDATE orders SET ${payFields.join(',')} WHERE ${whereSql} AND (is_paid=0 OR is_paid IS NULL)`).run(...payValues, ...wvals);
      if (statusOnly.length) db.prepare(`UPDATE orders SET ${statusOnly.join(',')} WHERE ${whereSql}`).run(...statusValues, ...wvals);
      return j(res, { success: true });
    }

    if (method === 'DELETE' && id) {
      const user = H.requireAuthActive(req);
      const o = H.assertOwnsRow('orders', id, user);
      if (Number(o.is_paid) === 1) H.errorResponse('Ödenmiş sipariş silinemez. Düzeltme gerekiyorsa iade/iptal kaydı oluşturun.', 400);
      const itemsToRestore = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id=?').all(id);
      db.prepare('DELETE FROM order_items WHERE order_id=?').run(id);
      db.prepare('DELETE FROM orders WHERE id=?').run(id);
      if (itemsToRestore.length) H.restoreRecipeStock(o.restaurant_id, itemsToRestore, id);
      return j(res, { success: true });
    }
  }

  // ── ORDER_REFUNDS ─────────────────────────────────────
  if (table === 'order_refunds') {
    if (method === 'GET') {
      const user = H.requireAuthActive(req);
      const rid = H.assertOwnsRestaurant(req.query.restaurant_id || null, user);
      return j(res, db.prepare('SELECT * FROM order_refunds WHERE restaurant_id=? ORDER BY created_at DESC').all(rid));
    }
    if (method === 'POST') {
      const user = H.requireAuthActive(req);
      const rid = H.assertOwnsRestaurant(body.restaurant_id || null, user);
      if (!body.order_id) H.errorResponse('order_id gerekli');
      const rfid = H.uuid();
      db.prepare('INSERT INTO order_refunds (id,restaurant_id,order_id,amount,reason,employee_name) VALUES (?,?,?,?,?,?)')
        .run(rfid, rid, body.order_id, Number(body.amount || 0), body.reason || null, body.employee_name || null);
      return j(res, db.prepare('SELECT * FROM order_refunds WHERE id=?').get(rfid), 201);
    }
  }

  // ── ORDER ITEMS ────────────────────────────────────────
  if (table === 'order_items') {
    if (method === 'POST') {
      const user = H.requireAuthActive(req);
      const items = Array.isArray(body) ? body : (body[0] !== undefined ? body : [body]);
      let rid = null; const orderIds = new Set();
      for (const item of items) {
        if (!item.order_id) H.errorResponse('order_id gerekli');
        const o = H.assertOwnsRow('orders', item.order_id, user);
        if (Number(o.is_paid) === 1) H.errorResponse('Ödenmiş siparişe ürün eklenemez', 400);
        if (rid === null) rid = o.restaurant_id; else if (rid !== o.restaurant_id) H.errorResponse('Yetki yetersiz', 403);
        orderIds.add(item.order_id);
      }
      H.checkRecipeStockSufficiency(rid, items);
      H.checkProductStockSufficiency(rid, items);
      const itemCosts = H.deductRecipeStock(rid, items);
      const ins = db.prepare('INSERT INTO order_items (id,restaurant_id,order_id,product_id,product_name,variant_name,quantity,price,ingredient_cost) VALUES (?,?,?,?,?,?,?,?,?)');
      // id'ler burada üretilir ve gövdeye yazılır → online sunucu AYNI id ile kaydeder.
      items.forEach((item, idx) => {
        item.id = item.id || H.uuid();
        ins.run(item.id, rid, item.order_id, item.product_id || null, item.product_name, item.variant_name || null, Number(item.quantity), Number(item.price), itemCosts[idx] ?? null);
      });
      H.deductSimpleProductStock(rid, items);
      const employeeName = items.find(i => i.employee_name)?.employee_name || null;
      for (const oid of orderIds) {
        const ordBase = db.prepare('SELECT restaurant_id, discount_amount FROM orders WHERE id=?').get(oid);
        const calc = H.computeOrderTotalFromItems(ordBase.restaurant_id || rid, oid, ordBase.discount_amount || 0);
        if (employeeName) db.prepare('UPDATE orders SET employee_name=? WHERE id=?').run(employeeName, oid);
        db.prepare('UPDATE orders SET total=?, vat_amount=? WHERE id=?').run(calc.total, calc.vat_amount, oid);
      }
      return j(res, { success: true }, 201);
    }
    if (method === 'PUT' && id) {
      const user = H.requireAuthActive(req);
      const itemRow = db.prepare('SELECT * FROM order_items WHERE id=?').get(id);
      if (!itemRow) H.errorResponse('Kalem bulunamadı', 404);
      if (user.role !== 'superadmin' && (itemRow.restaurant_id || null) !== (user.restaurant_id || null)) H.errorResponse('Yetki yetersiz', 403);
      const oldQty = Number(itemRow.quantity);
      if (Object.prototype.hasOwnProperty.call(body, 'quantity')) {
        const ord0 = db.prepare('SELECT is_paid FROM orders WHERE id=?').get(itemRow.order_id);
        if (ord0 && Number(ord0.is_paid) === 1) H.errorResponse('Ödenmiş siparişteki ürün adedi değiştirilemez', 400);
      }
      const fields = [], values = [];
      for (const f of ['is_ready', 'sent_to_kitchen', 'quantity']) if (Object.prototype.hasOwnProperty.call(body, f)) { fields.push(`${f}=?`); values.push(Number(body[f])); }
      if (!fields.length) H.errorResponse('Alan yok');
      values.push(id);
      db.prepare(`UPDATE order_items SET ${fields.join(',')} WHERE id=?`).run(...values);
      if (Object.prototype.hasOwnProperty.call(body, 'quantity')) {
        const newQty = Number(body.quantity);
        const diff = newQty - oldQty;
        if (diff > 0 && itemRow.product_id) H.deductRecipeStock(itemRow.restaurant_id, [{ product_id: itemRow.product_id, quantity: diff }], itemRow.order_id);
        else if (diff < 0 && itemRow.product_id) H.restoreRecipeStock(itemRow.restaurant_id, [{ product_id: itemRow.product_id, quantity: Math.abs(diff) }], itemRow.order_id);
        const ordBase2 = db.prepare('SELECT restaurant_id, discount_amount FROM orders WHERE id=?').get(itemRow.order_id);
        if (ordBase2) {
          const calc2 = H.computeOrderTotalFromItems(ordBase2.restaurant_id, itemRow.order_id, ordBase2.discount_amount || 0);
          db.prepare('UPDATE orders SET total=?, vat_amount=? WHERE id=?').run(calc2.total, calc2.vat_amount, itemRow.order_id);
        }
      }
      if (body.is_ready !== undefined && Number(body.is_ready) === 1) {
        const counts = db.prepare('SELECT COUNT(*) AS total, SUM(is_ready) AS done FROM order_items WHERE order_id=?').get(itemRow.order_id);
        if (counts && Number(counts.total) > 0 && Number(counts.total) === Number(counts.done)) {
          db.prepare(`UPDATE orders SET status='ready' WHERE id=?`).run(itemRow.order_id);
        }
      }
      return j(res, db.prepare('SELECT * FROM order_items WHERE id=?').get(id));
    }
    if (method === 'DELETE' && !id && req.query.order_id) {
      const user = H.requireAuthActive(req);
      const ord0 = H.assertOwnsRow('orders', req.query.order_id, user);
      if (Number(ord0.is_paid) === 1) H.errorResponse('Ödenmiş siparişten ürün silinemez', 400);
      db.prepare('DELETE FROM order_items WHERE order_id=?').run(req.query.order_id);
      return j(res, { success: true });
    }
    if (method === 'DELETE' && id) {
      const user = H.requireAuthActive(req);
      const item = db.prepare('SELECT * FROM order_items WHERE id=?').get(id);
      if (!item) H.errorResponse('Kalem bulunamadı', 404);
      if (user.role !== 'superadmin' && (item.restaurant_id || null) !== (user.restaurant_id || null)) H.errorResponse('Yetki yetersiz', 403);
      const ord0 = db.prepare('SELECT is_paid FROM orders WHERE id=?').get(item.order_id);
      if (ord0 && Number(ord0.is_paid) === 1) H.errorResponse('Ödenmiş siparişten ürün silinemez', 400);
      db.prepare('DELETE FROM order_items WHERE id=?').run(id);
      H.restoreRecipeStock(item.restaurant_id, [{ product_id: item.product_id, quantity: item.quantity }], item.order_id);
      const ordBase3 = db.prepare('SELECT restaurant_id, discount_amount FROM orders WHERE id=?').get(item.order_id);
      if (ordBase3) {
        const calc3 = H.computeOrderTotalFromItems(ordBase3.restaurant_id || item.restaurant_id, item.order_id, ordBase3.discount_amount || 0);
        if (calc3.subtotal <= 0) db.prepare('DELETE FROM orders WHERE id=?').run(item.order_id);
        else db.prepare('UPDATE orders SET total=?, vat_amount=? WHERE id=?').run(calc3.total, calc3.vat_amount, item.order_id);
      }
      return j(res, { success: true });
    }
  }

  // ── INGREDIENTS ────────────────────────────────────────
  if (table === 'ingredients') {
    if (method === 'GET') {
      const rid = req.query.restaurant_id; if (!rid) H.errorResponse('restaurant_id gerekli');
      if (req.query.low_stock !== undefined) return j(res, db.prepare('SELECT * FROM ingredients WHERE restaurant_id=? AND min_stock > 0 AND stock <= min_stock ORDER BY (stock*1.0/min_stock) ASC').all(rid));
      if (req.query.category) return j(res, db.prepare('SELECT * FROM ingredients WHERE restaurant_id=? AND category=? ORDER BY name ASC').all(rid, req.query.category));
      return j(res, db.prepare('SELECT * FROM ingredients WHERE restaurant_id=? ORDER BY name ASC').all(rid));
    }
    if (method === 'POST' && (action === 'bulk_update' || req.query.bulk !== undefined)) {
      const user = H.requireAuthActive(req);
      const rid = H.assertOwnsRestaurant(req.query.restaurant_id || null, user);
      if (!Array.isArray(body)) H.errorResponse('Dizi gerekli');
      const upd = db.prepare(`UPDATE ingredients SET stock=?, updated_at=datetime('now') WHERE id=? AND restaurant_id=?`);
      const affectedIngIds = [];
      for (const row of body) { if (!row.id || row.stock === undefined) continue; upd.run(Number(row.stock), row.id, rid); affectedIngIds.push(row.id); }
      if (affectedIngIds.length) {
        const ph = affectedIngIds.map(() => '?').join(',');
        const pids = db.prepare(`SELECT DISTINCT product_id FROM recipes WHERE ingredient_id IN (${ph})`).all(...affectedIngIds).map(r => r.product_id);
        if (pids.length) H.refreshProductAvailability(pids);
      }
      return j(res, { success: true, updated: affectedIngIds.length });
    }
    if (method === 'POST') {
      const user = H.requireAuthActive(req);
      const rid = H.assertOwnsRestaurant(body.restaurant_id || null, user);
      const iid = H.uuid();
      db.prepare('INSERT INTO ingredients (id,restaurant_id,name,unit,stock,min_stock,cost_per_unit,category,supplier) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(iid, rid, body.name, body.unit || 'gr', body.stock || 0, body.min_stock || 0, body.cost_per_unit || 0, body.category || null, body.supplier || null);
      return j(res, db.prepare('SELECT * FROM ingredients WHERE id=?').get(iid), 201);
    }
    if (method === 'PUT' && id) {
      const user = H.requireAuthActive(req);
      const existing = H.assertOwnsRow('ingredients', id, user);
      const oldStock = Number(existing.stock || 0);
      const fields = [], values = [];
      for (const f of ['name', 'unit', 'stock', 'min_stock', 'cost_per_unit', 'category', 'supplier']) if (Object.prototype.hasOwnProperty.call(body, f)) { fields.push(`${f}=?`); values.push(body[f]); }
      if (!fields.length) H.errorResponse('Alan yok');
      values.push(id);
      db.prepare(`UPDATE ingredients SET ${fields.join(',')} WHERE id=?`).run(...values);
      if (Object.prototype.hasOwnProperty.call(body, 'stock')) {
        const newStock = Number(body.stock); const change = newStock - oldStock;
        const noteText = body._note || 'Manuel güncelleme';
        if (Math.abs(change) > 0.0001) db.prepare(`INSERT INTO stock_logs (id,restaurant_id,ingredient_id,change_type,qty_before,qty_change,qty_after,note) VALUES (?,?,?,'manual',?,?,?,?)`).run(H.uuid(), existing.restaurant_id, id, oldStock, change, newStock, noteText);
        const pids = db.prepare('SELECT DISTINCT product_id FROM recipes WHERE ingredient_id=?').all(id).map(r => r.product_id);
        if (pids.length) H.refreshProductAvailability(pids);
      }
      return j(res, db.prepare('SELECT * FROM ingredients WHERE id=?').get(id));
    }
    if (method === 'DELETE' && id) { const user = H.requireAuthActive(req); H.assertOwnsRow('ingredients', id, user); db.prepare('DELETE FROM ingredients WHERE id=?').run(id); return j(res, { success: true }); }
  }

  // ── STOCK LOGS ─────────────────────────────────────────
  if (table === 'stock_logs') {
    const user = H.requireAuthActive(req);
    const rid = H.assertOwnsRestaurant(req.query.restaurant_id || null, user);
    if (method === 'GET') {
      let sql = 'SELECT sl.*, i.name AS ingredient_name, i.unit FROM stock_logs sl LEFT JOIN ingredients i ON i.id=sl.ingredient_id WHERE sl.restaurant_id=?';
      const params = [rid];
      if (req.query.ingredient_id) { sql += ' AND sl.ingredient_id=?'; params.push(req.query.ingredient_id); }
      if (req.query.from) { sql += ' AND sl.created_at>=?'; params.push(req.query.from + ' 00:00:00'); }
      if (req.query.to) { sql += ' AND sl.created_at<=?'; params.push(req.query.to + ' 23:59:59'); }
      if (req.query.change_type) { sql += ' AND sl.change_type=?'; params.push(req.query.change_type); }
      sql += ' ORDER BY sl.created_at DESC LIMIT ' + Math.min(Number(req.query.limit || 200), 500);
      return j(res, db.prepare(sql).all(...params));
    }
  }

  // ── PRODUCT STOCK LOGS ─────────────────────────────────
  if (table === 'product_stock_logs') {
    const user = H.requireAuthActive(req);
    const rid = H.assertOwnsRestaurant(req.query.restaurant_id || null, user);
    if (method === 'GET') {
      let sql = 'SELECT psl.*, p.name AS product_name FROM product_stock_logs psl LEFT JOIN products p ON p.id=psl.product_id WHERE psl.restaurant_id=?';
      const params = [rid];
      if (req.query.product_id) { sql += ' AND psl.product_id=?'; params.push(req.query.product_id); }
      if (req.query.from) { sql += ' AND psl.created_at>=?'; params.push(req.query.from + ' 00:00:00'); }
      if (req.query.to) { sql += ' AND psl.created_at<=?'; params.push(req.query.to + ' 23:59:59'); }
      if (req.query.change_type) { sql += ' AND psl.change_type=?'; params.push(req.query.change_type); }
      sql += ' ORDER BY psl.created_at DESC LIMIT ' + Math.min(Number(req.query.limit || 200), 500);
      return j(res, db.prepare(sql).all(...params));
    }
  }

  // ── RECIPES ────────────────────────────────────────────
  if (table === 'recipes') {
    if (method === 'GET') {
      const pid = req.query.product_id, rid = req.query.restaurant_id;
      if (pid) return j(res, db.prepare('SELECT r.*, i.name AS ingredient_name, i.unit AS ingredient_unit, i.stock AS ingredient_stock, i.cost_per_unit FROM recipes r JOIN ingredients i ON i.id=r.ingredient_id WHERE r.product_id=? ORDER BY i.name ASC').all(pid));
      if (rid) return j(res, db.prepare('SELECT r.*, i.name AS ingredient_name, i.unit AS ingredient_unit FROM recipes r JOIN ingredients i ON i.id=r.ingredient_id WHERE r.restaurant_id=?').all(rid));
      H.errorResponse('restaurant_id veya product_id gerekli');
    }
    if (method === 'POST') {
      const user = H.requireAuthActive(req);
      const rid = H.assertOwnsRestaurant(body.restaurant_id || null, user);
      const pid = body.product_id;
      if (!pid) H.errorResponse('product_id gerekli');
      const p = db.prepare('SELECT id FROM products WHERE id=? AND restaurant_id=?').get(pid, rid);
      if (!p) H.errorResponse('Geçersiz ürün', 400);
      db.prepare('DELETE FROM recipes WHERE product_id=?').run(pid);
      const items = body.items || [];
      const ins = db.prepare('INSERT INTO recipes (id,restaurant_id,product_id,ingredient_id,amount) VALUES (?,?,?,?,?)');
      for (const it of items) {
        if (!it.ingredient_id || !it.amount || Number(it.amount) <= 0) continue;
        it.id = it.id || H.uuid();
        ins.run(it.id, rid, pid, it.ingredient_id, it.amount);
      }
      return j(res, db.prepare('SELECT r.*, i.name AS ingredient_name, i.unit AS ingredient_unit FROM recipes r JOIN ingredients i ON i.id=r.ingredient_id WHERE r.product_id=?').all(pid), 201);
    }
    if (method === 'DELETE' && id) { const user = H.requireAuthActive(req); H.assertOwnsRow('recipes', id, user); db.prepare('DELETE FROM recipes WHERE id=?').run(id); return j(res, { success: true }); }
  }

  // ── SETTINGS ───────────────────────────────────────────
  if (table === 'settings') {
    const JSON_FIELDS = ['custom_roles', 'bank_names', 'delivery_companies', 'kitchen_stations', 'table_zones', 'enabled_languages', 'admin_enabled_languages'];
    const decorate = (row) => {
      if (!row) return row;
      row.custom_roles = parseJsonField(row.custom_roles, []);
      row.bank_names = parseJsonField(row.bank_names, []);
      row.delivery_companies = parseJsonField(row.delivery_companies, []);
      row.kitchen_stations = parseJsonField(row.kitchen_stations, []);
      row.table_zones = parseJsonField(row.table_zones, []);
      row.enabled_languages = parseJsonField(row.enabled_languages, ['tr', 'en', 'ru', 'ka', 'az']);
      row.admin_enabled_languages = parseJsonField(row.admin_enabled_languages, ['tr', 'en', 'ru', 'ka', 'az']);
      row.default_admin_lang = row.default_admin_lang || 'tr';
      return row;
    };
    if (method === 'POST' && action === 'host_heartbeat') {
      const rid = req.query.restaurant_id; if (!rid) H.errorResponse('restaurant_id gerekli');
      const deviceId = (body.device_id || '').trim();
      if (!deviceId) H.errorResponse('device_id gerekli');
      const cur = db.prepare('SELECT phone_order_print_device_id, host_device_enabled FROM settings WHERE restaurant_id=? LIMIT 1').get(rid);
      if (!cur || !cur.host_device_enabled || String(cur.phone_order_print_device_id) !== deviceId) H.errorResponse('Bu cihaz ana bilgisayar olarak tanınmıyor', 403);
      db.prepare(`UPDATE settings SET host_device_last_seen=datetime('now') WHERE restaurant_id=?`).run(rid);
      return j(res, { ok: true });
    }
    if (method === 'GET') {
      const rid = req.query.restaurant_id; if (!rid) H.errorResponse('restaurant_id gerekli');
      const row = db.prepare('SELECT * FROM settings WHERE restaurant_id=? LIMIT 1').get(rid);
      if (row) {
        decorate(row);
        row.host_device_online = row.host_device_last_seen ? ((Date.now() - new Date(row.host_device_last_seen + 'Z').getTime()) / 1000 <= 40) : false;
        const authUser = H.getAuthUser(req);
        const isOwner = authUser && (authUser.role === 'superadmin' || (authUser.restaurant_id || null) === rid);
        if (!isOwner) for (const secret of ['delete_pin', 'pin_enabled', 'revenue_pin', 'bog_client_id', 'bog_client_secret', 'custom_roles', 'openai_api_key', 'groq_api_key', 'gemini_api_key']) delete row[secret];
      }
      return j(res, row || null);
    }
    if (method === 'PUT') {
      const user = H.requireAuthActive(req);
      const rid = H.assertOwnsRestaurant(req.query.restaurant_id || null, user);
      const boolFields = ['vat_enabled', 'is_open', 'is_day_closed', 'stock_enabled', 'recipe_stock_enabled', 'pos_category_first_enabled', 'pos_category_no_photo_enabled', 'menu_category_first_enabled', 'pin_enabled', 'bog_payment_enabled', 'break_overtime_alert', 'kitchen_auto_print', 'phone_order_auto_print', 'pos_send_auto_print', 'host_device_enabled', 'host_device_no_pin_delete', 'day_close_report_print', 'expenses_enabled', 'az_translate_products', 'schedule_enabled'];
      const allFields = ['site_name', 'currency', 'logo_url', 'vat_enabled', 'vat_rate', 'is_open', 'is_day_closed', 'last_closed_at', 'timezone', 'stock_enabled', 'recipe_stock_enabled', 'pos_category_first_enabled', 'pos_category_no_photo_enabled', 'menu_category_first_enabled', 'delete_pin', 'pin_enabled', 'bog_payment_enabled', 'bog_client_id', 'bog_client_secret', 'custom_roles', 'bank_names', 'delivery_companies', 'kitchen_stations', 'table_zones', 'kitchen_auto_print', 'phone_order_auto_print', 'pos_send_auto_print', 'phone_order_print_device_id', 'phone_order_print_device_name', 'host_device_enabled', 'host_device_no_pin_delete', 'day_close_report_print', 'expenses_enabled', 'printer_width_mm', 'revenue_pin', 'kitchen_ticket_lang1', 'kitchen_ticket_lang2', 'receipt_ticket_lang1', 'receipt_ticket_lang2', 'default_break_minutes', 'break_overtime_alert', 'enabled_languages', 'az_translate_products', 'schedule_enabled', 'instagram_url', 'gmail', 'location_url', 'google_reviews_url', 'contact_phone', 'working_hours', 'working_days', 'location_lat', 'location_lng', 'admin_enabled_languages', 'default_admin_lang', 'openai_api_key', 'groq_api_key', 'gemini_api_key', 'ai_order_provider'];
      const fields = [], values = [];
      for (const f of allFields) {
        if (Object.prototype.hasOwnProperty.call(body, f)) {
          fields.push(`${f}=?`);
          if (boolFields.includes(f)) values.push(body[f] !== '' ? Number(body[f]) : 0);
          else if (f === 'printer_width_mm') values.push(Number(body[f] || 80) === 58 ? 58 : 80);
          else if (f === 'default_break_minutes') values.push(Math.max(5, Number(body[f] || 15)));
          else if (JSON_FIELDS.includes(f)) values.push(JSON.stringify(Array.isArray(body[f]) || typeof body[f] === 'object' ? body[f] : []));
          else if (['location_lat', 'location_lng'].includes(f)) values.push(body[f] === null || body[f] === '' ? null : Number(body[f]));
          else if (f === 'vat_rate') values.push(Number(body[f]));
          else if (f === 'last_closed_at' && body[f]) values.push(H.toMysqlDate(body[f]));
          else values.push(body[f]);
        }
      }
      if (!fields.length) H.errorResponse('Alan yok');
      values.push(rid);
      const ex = db.prepare('SELECT id FROM settings WHERE restaurant_id=?').get(rid);
      if (ex) db.prepare(`UPDATE settings SET ${fields.join(',')} WHERE restaurant_id=?`).run(...values);
      else { db.prepare('INSERT INTO settings (id,restaurant_id) VALUES (?,?)').run(H.uuid(), rid); db.prepare(`UPDATE settings SET ${fields.join(',')} WHERE restaurant_id=?`).run(...values); }
      const row = db.prepare('SELECT * FROM settings WHERE restaurant_id=?').get(rid);
      decorate(row);
      return j(res, row);
    }
  }

  // ── EXPENSES ───────────────────────────────────────────
  if (table === 'expenses') {
    const user = H.requireAuthActive(req);
    if (method === 'GET') {
      const rid = H.assertOwnsRestaurant(req.query.restaurant_id || user.restaurant_id || null, user);
      const where = ['restaurant_id=?']; const wvals = [rid];
      if (req.query.gt_created_at) { where.push('created_at>?'); wvals.push(H.toMysqlDate(req.query.gt_created_at)); }
      const limit = Number(req.query._limit || req.query.limit || 200);
      const rows = db.prepare(`SELECT * FROM expenses WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...wvals, limit);
      rows.forEach(r => r.amount = Number(r.amount || 0));
      return j(res, rows);
    }
    if (method === 'POST') {
      const rid = H.assertOwnsRestaurant(body.restaurant_id || user.restaurant_id || null, user);
      const st = db.prepare('SELECT is_day_closed FROM settings WHERE restaurant_id=?').get(rid);
      if (st && Number(st.is_day_closed) === 1) H.errorResponse('Gün kapatıldı — bu dönem için yeni masraf girilemez.', 400);
      const feat = db.prepare('SELECT expenses_enabled FROM settings WHERE restaurant_id=?').get(rid);
      if (!feat || Number(feat.expenses_enabled) !== 1) H.errorResponse('Masraflar özelliği kapalı. Ayarlardan açabilirsiniz.', 400);
      const amount = Number(body.amount || 0);
      if (amount <= 0) H.errorResponse('Geçerli bir tutar girin', 400);
      const eid = H.uuid();
      db.prepare('INSERT INTO expenses (id,restaurant_id,amount,description,employee_name) VALUES (?,?,?,?,?)').run(eid, rid, amount, body.description || null, body.employee_name || null);
      const row = db.prepare('SELECT * FROM expenses WHERE id=?').get(eid); row.amount = Number(row.amount || 0);
      return j(res, row, 201);
    }
    if (method === 'DELETE' && id) {
      const exp = db.prepare('SELECT * FROM expenses WHERE id=?').get(id);
      if (!exp) H.errorResponse('Masraf bulunamadı', 404);
      const rid = H.assertOwnsRestaurant(exp.restaurant_id, user);
      const st = db.prepare('SELECT is_day_closed FROM settings WHERE restaurant_id=?').get(rid);
      if (st && Number(st.is_day_closed) === 1) H.errorResponse('Gün kapatıldı — bu döneme ait masraf kaydı silinemez.', 400);
      db.prepare('DELETE FROM expenses WHERE id=?').run(id);
      return j(res, { success: true });
    }
    if (method === 'DELETE' && !id && req.query.restaurant_id) {
      const rid = H.assertOwnsRestaurant(req.query.restaurant_id, user);
      const where = ['restaurant_id=?']; const wvals = [rid];
      if (req.query.lte_created_at) { where.push('created_at<=?'); wvals.push(H.toMysqlDate(req.query.lte_created_at)); }
      db.prepare(`DELETE FROM expenses WHERE ${where.join(' AND ')}`).run(...wvals);
      return j(res, { success: true });
    }
  }

  // ── DAILY REPORTS ──────────────────────────────────────
  if (table === 'daily_reports') {
    const user = H.requireAuthActive(req);
    const rid = H.assertOwnsRestaurant(req.query.restaurant_id || user.restaurant_id || null, user);
    if (method === 'GET') {
      const limit = Number(req.query._limit || req.query.limit || 50);
      const rows = db.prepare('SELECT * FROM daily_reports WHERE restaurant_id=? ORDER BY report_date DESC LIMIT ?').all(rid, limit);
      rows.forEach(r => { r.top_products = parseJsonField(r.top_products, []); r.payment_breakdown = parseJsonField(r.payment_breakdown, {}); });
      return j(res, rows);
    }
    if (method === 'POST') {
      const did = H.uuid();
      const reportDate = H.toMysqlDate(body.report_date) || H.nowSql();
      const totalRevenue = Number(body.total_revenue || 0);
      const totalRefunds = Number(body.total_refunds || 0);
      const netRevenue = body.net_revenue !== undefined ? body.net_revenue : (totalRevenue - totalRefunds);
      db.prepare(`INSERT INTO daily_reports (id,restaurant_id,report_date,total_revenue,total_orders,all_orders_count,total_discount,total_refunds,net_revenue,voided_orders_count,total_expenses,top_products,payment_breakdown,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(did, rid, reportDate, totalRevenue, body.total_orders || 0, body.all_orders_count || 0, body.total_discount || 0, totalRefunds, netRevenue, body.voided_orders_count || 0, Number(body.total_expenses || 0), JSON.stringify(body.top_products || []), JSON.stringify(body.payment_breakdown || {}), body.note || null);
      const row = db.prepare('SELECT * FROM daily_reports WHERE id=?').get(did);
      row.top_products = parseJsonField(row.top_products, []); row.payment_breakdown = parseJsonField(row.payment_breakdown, {});
      return j(res, row, 201);
    }
    if (method === 'DELETE' && id) { H.assertOwnsRow('daily_reports', id, user); db.prepare('DELETE FROM daily_reports WHERE id=? AND restaurant_id=?').run(id, rid); return j(res, { success: true }); }
  }

  // ── FEEDBACK ───────────────────────────────────────────
  if (table === 'feedback') {
    if (method === 'GET') { const user = H.requireAuthActive(req); const rid = H.assertOwnsRestaurant(req.query.restaurant_id || null, user); return j(res, db.prepare('SELECT * FROM feedback WHERE restaurant_id=? ORDER BY created_at DESC LIMIT 100').all(rid)); }
    if (method === 'POST') {
      if (!body.restaurant_id) H.errorResponse('restaurant_id gerekli');
      const chk = db.prepare('SELECT id FROM restaurants WHERE id=? LIMIT 1').get(body.restaurant_id);
      if (!chk) H.errorResponse('Geçersiz restaurant_id', 404);
      db.prepare('INSERT INTO feedback (restaurant_id,table_number,rating,comment) VALUES (?,?,?,?)').run(body.restaurant_id, body.table_number || null, body.rating || null, body.comment || null);
      return j(res, { success: true }, 201);
    }
  }

  // ── COUPONS ────────────────────────────────────────────
  if (table === 'coupons') {
    if (method === 'GET') {
      const rid = req.query.restaurant_id; if (!rid) H.errorResponse('restaurant_id gerekli');
      if (req.query.code) { const row = db.prepare('SELECT id FROM coupons WHERE restaurant_id=? AND code=?').get(rid, String(req.query.code).toUpperCase().trim()); return j(res, row || null); }
      if (req.query.active_only !== undefined) return j(res, db.prepare(`SELECT * FROM coupons WHERE restaurant_id=? AND is_active=1 AND (end_date IS NULL OR end_date>datetime('now')) AND (max_usage IS NULL OR usage_count<max_usage) ORDER BY created_at DESC`).all(rid));
      return j(res, db.prepare('SELECT * FROM coupons WHERE restaurant_id=? ORDER BY created_at DESC').all(rid));
    }
    if (method === 'POST') {
      const user = H.requireAuthActive(req);
      const rid = H.assertOwnsRestaurant(body.restaurant_id || null, user);
      const dup = db.prepare('SELECT id FROM coupons WHERE restaurant_id=? AND code=?').get(rid, body.code);
      if (dup) H.errorResponse('Bu kod zaten var');
      const cid = H.uuid();
      db.prepare('INSERT INTO coupons (id,restaurant_id,code,discount_type,discount_value,min_order_amount,start_date,end_date,max_usage,is_active,auto_apply) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(cid, rid, body.code, body.discount_type || 'percent', body.discount_value, body.min_order_amount || 0, body.start_date || null, body.end_date || null, body.max_usage || null, body.is_active ?? 1, body.auto_apply || 0);
      return j(res, db.prepare('SELECT * FROM coupons WHERE id=?').get(cid), 201);
    }
    if (method === 'PUT' && id) {
      const user = H.requireAuthActive(req); H.assertOwnsRow('coupons', id, user);
      const fields = [], values = [];
      for (const f of ['code', 'discount_type', 'discount_value', 'min_order_amount', 'start_date', 'end_date', 'max_usage', 'is_active', 'auto_apply', 'usage_count']) if (Object.prototype.hasOwnProperty.call(body, f)) { fields.push(`${f}=?`); values.push(body[f]); }
      if (!fields.length) H.errorResponse('Alan yok');
      values.push(id);
      db.prepare(`UPDATE coupons SET ${fields.join(',')} WHERE id=?`).run(...values);
      return j(res, db.prepare('SELECT * FROM coupons WHERE id=?').get(id));
    }
    if (method === 'DELETE' && id) { const user = H.requireAuthActive(req); H.assertOwnsRow('coupons', id, user); db.prepare('DELETE FROM coupons WHERE id=?').run(id); return j(res, { success: true }); }
  }

  // ── HAPPY HOURS ────────────────────────────────────────
  if (table === 'happy_hours') {
    if (method === 'GET') {
      const rid = req.query.restaurant_id; if (!rid) H.errorResponse('restaurant_id gerekli');
      if (req.query.active_only !== undefined) return j(res, db.prepare('SELECT * FROM happy_hours WHERE restaurant_id=? AND is_active=1').all(rid));
      return j(res, db.prepare('SELECT * FROM happy_hours WHERE restaurant_id=?').all(rid));
    }
    if (method === 'POST') {
      const user = H.requireAuthActive(req);
      const rid = H.assertOwnsRestaurant(body.restaurant_id || null, user);
      const hid = H.uuid();
      const days = Array.isArray(body.days_of_week) ? body.days_of_week.join(',') : (body.days_of_week || '0,1,2,3,4');
      db.prepare('INSERT INTO happy_hours (id,restaurant_id,name,discount_type,discount_value,min_order_amount,start_time,end_time,days_of_week,scope,category_id,is_active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(hid, rid, body.name, body.discount_type || 'percent', body.discount_value, body.min_order_amount || 0, body.start_time, body.end_time, days, body.scope || 'all', body.category_id || null, body.is_active ?? 1);
      return j(res, db.prepare('SELECT * FROM happy_hours WHERE id=?').get(hid), 201);
    }
    if (method === 'PUT' && id) {
      const user = H.requireAuthActive(req); H.assertOwnsRow('happy_hours', id, user);
      const fields = [], values = [];
      for (const f of ['name', 'discount_type', 'discount_value', 'min_order_amount', 'start_time', 'end_time', 'days_of_week', 'scope', 'category_id', 'is_active']) {
        if (Object.prototype.hasOwnProperty.call(body, f)) { fields.push(`${f}=?`); values.push(f === 'days_of_week' && Array.isArray(body[f]) ? body[f].join(',') : body[f]); }
      }
      values.push(id);
      db.prepare(`UPDATE happy_hours SET ${fields.join(',')} WHERE id=?`).run(...values);
      return j(res, db.prepare('SELECT * FROM happy_hours WHERE id=?').get(id));
    }
    if (method === 'DELETE' && id) { const user = H.requireAuthActive(req); H.assertOwnsRow('happy_hours', id, user); db.prepare('DELETE FROM happy_hours WHERE id=?').run(id); return j(res, { success: true }); }
  }

  // ── CAROUSEL SLIDES ────────────────────────────────────
  if (table === 'carousel_slides') {
    if (method === 'GET') {
      const rid = req.query.restaurant_id; if (!rid) H.errorResponse('restaurant_id gerekli');
      if (req.query.active_only !== undefined) return j(res, db.prepare('SELECT * FROM carousel_slides WHERE restaurant_id=? AND is_active=1 ORDER BY sort_order ASC').all(rid));
      return j(res, db.prepare('SELECT * FROM carousel_slides WHERE restaurant_id=? ORDER BY sort_order ASC').all(rid));
    }
    if (method === 'POST') {
      const user = H.requireAuthActive(req);
      const rid = H.assertOwnsRestaurant(body.restaurant_id || null, user);
      const sid = H.uuid();
      db.prepare('INSERT INTO carousel_slides (id,restaurant_id,image_url,title,subtitle,height,autoplay_interval,sort_order,is_active) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(sid, rid, body.image_url || null, body.title || null, body.subtitle || null, body.height || 180, body.autoplay_interval || 4, body.sort_order || 0, body.is_active ?? 1);
      return j(res, db.prepare('SELECT * FROM carousel_slides WHERE id=?').get(sid), 201);
    }
    if (method === 'PUT' && id) {
      const user = H.requireAuthActive(req); H.assertOwnsRow('carousel_slides', id, user);
      const fields = [], values = [];
      for (const f of ['image_url', 'title', 'subtitle', 'height', 'autoplay_interval', 'sort_order', 'is_active']) if (Object.prototype.hasOwnProperty.call(body, f)) { fields.push(`${f}=?`); values.push(body[f]); }
      values.push(id);
      db.prepare(`UPDATE carousel_slides SET ${fields.join(',')} WHERE id=?`).run(...values);
      return j(res, db.prepare('SELECT * FROM carousel_slides WHERE id=?').get(id));
    }
    if (method === 'DELETE' && id) { const user = H.requireAuthActive(req); H.assertOwnsRow('carousel_slides', id, user); db.prepare('DELETE FROM carousel_slides WHERE id=?').run(id); return j(res, { success: true }); }
  }

  // ── DİĞER MODÜLLER (personel, vardiya, mola talepleri, rezervasyonlar vb.) ──
  // Bu modüller online sunucuda (PHP) tam olarak var ama henüz local Electron
  // sunucusuna taşınmadı. Eskiden burası doğrudan 501 dönüyordu — bu da hem
  // konsolu spam'liyor hem de offline'dayken bu ekranları tamamen kırıyordu.
  // Artık genel bir JSON depoya (aux_records) yazıp okuyoruz: yazmalar zaten
  // normal şekilde sync kuyruğuna girip online sunucunun GERÇEK, tam işlenmiş
  // uç noktasına gönderiliyor; buradaki depo sadece offline görünürlük için.
  return handleAuxTable(db, req, res, table, id, body);
}));

function handleAuxTable(db, req, res, table, id, body) {
  const method = req.method;
  const rid = req.query.restaurant_id || (H.getAuthUser(req) || {}).restaurant_id || null;

  if (method === 'GET') {
    if (id) {
      const row = db.prepare('SELECT * FROM aux_records WHERE table_name=? AND id=?').get(table, id);
      return j(res, row ? parseJsonField(row.data, {}) : null);
    }
    if (!rid) return j(res, []);
    const rows = db.prepare('SELECT * FROM aux_records WHERE table_name=? AND restaurant_id=? ORDER BY updated_at DESC').all(table, rid);
    // Bilinen basit filtreleri (status, ör.) en iyi çaba ile local tarafta da uyguluyoruz.
    let list = rows.map(r => parseJsonField(r.data, {}));
    if (req.query.status) {
      const statuses = String(req.query.status).split(',').map(s => s.trim());
      list = list.filter(x => statuses.includes(x.status));
    }
    return j(res, list);
  }

  if (['POST', 'PUT', 'DELETE'].includes(method)) H.requireAuthActive(req);

  if (method === 'POST') {
    const newId = H.resolveEntityId(body);
    const record = { ...body, id: newId, restaurant_id: body.restaurant_id || rid };
    db.prepare(`INSERT INTO aux_records (id,table_name,restaurant_id,data,updated_at) VALUES (?,?,?,?,datetime('now'))
                ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=datetime('now')`)
      .run(newId, table, record.restaurant_id || null, JSON.stringify(record));
    return j(res, record, 201);
  }
  if (method === 'PUT' && id) {
    const existing = db.prepare('SELECT * FROM aux_records WHERE table_name=? AND id=?').get(table, id);
    const merged = { ...(existing ? parseJsonField(existing.data, {}) : {}), ...body, id };
    db.prepare(`INSERT INTO aux_records (id,table_name,restaurant_id,data,updated_at) VALUES (?,?,?,?,datetime('now'))
                ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=datetime('now')`)
      .run(id, table, merged.restaurant_id || rid || null, JSON.stringify(merged));
    return j(res, merged);
  }
  if (method === 'DELETE' && id) {
    db.prepare('DELETE FROM aux_records WHERE table_name=? AND id=?').run(table, id);
    return j(res, { success: true });
  }
  if (method === 'PUT' && !id) return j(res, { success: true }); // toplu güncelleme istekleri sessizce kabul
  return j(res, method === 'GET' ? [] : { success: true });
}

module.exports = router;
