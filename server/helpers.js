// server/helpers.js — index.php/config.php içindeki yardımcı fonksiyonların
// Node/SQLite (better-sqlite3, senkron) karşılığı.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDB } = require('./db');

function uuid() {
  return crypto.randomUUID();
}

// ── SAAT DİLİMİ ──────────────────────────────────────────────
// KÖK SORUN: online sunucu (index.php) zaman damgalarını restoranın saat
// dilimiyle yazıyor (date_default_timezone_set — varsayılan Europe/Istanbul),
// uygulama ise UTC yazıyordu. Aynı local veritabanında iki farklı saat dilimi
// karışıyordu: siteden çekilen siparişler +03, uygulamada verilenler UTC.
// Ciro dönemi "gt_paid_at=last_closed_at" ile süzüldüğü için, gün kapanışından
// sonraki saatlerin siparişleri yanlış döneme düşüyor ve gün sonu raporu yanlış
// tarihe yazılıyordu. Artık uygulama da sunucuyla AYNI saat dilimini kullanıyor.
let _tzCache = { tz: null, at: 0 };
function restaurantTz() {
  if (_tzCache.tz && Date.now() - _tzCache.at < 60000) return _tzCache.tz;
  let tz = 'Europe/Istanbul';
  try {
    const row = getDB().prepare('SELECT timezone FROM settings LIMIT 1').get();
    if (row && row.timezone) tz = row.timezone;
  } catch (e) { /* settings henüz yok — varsayılan */ }
  // Geçersiz bir değer tüm tarihleri bozmasın
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); }
  catch (e) { tz = 'Europe/Istanbul'; }
  _tzCache = { tz, at: Date.now() };
  return tz;
}

// Bir tarihi "YYYY-MM-DD HH:MM:SS" olarak restoranın saat diliminde biçimler.
function fmtInTz(d, tz) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  const hh = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hh}:${p.minute}:${p.second}`;
}

function nowSql() {
  return fmtInTz(new Date(), restaurantTz());
}

function toMysqlDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  return fmtInTz(d, restaurantTz());
}

// ── HTTP hata sınıfı: routes.js bunu yakalayıp {error,...} JSON'a çevirir ──
class ApiError extends Error {
  constructor(message, code = 400, extra = null) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}
function errorResponse(message, code = 400, extra = null) {
  throw new ApiError(message, code, extra);
}

// ── AUTH ─────────────────────────────────────────────────────
function getAuthUser(req) {
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Bearer ')) return null;
  const token = h.slice(7);
  const db = getDB();
  const row = db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now') LIMIT 1`
  ).get(token);
  return row || null;
}

function requireAuth(req) {
  const u = getAuthUser(req);
  if (!u) errorResponse('Kimlik doğrulama gerekli', 401);
  return u;
}

function requireAuthActive(req) {
  const user = requireAuth(req);
  if (user.role === 'superadmin') return user;
  const rid = user.restaurant_id;
  if (rid) {
    const db = getDB();
    const row = db.prepare('SELECT is_active FROM restaurants WHERE id=?').get(rid);
    if (!row || Number(row.is_active) !== 1) {
      errorResponse('Bu restoran pasif durumda. Lütfen yönetici ile iletişime geçin.', 403);
    }
  }
  return user;
}

function requireSuperadmin(req) {
  const u = requireAuth(req);
  if (u.role !== 'superadmin') errorResponse('Yetki yetersiz', 403);
  return u;
}

function getMyRestaurantId(user) {
  return user.role === 'superadmin' ? null : (user.restaurant_id || null);
}

function assertOwnsRow(table, id, user) {
  const db = getDB();
  if (user.role === 'superadmin') {
    const row = db.prepare(`SELECT * FROM "${table}" WHERE id=?`).get(id);
    if (!row) errorResponse('Kayıt bulunamadı', 404);
    return row;
  }
  const myRid = user.restaurant_id;
  if (!myRid) errorResponse('Yetki yetersiz', 403);
  const row = db.prepare(`SELECT * FROM "${table}" WHERE id=?`).get(id);
  if (!row) errorResponse('Kayıt bulunamadı', 404);
  if ((row.restaurant_id || null) !== myRid) errorResponse('Yetki yetersiz', 403);
  return row;
}

function assertOwnsRestaurant(rid, user) {
  if (user.role === 'superadmin') {
    if (!rid) errorResponse('restaurant_id gerekli');
    return rid;
  }
  const myRid = user.restaurant_id;
  if (!myRid) errorResponse('Yetki yetersiz', 403);
  if (rid && rid !== myRid) errorResponse('Yetki yetersiz', 403);
  return myRid;
}

function resolveEntityId(body) {
  const clientId = body && body.id;
  if (clientId && typeof clientId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    return clientId;
  }
  return uuid();
}

function resolveUserPermissions(user) {
  if (user.permissions) {
    try {
      const decoded = JSON.parse(user.permissions);
      if (Array.isArray(decoded) && decoded.length > 0) return decoded;
    } catch (e) {}
  }
  if (user.role_key && user.restaurant_id) {
    const db = getDB();
    const row = db.prepare('SELECT custom_roles FROM settings WHERE restaurant_id=?').get(user.restaurant_id);
    if (row && row.custom_roles) {
      try {
        const roles = JSON.parse(row.custom_roles);
        if (Array.isArray(roles)) {
          const found = roles.find(r => r.id === user.role_key);
          if (found) return Array.isArray(found.permissions) ? found.permissions : [];
        }
      } catch (e) {}
    }
  }
  return [];
}

// publishEvent: local modda gerçek zamanlı SSE olmadığından basit no-op —
// istenirse ileride local websocket/BroadcastChannel'a bağlanabilir.
function publishEvent() {}

// ── VAT / STOK yardımcıları (index.php birebir mantık) ─────────
function getRestaurantVat(rid) {
  const db = getDB();
  const row = db.prepare('SELECT vat_enabled, vat_rate FROM settings WHERE restaurant_id=?').get(rid);
  const enabled = row ? !!(Number(row.vat_enabled) === 1) : false;
  const rate = row ? Number(row.vat_rate || 0) : 0;
  return { enabled, rate };
}

// Delivery (paket/teslimat) masası mı? (tables.is_takeaway=1) — bu siparişlerden KDV alınmaz.
function isDeliveryTable(tableId) {
  if (!tableId) return false;
  const db = getDB();
  const row = db.prepare('SELECT is_takeaway FROM tables WHERE id=?').get(tableId);
  return !!(row && Number(row.is_takeaway) === 1);
}

// Sipariş/masa için geçerli KDV bilgisi: delivery ise KDV kapalı döner.
function getOrderVat(rid, tableId) {
  const vat = getRestaurantVat(rid);
  if (isDeliveryTable(tableId)) return { enabled: false, rate: vat.rate };
  return vat;
}

// Arayüzle (admin.html posCalculateTotals / renderTables) BİREBİR aynı kural:
//  • total = kalemler toplamı + KDV   (indirim total'dan DÜŞÜLMEZ; arayüz her yerde
//    "total - discount_amount" ile net tutarı hesaplıyor — düşülürse indirim 2 kez düşer)
//  • KDV, vat_exempt OLMAYAN ürünler üzerinden, indirim oranlı dağıtılarak hesaplanır
//  • Delivery masalarında KDV yok
function computeTotals(rid, tableId, items, discountAmount = 0) {
  const db = getDB();
  const exemptStmt = db.prepare('SELECT vat_exempt FROM products WHERE id=?');
  let subtotal = 0, vatable = 0;
  for (const it of (items || [])) {
    const line = Number(it.price || 0) * Number(it.quantity || 0);
    subtotal += line;
    const p = it.product_id ? exemptStmt.get(it.product_id) : null;
    if (!(p && Number(p.vat_exempt) === 1)) vatable += line;
  }
  const discount = Math.min(Number(discountAmount || 0), subtotal);
  const vatableAfterDiscount = subtotal > 0 ? vatable - discount * (vatable / subtotal) : 0;
  const vat = getOrderVat(rid, tableId);
  const vatAmount = (vat.enabled && vatableAfterDiscount > 0)
    ? Math.round(vatableAfterDiscount * (vat.rate / 100) * 100) / 100 : 0;
  const total = Math.round((subtotal + vatAmount) * 100) / 100;
  return { subtotal, vat_amount: vatAmount, total };
}

function computeOrderTotalFromItems(rid, orderId, discountAmount = 0) {
  const db = getDB();
  const items = db.prepare('SELECT product_id, price, quantity FROM order_items WHERE order_id=?').all(orderId);
  const ord = db.prepare('SELECT table_id FROM orders WHERE id=?').get(orderId);
  return computeTotals(rid, ord && ord.table_id, items, discountAmount);
}

function checkRestaurantOpen(rid) {
  const db = getDB();
  const row = db.prepare('SELECT is_open FROM settings WHERE restaurant_id=?').get(rid);
  if (row && !(Number(row.is_open) === 1)) {
    errorResponse('Restoran şu anda kapalı, sipariş alınamıyor', 403, { error: 'restaurant_closed' });
  }
}

function checkRecipeStockSufficiency(rid, items) {
  const db = getDB();
  const s = db.prepare('SELECT recipe_stock_enabled FROM settings WHERE restaurant_id=?').get(rid);
  if (!s || Number(s.recipe_stock_enabled) !== 1) return;

  const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))];
  if (!productIds.length) return;

  const ph = productIds.map(() => '?').join(',');
  const recipeRows = db.prepare(`SELECT product_id, ingredient_id, amount FROM recipes WHERE product_id IN (${ph})`).all(...productIds);
  const recipeMap = {};
  for (const r of recipeRows) {
    (recipeMap[r.product_id] = recipeMap[r.product_id] || []).push({ ingredient_id: r.ingredient_id, amount: Number(r.amount) });
  }

  const totalNeeded = {};
  for (const item of items) {
    const pid = item.product_id;
    const qty = Number(item.quantity || 1);
    if (!pid || !recipeMap[pid]) continue;
    for (const rcp of recipeMap[pid]) {
      totalNeeded[rcp.ingredient_id] = (totalNeeded[rcp.ingredient_id] || 0) + rcp.amount * qty;
    }
  }
  if (!Object.keys(totalNeeded).length) return;

  const iids = Object.keys(totalNeeded);
  const iPh = iids.map(() => '?').join(',');
  const stockRows = db.prepare(`SELECT id, stock FROM ingredients WHERE id IN (${iPh})`).all(...iids);
  const stockMap = {};
  for (const ing of stockRows) stockMap[ing.id] = Number(ing.stock);

  for (const [iid, needed] of Object.entries(totalNeeded)) {
    const avail = stockMap[iid] || 0;
    if (needed > avail + 0.0001) {
      errorResponse('insufficient_stock', 409, {
        error: 'insufficient_stock',
        ingredient_id: iid,
        needed: Math.round(needed * 1000) / 1000,
        available: Math.round(avail * 1000) / 1000,
      });
    }
  }
}

function checkProductStockSufficiency(rid, items) {
  const db = getDB();
  const s = db.prepare('SELECT stock_enabled FROM settings WHERE restaurant_id=?').get(rid);
  if (!s || Number(s.stock_enabled) !== 1) return;

  const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))];
  if (!productIds.length) return;
  const ph = productIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, name, stock FROM products WHERE id IN (${ph})`).all(...productIds);
  const stockMap = {};
  for (const p of rows) stockMap[p.id] = p;

  const neededByProduct = {};
  for (const item of items) {
    const pid = item.product_id;
    if (!pid) continue;
    neededByProduct[pid] = (neededByProduct[pid] || 0) + Number(item.quantity || 1);
  }
  for (const [pid, needed] of Object.entries(neededByProduct)) {
    const p = stockMap[pid];
    if (!p || p.stock === null || p.stock === undefined) continue; // stok takibi olmayan ürün
    if (needed > Number(p.stock) + 0.0001) {
      errorResponse(`"${p.name}" için yeterli stok yok (mevcut: ${p.stock})`, 409, { error: 'insufficient_product_stock', product_id: pid });
    }
  }
}

function refreshProductAvailability(affectedProductIds, ingMap = {}) {
  const db = getDB();
  for (const apid of affectedProductIds) {
    const rows = db.prepare(
      `SELECT r.amount, i.stock, r.ingredient_id FROM recipes r JOIN ingredients i ON i.id=r.ingredient_id WHERE r.product_id=?`
    ).all(apid);
    if (!rows.length) continue;
    let canMake = true;
    for (const rcp of rows) {
      const stock = ingMap[rcp.ingredient_id] ? ingMap[rcp.ingredient_id].stock : Number(rcp.stock);
      if (Number(rcp.amount) > stock + 0.0001) { canMake = false; break; }
    }
    db.prepare('UPDATE products SET is_available=? WHERE id=?').run(canMake ? 1 : 0, apid);
  }
}

// Malzeme stoklarını düşer (recipe_stock_enabled açıkken), item başına maliyeti döner.
function deductRecipeStock(rid, items, orderId = null) {
  const db = getDB();
  const costs = {};
  const s = db.prepare('SELECT recipe_stock_enabled FROM settings WHERE restaurant_id=?').get(rid);
  if (!s || Number(s.recipe_stock_enabled) !== 1) return costs;

  const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))];
  if (!productIds.length) return costs;

  const tx = db.transaction(() => {
    const ph = productIds.map(() => '?').join(',');
    const recipeRows = db.prepare(`SELECT product_id, ingredient_id, amount FROM recipes WHERE product_id IN (${ph})`).all(...productIds);
    const recipeMap = {};
    for (const r of recipeRows) (recipeMap[r.product_id] = recipeMap[r.product_id] || []).push({ ingredient_id: r.ingredient_id, amount: Number(r.amount) });

    const totalNeeded = {};
    for (const item of items) {
      const pid = item.product_id, qty = Number(item.quantity || 1);
      if (!pid || !recipeMap[pid]) continue;
      for (const rcp of recipeMap[pid]) totalNeeded[rcp.ingredient_id] = (totalNeeded[rcp.ingredient_id] || 0) + rcp.amount * qty;
    }
    if (!Object.keys(totalNeeded).length) return;

    const iids = Object.keys(totalNeeded);
    const iPh = iids.map(() => '?').join(',');
    const ingRows = db.prepare(`SELECT id, stock, cost_per_unit, min_stock FROM ingredients WHERE id IN (${iPh})`).all(...iids);
    const ingMap = {};
    for (const ing of ingRows) ingMap[ing.id] = { stock: Number(ing.stock), cost_per_unit: Number(ing.cost_per_unit || 0), min_stock: Number(ing.min_stock || 0) };

    for (const [iid, needed] of Object.entries(totalNeeded)) {
      const avail = ingMap[iid] ? ingMap[iid].stock : 0;
      if (needed > avail + 0.0001) {
        errorResponse('insufficient_stock', 409, { error: 'insufficient_stock', ingredient_id: iid, needed: Math.round(needed * 1000) / 1000, available: Math.round(avail * 1000) / 1000 });
      }
    }

    const affectedIngIds = new Set(), affectedProdIds = new Set(), logRows = [];
    items.forEach((item, idx) => {
      const pid = item.product_id, qty = Number(item.quantity || 1);
      if (!pid || !recipeMap[pid]) return;
      let cost = 0;
      for (const rcp of recipeMap[pid]) {
        const iid = rcp.ingredient_id, needed = rcp.amount * qty;
        if (!ingMap[iid]) continue;
        cost += needed * ingMap[iid].cost_per_unit;
        const before = ingMap[iid].stock;
        const after = Math.max(0, before - needed);
        ingMap[iid].stock = after;
        affectedIngIds.add(iid);
        logRows.push({ iid, before, change: -needed, after });
      }
      costs[idx] = Math.round(cost * 10000) / 10000;
      affectedProdIds.add(pid);
    });

    const upd = db.prepare('UPDATE ingredients SET stock=?, updated_at=datetime(\'now\') WHERE id=?');
    for (const iid of affectedIngIds) upd.run(ingMap[iid].stock, iid);
    const log = db.prepare(`INSERT INTO stock_logs (id,restaurant_id,ingredient_id,order_id,change_type,qty_before,qty_change,qty_after) VALUES (?,?,?,?,'deduct',?,?,?)`);
    for (const lg of logRows) log.run(uuid(), rid, lg.iid, orderId, lg.before, lg.change, lg.after);

    refreshProductAvailability([...affectedProdIds], ingMap);
  });
  tx();
  return costs;
}

function restoreRecipeStock(rid, orderItems, orderId = null) {
  if (!orderItems || !orderItems.length || !rid) return;
  const db = getDB();
  const s = db.prepare('SELECT recipe_stock_enabled FROM settings WHERE restaurant_id=?').get(rid);
  if (!s || Number(s.recipe_stock_enabled) !== 1) return;

  const productIds = [...new Set(orderItems.map(i => i.product_id).filter(Boolean))];
  if (!productIds.length) return;

  const tx = db.transaction(() => {
    const ph = productIds.map(() => '?').join(',');
    const recipeRows = db.prepare(`SELECT product_id, ingredient_id, amount FROM recipes WHERE product_id IN (${ph})`).all(...productIds);
    const recipeMap = {};
    for (const r of recipeRows) (recipeMap[r.product_id] = recipeMap[r.product_id] || []).push({ ingredient_id: r.ingredient_id, amount: Number(r.amount) });

    const neededIngIds = new Set();
    for (const pid of productIds) if (recipeMap[pid]) for (const rcp of recipeMap[pid]) neededIngIds.add(rcp.ingredient_id);
    if (!neededIngIds.size) return;

    const iids = [...neededIngIds];
    const iPh = iids.map(() => '?').join(',');
    const ingRows = db.prepare(`SELECT id, stock, min_stock FROM ingredients WHERE id IN (${iPh})`).all(...iids);
    const ingMap = {};
    for (const ing of ingRows) ingMap[ing.id] = { stock: Number(ing.stock), min_stock: Number(ing.min_stock || 0) };

    const affectedProdIds = new Set(), logRows = [];
    for (const item of orderItems) {
      const pid = item.product_id, qty = Number(item.quantity || 1);
      if (!pid || !recipeMap[pid]) continue;
      for (const rcp of recipeMap[pid]) {
        const iid = rcp.ingredient_id, restore = rcp.amount * qty;
        if (!ingMap[iid]) continue;
        const before = ingMap[iid].stock;
        ingMap[iid].stock = before + restore;
        logRows.push({ iid, before, change: restore, after: ingMap[iid].stock });
      }
      affectedProdIds.add(pid);
    }

    const upd = db.prepare('UPDATE ingredients SET stock=?, updated_at=datetime(\'now\') WHERE id=?');
    for (const iid of neededIngIds) if (ingMap[iid]) upd.run(ingMap[iid].stock, iid);
    const log = db.prepare(`INSERT INTO stock_logs (id,restaurant_id,ingredient_id,order_id,change_type,qty_before,qty_change,qty_after,note) VALUES (?,?,?,?,'restore',?,?,?,?)`);
    for (const lg of logRows) log.run(uuid(), rid, lg.iid, orderId, lg.before, lg.change, lg.after, 'Sipariş iptal/silme');

    refreshProductAvailability([...affectedProdIds], ingMap);
  });
  tx();
}

// ── basit ürün stoku (recipesiz, products.stock) düşme yardımcı ──
function deductSimpleProductStock(rid, items) {
  const db = getDB();
  const stRow = db.prepare('SELECT stock_enabled FROM settings WHERE restaurant_id=?').get(rid);
  if (!stRow || Number(stRow.stock_enabled) !== 1) return;
  for (const item of items) {
    const pid = item.product_id, qty = Number(item.quantity || 1);
    if (!pid) continue;
    const prod = db.prepare('SELECT stock FROM products WHERE id=?').get(pid);
    if (prod && prod.stock !== null && prod.stock !== undefined) {
      const before = Number(prod.stock);
      const newStock = Math.max(0, before - qty);
      db.prepare('UPDATE products SET stock=?, is_available=? WHERE id=?').run(newStock, newStock > 0 ? 1 : 0, pid);
    }
  }
}

// ── app_config (local cihaz ayarları: server_url, restaurant_id, device vs) ──
function cfgGet(key) {
  const db = getDB();
  const row = db.prepare('SELECT value FROM app_config WHERE key=?').get(key);
  return row ? row.value : null;
}
function cfgSet(key, value) {
  const db = getDB();
  db.prepare('INSERT INTO app_config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value == null ? null : String(value));
}

module.exports = {
  uuid, nowSql, toMysqlDate, restaurantTz, ApiError, errorResponse,
  getAuthUser, requireAuth, requireAuthActive, requireSuperadmin, getMyRestaurantId,
  assertOwnsRow, assertOwnsRestaurant, resolveEntityId, resolveUserPermissions, publishEvent,
  getRestaurantVat, isDeliveryTable, getOrderVat, computeTotals, computeOrderTotalFromItems, checkRestaurantOpen,
  checkRecipeStockSufficiency, checkProductStockSufficiency,
  deductRecipeStock, restoreRecipeStock, refreshProductAvailability, deductSimpleProductStock,
  cfgGet, cfgSet, bcrypt,
};
