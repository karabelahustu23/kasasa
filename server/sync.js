// server/sync.js — ONLINE ⇄ OFFLINE SENKRONİZASYON MOTORU
// ==================================================================
// Tasarım ilkeleri:
//  1) LOCAL-FIRST: her yazma önce local SQLite'a işlenir, kullanıcı asla
//     internet beklemez. Yazma ayrıca kuyruğa girer.
//  2) ANLIK: yazma olur olmaz (250 ms içinde) kuyruk itilir; karşı taraftaki
//     değişiklikler online sunucunun SSE akışı dinlenerek anında çekilir.
//     İnternet yoksa uyarlanabilir zamanlayıcı devreye girer.
//  3) VERİ KAYBI YOK: 4xx hatası artık "başarılı" sayılmaz; ölü-mektup
//     kutusuna alınır. 5xx/ağ hatasında üstel geri çekilmeyle tekrar denenir
//     ve SIRA KORUNUR (sipariş, kalemlerinden önce gider).
//  4) ID TUTARLILIĞI: local'de üretilen UUID kuyruğa da yazılır; online
//     sunucu aynı id ile kaydeder → çift kayıt/ayrışma olmaz.
//  5) ÇAKIŞMA: henüz gönderilmemiş (pending) bir kaydın üstüne uzaktan gelen
//     eski hâli yazılmaz — local kazanır, gönderildikten sonra uzak kazanır.
const fs = require('fs');
const path = require('path');
const { getDB, getDataDir } = require('./db');
const H = require('./helpers');
const E = require('./events');

// ── Ayarlanabilir zamanlamalar ───────────────────────────────
const TICK_ACTIVE_MS = 3000;    // bekleyen iş varken
const TICK_IDLE_MS = 15000;     // her şey temizken (uzak SSE zaten anlık haber verir)
const TICK_OFFLINE_MS = 5000;   // internet yokken yeniden bağlanma denemesi
const CATALOG_MS = 120000;
const DEEP_RECONCILE_MS = 60000;   // derin (geniş pencereli) silme mutabakatı aralığı
const DEEP_WINDOW_DAYS = 30;        // derin taramanın kapsadığı gün sayısı      // menü/ayar gibi yavaş değişen tabloların tam tazelemesi
const PUSH_BATCH = 100;
const MAX_ATTEMPTS = 25;        // bu sayıdan sonra ölü-mektup
const HTTP_TIMEOUT_MS = 20000;

const SYNC_TABLES = [
  'categories', 'products', 'product_variants', 'tables',
  'settings', 'ingredients', 'recipes', 'coupons', 'happy_hours',
  'carousel_slides', 'daily_reports', 'feedback', 'expenses',
];
// Her turda çekilen küçük/sık değişen tablolar
const HOT_TABLES = ['tables', 'settings'];

function jsonFieldsFor(table) {
  if (table === 'categories' || table === 'products' || table === 'product_variants') return ['translations'];
  if (table === 'settings') return ['custom_roles', 'bank_names', 'delivery_companies', 'kitchen_stations', 'table_zones', 'enabled_languages', 'admin_enabled_languages'];
  if (table === 'daily_reports') return ['top_products', 'payment_breakdown'];
  return [];
}

const _colCache = {};
function localColumnsOf(db, table) {
  if (_colCache[table]) return _colCache[table];
  const cols = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name));
  _colCache[table] = cols;
  return cols;
}

function upsertRow(db, table, row) {
  const jsonFields = jsonFieldsFor(table);
  const localCols = localColumnsOf(db, table);
  const cols = Object.keys(row).filter(c => c !== 'host_device_online' && localCols.has(c));
  if (!cols.includes('id')) return false;
  const values = cols.map(c => {
    let v = row[c];
    if (jsonFields.includes(c) && v !== null && typeof v === 'object') v = JSON.stringify(v);
    if (typeof v === 'boolean') v = v ? 1 : 0;
    return v;
  });

  // Gerçekten değişip değişmediğini önceden kontrol ediyoruz: aksi halde her
  // pull turunda AYNI, değişmemiş satırlar bile "değişti" sayılıp anlık olay
  // (order_update/table_update) yayınlanır — bu da arayüzü saniyede birkaç
  // kez gereksiz yere tazeler ve konsolu doldurur. Sadece gerçek fark varsa
  // veya satır yeniyse true dönüyoruz.
  const existing = db.prepare(`SELECT ${cols.map(c => `"${c}"`).join(',')} FROM "${table}" WHERE id=?`).get(row.id);
  let changed = !existing;
  if (existing) {
    for (const c of cols) {
      if (c === 'id') continue;
      const a = existing[c], b = values[cols.indexOf(c)];
      // SQLite tip farkları (0/1 vs true/false, sayı vs metin) yanlış pozitif
      // üretmesin diye string'e çevirip kıyaslıyoruz.
      if (String(a ?? '') !== String(b ?? '')) { changed = true; break; }
    }
  }

  const placeholders = cols.map(() => '?').join(',');
  const updateSet = cols.filter(c => c !== 'id').map(c => `${c}=excluded.${c}`).join(',');
  try {
    db.prepare(`INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${placeholders})
                ON CONFLICT(id) DO UPDATE SET ${updateSet}`).run(...values);
  } catch (e) {
    // Uzaktan gelen tek bir bozuk/eksik satır (ör. NOT NULL bir alan boş) ASLA
    // tüm senkronu çökertmemeli. Kaydı atla, devam et.
    if (existing) {
      // Satır zaten varsa hiç değilse güncelleyebildiğimiz alanları yazalım.
      const safe = cols.filter(c => c !== 'id' && values[cols.indexOf(c)] !== null && values[cols.indexOf(c)] !== undefined);
      if (safe.length) {
        try {
          db.prepare(`UPDATE "${table}" SET ${safe.map(c => `"${c}"=?`).join(',')} WHERE id=?`)
            .run(...safe.map(c => values[cols.indexOf(c)]), row.id);
          return true;
        } catch (e2) {}
      }
    }
    console.warn(`[sync] ${table}#${row.id} atlandı: ${e.message}`);
    return false;
  }
  return changed;
}

function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Sunucu adresi boş olamaz');
  s = s.replace(/,/g, '.');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    return u.origin + (u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : '');
  } catch (e) {
    throw new Error(`Geçersiz sunucu adresi: "${input}"`);
  }
}

// ── DURUM ────────────────────────────────────────────────────
const state = {
  online: false,
  syncing: false,
  pending: 0,
  failed: 0,
  lastPushAt: null,
  lastPullAt: null,
  lastError: null,
  authError: false,
  realtime: false, // uzak SSE bağlı mı
};

function restaurantId() { return H.cfgGet('restaurant_id'); }

function refreshCounters() {
  const db = getDB();
  state.pending = db.prepare(`SELECT COUNT(*) n FROM sync_queue WHERE status='pending'`).get().n;
  state.failed = db.prepare(`SELECT COUNT(*) n FROM sync_queue WHERE status='failed'`).get().n;
}

function getStatus() {
  return {
    online: state.online,
    realtime: state.realtime,
    syncing: state.syncing,
    pending: state.pending,
    failed: state.failed,
    auth_error: state.authError,
    last_push_at: state.lastPushAt,
    last_pull_at: state.lastPullAt,
    last_error: state.lastError,
    server_url: H.cfgGet('server_url'),
    // Tanı amaçlı: online sunucuya giriş token'ı kayıtlı mı? Değilse
    // pushQueue/pullRemoteUpdates sessizce "skipped" döner (hata basmaz)
    // ve bu yüzden last_error/last_push_at hep null kalır — asıl sebep budur.
    has_auth_token: !!H.cfgGet('auth_token'),
    restaurant_id: H.cfgGet('restaurant_id'),
  };
}

let _lastBroadcast = '';
function broadcastStatus() {
  refreshCounters();
  const rid = restaurantId();
  if (!rid) return;
  // Dedupe anahtarı yalnızca KALICI alanlardan üretilir: 'syncing' her turda
  // değiştiği için onu da katarsak saniyede bir olay yayınlar ve yedek moddaki
  // istemcileri gereksiz yere tazelemeye zorlardık.
  const snap = JSON.stringify([state.online, state.realtime, state.pending, state.failed, state.authError]);
  if (snap === _lastBroadcast) return; // gereksiz olay üretme
  _lastBroadcast = snap;
  try { E.publish(rid, 'sync_status', getStatus()); } catch (e) {}
}

// ── HTTP yardımcıları (zaman aşımlı) ─────────────────────────
async function httpJson(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally { clearTimeout(t); }
}

function authHeaders() {
  const token = H.cfgGet('auth_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── BAĞLANTI YOKLAMASI ───────────────────────────────────────
// ÖNEMLİ: Daha önce `state.online` SADECE bir push/pull tam olarak başarılı
// olduğunda true oluyordu. Kuyruk boşsa push hiç HTTP isteği atmıyor, pull ise
// tek bir tablo hatasında (ör. orders isteği 500 dönerse) baştan patlayıp
// online=false yapıyordu. Sonuç: internet açıkken bile rozet "Çevrimdışı".
// Artık bağlantı durumu ayrı ve tek bir hafif yoklamayla belirleniyor:
// sunucudan HERHANGİ bir HTTP yanıtı geldiyse (401/404 dahil) çevrimiçiyiz.
async function probeOnline() {
  const serverUrl = H.cfgGet('server_url');
  if (!serverUrl) { state.online = false; return false; }
  const base = serverUrl.replace(/\/$/, '');
  const rid = restaurantId() || '';
  const url = `${base}/api/index.php?table=events_ping&restaurant_id=${encodeURIComponent(rid)}`;
  try {
    const resp = await httpJson(url, { headers: authHeaders(), timeout: 8000 });
    state.online = true;               // sunucu cevap verdi = ağ var
    if (resp.status === 401 || resp.status === 403) {
      // token sorunu ayrı bir durum; bağlantı sorunu değil
      state.authError = true;
    }
    return true;
  } catch (e) {
    state.online = false;
    state.lastError = 'Sunucuya ulaşılamıyor: ' + String(e.message || e);
    return false;
  }
}

// ── İLK KURULUM ──────────────────────────────────────────────
async function pullInitialData({ serverUrl, token, restaurantId: rid, onProgress }) {
  const db = getDB();
  const base = normalizeServerUrl(serverUrl);

  async function fetchTable(table, extraQs = '') {
    const url = `${base}/api/index.php?table=${encodeURIComponent(table)}&restaurant_id=${encodeURIComponent(rid)}${extraQs}`;
    const resp = await httpJson(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 60000 });
    if (!resp.ok) throw new Error(`${table} çekilemedi (HTTP ${resp.status})`);
    return resp.json();
  }

  onProgress && onProgress('Restoran bilgisi indiriliyor...');
  const restaurant = await fetchTable('restaurants', '');
  if (restaurant && restaurant.id) { upsertRow(db, 'restaurants', restaurant); downloadMissingImages(base, [restaurant]).catch(() => {}); }

  for (const table of SYNC_TABLES) {
    onProgress && onProgress(`${table} indiriliyor...`);
    let rows;
    try { rows = await fetchTable(table); }
    catch (e) { console.warn(`Sync uyarı: ${table} indirilemedi: ${e.message}`); continue; }
    if (!Array.isArray(rows)) { if (rows && rows.id) upsertRow(db, table, rows); continue; }
    db.transaction((list) => { for (const r of list) upsertRow(db, table, r); })(rows);
    downloadMissingImages(base, rows).catch(() => {});
  }

  onProgress && onProgress('Son siparişler indiriliyor...');
  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const orders = await fetchTable('orders', `&gte_created_at=${encodeURIComponent(since)}`);
  if (Array.isArray(orders)) applyOrders(db, orders);

  H.cfgSet('server_url', base);
  H.cfgSet('restaurant_id', rid);
  H.cfgSet('last_full_sync', new Date().toISOString());
  H.cfgSet('last_incremental_sync', new Date().toISOString());
}

async function remoteLoginAndBootstrap({ serverUrl, email, password, onProgress }) {
  const base = normalizeServerUrl(serverUrl);
  const resp = await httpJson(`${base}/api/index.php?table=auth&action=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    timeout: 30000,
  });
  const data = await resp.json();
  if (!resp.ok || !data.token) throw new Error(data.error || 'Giriş başarısız');

  const db = getDB();
  const hash = H.bcrypt.hashSync(password, 10);
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  const uid = existing ? existing.id : (data.user.id || H.uuid());
  db.prepare(`INSERT INTO users (id,email,password,role,restaurant_id,role_key,permissions) VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET password=excluded.password, role=excluded.role, restaurant_id=excluded.restaurant_id`)
    .run(uid, data.user.email, hash, data.user.role, data.user.restaurant_id, data.user.role_key || null, JSON.stringify(data.user.permissions || []));

  if (!data.user.restaurant_id) throw new Error('Bu kullanıcının bağlı bir restoranı yok (superadmin hesabıyla kasa senkronize edilemez).');

  H.cfgSet('auth_token', data.token);
  H.cfgSet('sync_email', email);
  await pullInitialData({ serverUrl, token: data.token, restaurantId: data.user.restaurant_id, onProgress });
  return { user: data.user, restaurant: data.restaurant };
}

// ── YAZMA KUYRUĞU ────────────────────────────────────────────
function queueWrite({ idempotency_key, method, path: p, body, entity_table, entity_id, file_path, local_url }) {
  const db = getDB();
  try {
    db.prepare(`INSERT OR IGNORE INTO sync_queue
      (idempotency_key, method, path, body, entity_table, entity_id, file_path, local_url, is_form)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(idempotency_key, method, p, body || null, entity_table || null, entity_id || null,
           file_path || null, local_url || null, file_path ? 1 : 0);
    state.pending++;
    scheduleImmediatePush();
  } catch (e) { console.error('sync queue insert error', e); }
}

// Offline'da yüklenen görselleri de online sunucuya taşımak için kuyruğa al.
function queueUpload({ bucket, filePath, localUrl }) {
  queueWrite({
    idempotency_key: H.uuid(),
    method: 'UPLOAD',
    path: `/api/index.php?table=upload&bucket=${encodeURIComponent(bucket)}`,
    body: JSON.stringify({ bucket }),
    file_path: filePath,
    local_url: localUrl,
  });
}

// Gövdedeki local /uploads/... yollarını, yüklenmiş remote karşılığıyla değiştir.
function rewriteLocalUrls(bodyStr) {
  if (!bodyStr || !bodyStr.includes('/uploads/')) return bodyStr;
  let out = bodyStr;
  const maps = getDB().prepare('SELECT local_url, remote_url FROM url_map WHERE remote_url IS NOT NULL').all();
  for (const m of maps) if (out.includes(m.local_url)) out = out.split(m.local_url).join(m.remote_url);
  return out;
}

// Local'de henüz gönderilmemiş kayıtların id'leri — uzaktan gelen eski hâl
// bunların üstüne yazılmamalı (local kazanır).
function pendingEntityIds() {
  const rows = getDB().prepare(
    // 'failed' olanlar da dahil: gönderilememiş bir local değişikliğin üstüne
    // uzaktan gelen ESKİ hâl yazılırsa kullanıcının offline'da yaptığı iş sessizce
    // kaybolur. Onarılana (veya kullanıcı vazgeçene) kadar local kazanır.
    `SELECT DISTINCT entity_table, entity_id FROM sync_queue
      WHERE status IN ('pending','failed') AND entity_id IS NOT NULL`
  ).all();
  const map = {};
  for (const r of rows) (map[r.entity_table] = map[r.entity_table] || new Set()).add(r.entity_id);
  return map;
}

function markSynced(id) {
  getDB().prepare(`UPDATE sync_queue SET status='synced', synced_at=datetime('now'), last_error=NULL WHERE id=?`).run(id);
}
function markFailed(id, err) {
  // attempts'i de artırıyoruz: aşağıdaki otomatik canlandırma sonsuz döngüye girmesin.
  getDB().prepare(`UPDATE sync_queue SET status='failed', attempts=COALESCE(attempts,0)+1, last_error=? WHERE id=?`)
    .run(String(err).slice(0, 500), id);
}

// İnternet geri geldiğinde, daha önce hata almış kayıtları OTOMATİK olarak
// bir kez daha dene. Artık PUT→POST / POST→PUT onarımları olduğu için eski
// hataların büyük kısmı bu turda kendiliğinden düzelir; kullanıcının elle
// "tekrar dene" demesi gerekmez. attempts sınırı sonsuz denemeyi engeller.
function reviveFailed() {
  const info = getDB().prepare(
    `UPDATE sync_queue SET status='pending', next_attempt_at=NULL
      WHERE status='failed' AND COALESCE(attempts,0) < ?`).run(MAX_ATTEMPTS);
  if (info.changes) console.log(`[sync] ${info.changes} hatalı kayıt yeniden kuyruğa alındı`);
  return info.changes;
}
function backoff(item, err) {
  const attempts = Number(item.attempts || 0) + 1;
  if (attempts >= MAX_ATTEMPTS) { markFailed(item.id, `(${attempts} deneme) ${err}`); return; }
  const delaySec = Math.min(2 ** Math.min(attempts, 10), 600); // 2 sn → 10 dk tavan
  getDB().prepare(
    `UPDATE sync_queue SET attempts=?, last_error=?, next_attempt_at=datetime('now', ?) WHERE id=?`
  ).run(attempts, String(err).slice(0, 500), `+${delaySec} seconds`, item.id);
}

let _pushing = false;
async function pushQueue() {
  if (_pushing) return { pushed: 0, busy: true };
  const db = getDB();

  _pushing = true;
  const serverUrl = H.cfgGet('server_url');
  if (!serverUrl || !H.cfgGet('auth_token')) {
    _pushing = false;
    // Sessizce "skipped" dönmek yerine görünür bir hata bırakıyoruz — aksi
    // halde last_error hep null kalır ve kişi neden hiçbir şey olmadığını
    // asla anlayamaz.
    state.lastError = !serverUrl ? 'Sunucu adresi kayıtlı değil (kurulum tamamlanmamış olabilir)'
                                  : 'Giriş oturumu kayıtlı değil — kurulum ekranından tekrar giriş yapın';
    broadcastStatus();
    return { pushed: 0, skipped: true };
  }
  let pushed = 0;
  try {
    const items = db.prepare(
      `SELECT * FROM sync_queue WHERE status='pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
       ORDER BY id ASC LIMIT ?`).all(PUSH_BATCH);

    // Bu turda sorun çıkan kayıtlar — aynı kaydın sonraki istekleri gönderilmez,
    // yoksa tek bir sorun onlarca "hata" satırı üretir.
    const blockedEntities = new Set();
    const ekey = (it) => `${it.entity_table || ''}:${it.entity_id || ''}`;

    // Bir siparişin kendisi gönderilemediyse, o siparişin kalemleri/iadeleri de
    // gönderilmemeli (sunucuda henüz olmayan bir siparişe kalem eklenemez).
    const blockedOrders = new Set();
    const referencesBlockedOrder = (it) => {
      if (!blockedOrders.size) return false;
      const hay = `${it.path || ''} ${it.body || ''}`;
      for (const oid of blockedOrders) if (hay.includes(oid)) return true;
      return false;
    };

    for (const item of items) {
      if (item.entity_id && blockedEntities.has(ekey(item))) continue;
      if (referencesBlockedOrder(item)) continue;

      // (d) Aynı kaydın daha yeni bir güncellemesi kuyrukta varsa bunu atla.
      if (supersededByNewer(item)) { markSynced(item.id); continue; }

      // (e) Görsel yüklemesi henüz gitmediyse bu kaydı sonraya bırak.
      if (waitsForUpload(item)) { backoff(item, 'görsel yüklemesi bekleniyor'); continue; }

      try {
        // Daha önce denenmiş bir oluşturma isteğini körlemesine tekrarlamayız:
        // sunucuda zaten oluşmuş olabilir (yanıt kaybolmuş olabilir).
        if (item.method === 'POST' && Number(item.attempts || 0) > 0 && await alreadyOnRemote(serverUrl, item)) {
          console.log('[sync] kopya önlendi (kayıt sunucuda zaten var):', ekey(item));
          markSynced(item.id); pushed++;
          continue;
        }

        let result = item.method === 'UPLOAD'
          ? await pushUpload(serverUrl, item)
          : await pushWrite(serverUrl, item);

        // Onarım adımlarının izi — hata listesinde ZİNCİRİN TAMAMI görünsün ki
        // hangi adımda takıldığı tahmin edilmek zorunda kalınmasın.
        const trace = [];
        if (!result.ok) trace.push(`${item.method} → HTTP ${result.status} ${String(result.text || '').slice(0, 80)}`);

        // ── KENDİNİ ONARAN DÖNÜŞÜMLER ──
        if (!result.ok && item.method !== 'UPLOAD' && item.entity_id) {
          // (a) PUT ama kayıt sunucuda yok → aynı id ile oluştur
          if (item.method === 'PUT' && (result.status === 404 || result.status === 410)) {
            const repaired = currentLocalBody(item, null);
            if (!repaired) {
              // Kayıt local'de de yok (sonradan silinmiş): bu güncelleme artık
              // ANLAMSIZ. Hata olarak biriktirmek yerine kuyruktan düşürüyoruz.
              console.log('[sync] güncel olmayan istek atıldı:', ekey(item));
              result = { ok: true, status: 200 };
            } else if (item.entity_table === 'order_items') {
              // ── KALEMLER İÇİN ÖZEL KURAL ──
              // Kalemi POST ile yeniden oluşturmak, kalem id'lerini yok sayan
              // sunucularda KOPYA kalem üretir (4 ürün → 8 ürün sorunu buydu).
              // Doğrusu: sunucunun bu kalem için kullandığı id ÖĞRENİLENE KADAR
              // BEKLEMEK. Bir sonraki pull'da kalem içerikten eşleştirilip
              // learnId ile eşleme yazılıyor; ardından bu istek doğru id'ye gidiyor.
              //
              // DİKKAT — ESKİ DAVRANIŞ BİR VERİ KAYBIYDI: istek burada
              // "başarılı" sayılıp kuyruktan düşürülüyordu. Kayıt o anda
              // pendingEntityIds() korumasından da çıktığı için, hemen ardından
              // çalışan pullRemoteUpdates uzaktaki ESKİ hâli
              // (sent_to_kitchen=0 / is_ready=0) local'in üstüne yazıyordu.
              // Sonuç: çevrimdışıyken "Hazırlanıyor" yapılan sipariş, internet
              // gelir gelmez "Bekliyor"a geri dönüyordu. Artık istek 'pending'
              // kalır: hem local değer korunur (blocked listesinde durduğu için
              // pull ezemez) hem de eşleme öğrenilince gerçekten gönderilir.
              console.log('[sync] kalem id\'si sunucuda yok — eşleme öğrenilene kadar bekletiliyor:', item.entity_id);
              backoff(item, 'kalem eşlemesi bekleniyor (sunucuda bu id yok)');
              continue;
            } else {
              // id içermeyen bir gövdeyle POST atmak sunucuda KOPYA kayıt üretir.
              const row = JSON.parse(repaired);
              if (item.entity_table === 'order_items') {
                // Alt satırı tek başına POST etmek, id'lerimizi yok sayan bir
                // sunucuda KOPYA kalem üretir (4 ürün → 8 ürün sorunu buydu).
                // Doğru çözüm: eşleme öğrenilene kadar bekle; bir sonraki
                // senkronda kalem uzak id'siyle eşleşecek ve istek oraya gidecek.
                if (!hasRemoteMapping('order_items', item.entity_id)) {
                  // Üstel gecikme uygulamıyoruz: eşleme bir sonraki pull'da
                  // öğrenilecek, istek hemen ardından gitsin. Kayıt 'pending'
                  // kalır, hata sayacına HİÇ düşmez.
                  console.log('[sync] kalem eşlemesi bekleniyor, sonraki turda denenecek:', item.entity_id);
                  continue;
                }
              } else if (row.id) {
                result = await pushWrite(serverUrl, {
                  ...item, method: 'POST', path: pathWithoutId(item.path), body: repaired,
                });
                trace.push(`POST onarımı → HTTP ${result.status} ${String(result.text || '').slice(0, 80)}`);
                if (result.ok) console.log('[sync] PUT→POST onarımı:', ekey(item));
              }
              // (a2) Son çare: alt satır tek başına oluşturulamıyorsa (sunucu
              // kalemi siparişsiz kabul etmiyorsa) TÜM SİPARİŞİ kalemleriyle
              // birlikte yeniden gönder. Gerçek sunucuda "Kalem bulunamadı"
              // hatalarının birikmesinin sebebi buydu.
              if (!result.ok && item.entity_table === 'order_items' && row.order_id) {
                const full = currentLocalBody(
                  { entity_table: 'orders', entity_id: row.order_id }, null);
                if (full) {
                  result = await pushWrite(serverUrl, {
                    ...item,
                    method: 'PUT',
                    path: `/api/index.php?table=orders&id=${encodeURIComponent(row.order_id)}`,
                    body: full,
                  });
                  trace.push(`sipariş bütünü onarımı → HTTP ${result.status} ${String(result.text || '').slice(0, 80)}`);
                  if (result.ok) console.log('[sync] kalem→sipariş bütünü onarımı:', row.order_id);
                }
              }
            }
          }
          // (b) POST ama kayıt sunucuda zaten var → güncellemeye çevir
          else if (item.method === 'POST' && (result.status === 409 || isDuplicateError(result.text))) {
            // 409 = sunucuda zaten var → güncellemeye çevir
            result = await pushWrite(serverUrl, {
              ...item,
              method: 'PUT',
              path: pathWithId(item.path, item.entity_id),
              body: currentLocalBody(item, item.body),
            });
            trace.push(`PUT onarımı → HTTP ${result.status} ${String(result.text || '').slice(0, 80)}`);
            if (result.ok) console.log('[sync] POST→PUT onarımı:', ekey(item));
          }
          // (c) DELETE ama kayıt zaten yok → iş tamam
          else if (item.method === 'DELETE' && (result.status === 404 || result.status === 410)) {
            result = { ok: true, status: 200 };
          }
        }

        if (result.ok) {
          markSynced(item.id); pushed++;
          state.online = true; state.lastError = null; state.authError = false;
          continue;
        }

        if (result.status === 401 || result.status === 403) {
          const stillValid = await tokenStillValid(serverUrl);
          if (!stillValid) {
            state.authError = true;
            state.lastError = 'Oturum süresi doldu — kurulum ekranından tekrar giriş yapın';
            break; // kuyruğu bozmadan dur, veri kaybı yok
          }
          markFailed(item.id, trace.join('  |  ') || `HTTP ${result.status}: ${result.text || 'yetki reddedildi'}`);
          if (item.entity_id) blockedEntities.add(ekey(item));
          continue;
        }
        if (result.status >= 400 && result.status < 500) {
          // Onarım denemeleri de tutmadıysa kalıcı iş kuralı hatasıdır. Sessizce
          // "başarılı" saymak veri kaybıdır → ölü-mektup kutusuna al ve AYNI
          // kaydın sonraki isteklerini bu tur gönderme (hata yığını olmasın).
          markFailed(item.id, trace.join('  |  ') || `HTTP ${result.status}: ${result.text || ''}`);
          console.error('[sync] GÖNDERİLEMEDİ', item.method, item.path, '\n   ', trace.join('\n    '));
          if (item.entity_id) blockedEntities.add(ekey(item));
          if (item.entity_table === 'orders' && item.entity_id) blockedOrders.add(item.entity_id);
          continue;
        }
        // 5xx → sunucu geçici sorunlu: SIRAYI BOZMADAN dur
        backoff(item, `HTTP ${result.status}`);
        break;
      } catch (e) {
        state.online = false;
        state.lastError = String(e.message || e);
        backoff(item, e.message || e);
        break; // ağ yok — bu turu bitir (sıra korunur, veri kaybı yok)
      }
    }
    if (pushed) state.lastPushAt = new Date().toISOString();
  } finally {
    _pushing = false;
    broadcastStatus();
  }
  return { pushed, pending: state.pending };
}

// ── KUYRUK SAĞLAMLAŞTIRMA YARDIMCILARI ───────────────────────
// Çevrimdışıyken yapılan işlerin çevrimiçi olunca "hata" vermesinin başlıca
// sebepleri ve buradaki kökten çözümleri:
//  (a) Kayıt önce offline oluşturulup sonra düzenlendi; POST sunucuya ulaşmadan
//      PUT gitti → 404. Çözüm: PUT 404 alırsa AYNI id ile POST'a çevrilir.
//  (b) POST bir kez ulaştı ama yanıtı alınamadı, tekrar denendi → "zaten var".
//      Çözüm: POST 409/duplicate alırsa PUT'a çevrilir.
//  (c) Offline'da silinen kayıt sunucuda zaten yok → 404. Çözüm: başarı sayılır.
//  (d) Aynı kayıt offline'da 10 kez düzenlendi → 10 ayrı istek, her biri bir
//      hata ihtimali. Çözüm: eski PUT'lar atlanır, sadece en günceli gider.
//  (e) Offline yüklenen görsel henüz sunucuda yokken onu referans eden kayıt
//      gönderildi → bozuk URL. Çözüm: yükleme sıraya alınana kadar beklenir.
//  (f) Bir kayıt hata alırsa aynı kaydın sonraki istekleri körlemesine gönderilip
//      hata yığını üretmez; o kayıt bu tur atlanır.

function pathWithId(p, id) {
  if (/[?&]id=/.test(p)) return p.replace(/([?&]id=)[^&]*/, `$1${encodeURIComponent(id)}`);
  return p + (p.includes('?') ? '&' : '?') + 'id=' + encodeURIComponent(id);
}
function pathWithoutId(p) {
  return p.replace(/([?&])id=[^&]*&?/, '$1').replace(/[?&]$/, '');
}

// Kaydın local'deki GÜNCEL hâlini gövde olarak üret (PUT→POST dönüşümünde
// eski/eksik gövde yerine doğru veri gitsin diye).
function currentLocalBody(item, fallbackBody) {
  if (!item.entity_table || !item.entity_id) return fallbackBody;
  try {
    const db = getDB();
    const row = db.prepare(`SELECT * FROM "${item.entity_table}" WHERE id=?`).get(item.entity_id);
    if (!row) return fallbackBody;
    if (item.entity_table === 'orders') {
      row.order_items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(item.entity_id);
    }
    return JSON.stringify(row);
  } catch (e) { return fallbackBody; }
}

// Bu istek, henüz gönderilmemiş bir görsel yüklemesine bağımlı mı?
function waitsForUpload(item) {
  if (!item.body || !item.body.includes('/uploads/')) return false;
  const resolved = rewriteLocalUrls(item.body);
  if (!resolved.includes('/uploads/')) return false;
  const n = getDB().prepare(
    `SELECT COUNT(*) n FROM sync_queue WHERE method='UPLOAD' AND status='pending' AND id < ?`
  ).get(item.id).n;
  return n > 0;
}

// Aynı kayda ait DAHA YENİ bir PUT kuyrukta bekliyor mu? (eskisini göndermeye gerek yok)
function supersededByNewer(item) {
  if (item.method !== 'PUT' || !item.entity_id) return false;
  const newer = getDB().prepare(
    `SELECT body FROM sync_queue
      WHERE status='pending' AND method='PUT' AND entity_id=? AND entity_table IS ? AND id > ?`
  ).all(item.entity_id, item.entity_table, item.id);
  if (!newer.length) return false;
  // DİKKAT: uygulamadaki güncellemeler KISMİ olabilir (biri sadece
  // sent_to_kitchen, diğeri sadece is_ready gönderir). Yenisi eskisinin
  // alanlarını içermiyorsa eskisini atmak o bilgiyi KAYBETTİRİR.
  // Bu yüzden yalnızca eskinin tüm alanları yenilerde varsa atıyoruz.
  let mine = {};
  try { mine = JSON.parse(item.body || '{}'); } catch (e) { return false; }
  if (Array.isArray(mine) || typeof mine !== 'object') return false;
  const covered = new Set();
  for (const r of newer) {
    try {
      const b = JSON.parse(r.body || '{}');
      if (b && typeof b === 'object' && !Array.isArray(b)) Object.keys(b).forEach(k => covered.add(k));
    } catch (e) {}
  }
  return Object.keys(mine).every(k => k === 'id' || covered.has(k));
}

// KOPYA KAYIT KORUMASI
// Senaryo: POST sunucuya ulaştı, kayıt oluştu, ama yanıt dönerken bağlantı koptu.
// Kuyruk "gitmedi" sanıp tekrar gönderirse AYNI SİPARİŞ İKİ KEZ oluşur.
// Bu yüzden daha önce en az bir kez denenmiş (attempts>0) bir POST'u tekrar
// göndermeden önce sunucuya sorup gerçekten yok mu diye bakıyoruz.
async function alreadyOnRemote(serverUrl, item) {
  if (item.method !== 'POST' || !item.entity_table || !item.entity_id) return false;
  const base = serverUrl.replace(/\/$/, '');
  const rid = restaurantId();
  // a) Doğrudan id ile sor (sunucu bizim id'mizi kullanıyorsa kesin sonuç)
  try {
    const r = await httpJson(
      `${base}/api/index.php?table=${encodeURIComponent(item.entity_table)}&id=${encodeURIComponent(item.entity_id)}`,
      { headers: authHeaders(), timeout: 10000 });
    if (r.ok) {
      const row = await r.json().catch(() => null);
      if (row && row.id) return true;
    }
  } catch (e) { return false; } // ağ yok → karar veremeyiz, normal akış devam etsin

  // b) GÜN SONU RAPORU — KOPYA Z RAPORU KORUMASI
  //    daily_reports'ta id'yi HER İKİ TARAF DA kendi üretir (local H.uuid(),
  //    sunucu kendi uuid'i). Bu yüzden yukarıdaki "id ile sor" adımı bu tabloda
  //    HER ZAMAN 404 verir. Sonuç: gün sonu raporu sunucuya ulaşıp yanıtı yolda
  //    kaybolduğunda (tam da internetin yeni geldiği anda en sık olan şey)
  //    kuyruk raporu tekrar gönderiyor ve sitede AYNI GÜN İÇİN İKİNCİ bir Z
  //    raporu oluşuyordu. Burada içerikten tanıyoruz.
  //    Tarih penceresi geniş (12 saat) çünkü sunucu report_date'i kendi saat
  //    dilimine (Europe/Istanbul) çevirirken local UTC yazıyor — aradaki sabit
  //    fark yüzünden dar bir pencere raporu "yeni" sanardı.
  if (item.entity_table === 'daily_reports') {
    try {
      const local = getDB().prepare('SELECT * FROM daily_reports WHERE id=?').get(item.entity_id);
      if (!local || !local.report_date) return false;
      const r = await httpJson(
        `${base}/api/index.php?table=daily_reports&restaurant_id=${encodeURIComponent(rid)}&limit=50`,
        { headers: authHeaders(), timeout: 15000 });
      if (!r.ok) return false;
      const rows = await r.json().catch(() => []);
      if (!Array.isArray(rows)) return false;
      const ts = (v) => Date.parse(String(v || '').replace(' ', 'T') + 'Z');
      const lt = ts(local.report_date);
      const hit = rows.find(x =>
        isFinite(lt) && isFinite(ts(x.report_date)) &&
        Math.abs(ts(x.report_date) - lt) < 12 * 3600 * 1000 &&
        Math.abs(Number(x.total_revenue || 0) - Number(local.total_revenue || 0)) < 0.01 &&
        Number(x.total_orders || 0) === Number(local.total_orders || 0));
      if (hit && hit.id) {
        learnId('daily_reports', local.id, hit.id);
        console.log('[sync] gün sonu raporu sunucuda zaten var — kopya engellendi');
        return true;
      }
      return false;
    } catch (e) { return false; }
  }

  // c) Siparişlerde: sunucu kendi id'sini üretmiş olabilir. Aynı masa + aynı
  //    tutar + yakın zaman damgası varsa bunu "zaten gitmiş" sayıyoruz.
  if (item.entity_table !== 'orders') return false;
  try {
    const local = getDB().prepare('SELECT * FROM orders WHERE id=?').get(item.entity_id);
    if (!local || !local.created_at) return false;
    const from = new Date(new Date(local.created_at.replace(' ', 'T') + 'Z').getTime() - 5 * 60000)
      .toISOString().slice(0, 19).replace('T', ' ');
    const r = await httpJson(
      `${base}/api/index.php?table=orders&restaurant_id=${encodeURIComponent(rid)}&gte_created_at=${encodeURIComponent(from)}`,
      { headers: authHeaders(), timeout: 15000 });
    if (!r.ok) return false;
    const rows = await r.json().catch(() => []);
    if (!Array.isArray(rows)) return false;
    const localItems = getDB().prepare('SELECT COUNT(*) n FROM order_items WHERE order_id=?').get(item.entity_id).n;
    return rows.some(o =>
      String(o.table_id || '') === String(local.table_id || '') &&
      Math.abs(Number(o.total || 0) - Number(local.total || 0)) < 0.01 &&
      (!Array.isArray(o.order_items) || o.order_items.length === localItems));
  } catch (e) { return false; }
}

function isDuplicateError(text) {
  return /duplicate|already exists|zaten|UNIQUE constraint|1062/i.test(String(text || ''));
}


// ══════════════════════════════════════════════════════════════
// ID EŞLEME KATMANI
// ══════════════════════════════════════════════════════════════
// Local id'ler ASLA değişmez. Sunucu kendi id'sini üretirse eşleme burada
// tutulur; dışarı giden istekler uzak id'ye, gelen satırlar local id'ye çevrilir.
function learnId(table, localId, remoteId) {
  if (!table || !localId || !remoteId) return;
  const cur = getDB().prepare('SELECT remote_id FROM id_map WHERE entity_table=? AND local_id=?').get(table, localId);
  if (cur && cur.remote_id === remoteId) return; // zaten biliniyor — log kirletme
  // id'ler aynı olsa bile kaydediyoruz: bu satır aynı zamanda "sunucu bu kaydı
  // ALDI" anlamına gelir ve silme mutabakatında kullanılır.
  if (localId === remoteId) {
    try {
      getDB().prepare(`INSERT INTO id_map (entity_table, local_id, remote_id) VALUES (?,?,?)
                       ON CONFLICT(entity_table, local_id) DO NOTHING`).run(table, localId, remoteId);
    } catch (e) {}
    return;
  }
  try {
    getDB().prepare(
      `INSERT INTO id_map (entity_table, local_id, remote_id) VALUES (?,?,?)
       ON CONFLICT(entity_table, local_id) DO UPDATE SET remote_id=excluded.remote_id`
    ).run(table, localId, remoteId);
    console.log(`[sync] id eşlemesi öğrenildi: ${table} ${localId} → ${remoteId}`);
  } catch (e) {}
}
function remoteIdFor(table, localId) {
  if (!table || !localId) return localId;
  const r = getDB().prepare('SELECT remote_id FROM id_map WHERE entity_table=? AND local_id=?').get(table, localId);
  return r ? r.remote_id : localId;
}
function localIdFor(table, remoteId) {
  if (!table || !remoteId) return remoteId;
  const r = getDB().prepare('SELECT local_id FROM id_map WHERE entity_table=? AND remote_id=?').get(table, remoteId);
  return r ? r.local_id : remoteId;
}
function hasRemoteMapping(table, localId) {
  return !!getDB().prepare('SELECT 1 FROM id_map WHERE entity_table=? AND local_id=?').get(table, localId);
}
function isMappedRemote(table, remoteId) {
  return !!getDB().prepare('SELECT 1 FROM id_map WHERE entity_table=? AND remote_id=?').get(table, remoteId);
}

// Giden isteği uzak id'lere çevir: hem yoldaki &id=, hem gövdedeki id/order_id.
function toRemoteRequest(item) {
  const out = { path: item.path, body: item.body };
  if (item.entity_table && item.entity_id) {
    const rid = remoteIdFor(item.entity_table, item.entity_id);
    if (rid !== item.entity_id) out.path = pathWithId(out.path, rid);
  }
  // yoldaki order_id parametresi (ör. DELETE order_items&order_id=..)
  const om = /[?&]order_id=([^&]+)/.exec(out.path || '');
  if (om) {
    const localOid = decodeURIComponent(om[1]);
    const rOid = remoteIdFor('orders', localOid);
    if (rOid !== localOid) out.path = out.path.replace(/([?&]order_id=)[^&]*/, `$1${encodeURIComponent(rOid)}`);
  }
  if (out.body) {
    try {
      const parsed = JSON.parse(out.body);
      const fix = (obj) => {
        if (!obj || typeof obj !== 'object') return obj;
        if (obj.id && item.entity_table) obj.id = remoteIdFor(item.entity_table, obj.id);
        if (obj.order_id) obj.order_id = remoteIdFor('orders', obj.order_id);
        if (Array.isArray(obj.order_items)) obj.order_items = obj.order_items.map(i => {
          const c = { ...i };
          if (c.id) c.id = remoteIdFor('order_items', c.id);
          return c;
        });
        return obj;
      };
      const fixed = Array.isArray(parsed) ? parsed.map(fix) : fix(parsed);
      out.body = JSON.stringify(fixed);
    } catch (e) {}
  }
  return out;
}

// Sunucunun POST yanıtından gerçek id'leri öğren.
function learnFromResponse(item, data) {
  if (!data || typeof data !== 'object') return;
  const t = item.entity_table;
  if (Array.isArray(data)) {
    // order_items dizi yanıtı: sırayla eşle
    let locals = [];
    try {
      const b = JSON.parse(item.body || '[]');
      locals = Array.isArray(b) ? b : [b];
    } catch (e) {}
    data.forEach((r, i) => { if (r && r.id && locals[i] && locals[i].id) learnId(t, locals[i].id, r.id); });
    return;
  }
  if (data.id && item.entity_id) learnId(t, item.entity_id, data.id);
  // Sipariş yanıtı kalemleri de içeriyorsa onları da eşle
  if (t === 'orders' && Array.isArray(data.order_items)) {
    let localItems = [];
    try { localItems = (JSON.parse(item.body || '{}').order_items) || []; } catch (e) {}
    data.order_items.forEach((r, i) => {
      if (r && r.id && localItems[i] && localItems[i].id) learnId('order_items', localItems[i].id, r.id);
    });
  }
}

async function pushWrite(serverUrl, item) {
  // Giden istek her zaman UZAK id'lerle gider.
  const mapped = toRemoteRequest(item);
  const url = serverUrl.replace(/\/$/, '') + mapped.path;
  const resp = await httpJson(url, {
    method: item.method,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      'X-Idempotency-Key': item.idempotency_key,
    },
    body: mapped.body ? rewriteLocalUrls(mapped.body) : undefined,
  });
  if (resp.ok) {
    // Sunucu kendi id'sini ürettiyse HEMEN öğren: bundan sonraki tüm
    // güncelleme/silme istekleri doğru id'ye gider (404 ve kopya biter).
    if (item.method === 'POST') {
      try { learnFromResponse(item, await resp.clone().json()); } catch (e) {}
    }
    return { ok: true, status: resp.status };
  }
  // 409: aynı idempotency anahtarı zaten işlenmiş → başarı say
  if (resp.status === 409) return { ok: true, status: resp.status };
  let text = '';
  try { text = (await resp.text()).slice(0, 200); } catch (e) {}
  return { ok: false, status: resp.status, text };
}

async function pushUpload(serverUrl, item) {
  if (!item.file_path || !fs.existsSync(item.file_path)) {
    return { ok: true, status: 200 }; // dosya silinmiş — tekrar denemenin anlamı yok
  }
  const buf = fs.readFileSync(item.file_path);
  const name = path.basename(item.file_path);
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  const url = serverUrl.replace(/\/$/, '') + item.path;
  const resp = await httpJson(url, {
    method: 'POST',
    headers: { ...authHeaders(), 'X-Idempotency-Key': item.idempotency_key },
    body: fd,
    timeout: 120000,
  });
  if (!resp.ok) {
    let text = ''; try { text = (await resp.text()).slice(0, 200); } catch (e) {}
    return { ok: false, status: resp.status, text };
  }
  const data = await resp.json().catch(() => ({}));
  const remote = data.url || data.publicUrl || data.path;
  if (remote && item.local_url) {
    getDB().prepare(`INSERT INTO url_map (local_url, remote_url) VALUES (?,?)
                     ON CONFLICT(local_url) DO UPDATE SET remote_url=excluded.remote_url`)
      .run(item.local_url, remote);
  }
  return { ok: true, status: 200 };
}

async function tokenStillValid(serverUrl) {
  try {
    const resp = await httpJson(`${serverUrl.replace(/\/$/, '')}/api/index.php?table=auth&action=me`, { headers: authHeaders() });
    return resp.ok;
  } catch (e) { return false; }
}

// ── EKSİK GÖRSELLERİ İNDİR ────────────────────────────────────
// Bir ürün/kategori/logo başka bir cihazda yüklenmişse, bu satır pull ile
// buraya iner ama dosyanın kendisi bu cihazın diskinde yoktur (404). Satırda
// /uploads/... ile başlayan her alanı tarayıp eksikse arka planda indiriyoruz.
const _downloading = new Set();
async function downloadMissingImages(base, rows) {
  const dataDir = getDataDir();
  const jobs = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const v of Object.values(row)) {
      if (typeof v !== 'string') continue;
      // Görsel yolu üç biçimde gelebilir: "/uploads/..", "uploads/..",
      // "https://sunucu/uploads/..". Üçünü de tanıyoruz — logonun
      // indirilmemesinin sebeplerinden biri buydu.
      const m = /(?:^|\/)(uploads\/[^"'\s?]+)/.exec(v);
      if (!m) continue;
      const rel = m[1];
      const abs = path.join(dataDir, rel);
      const url = '/' + rel;
      if (fs.existsSync(abs) || _downloading.has(url)) continue;
      jobs.push({ url, abs });
    }
  }
  if (!jobs.length) return;
  for (const job of jobs) {
    _downloading.add(job.url);
    try {
      const resp = await httpJson(base + job.url, { timeout: 30000 });
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.mkdirSync(path.dirname(job.abs), { recursive: true });
      fs.writeFileSync(job.abs, buf);
    } catch (e) { /* internet gelince zaten bir sonraki pull'da tekrar denenir */ }
    finally { _downloading.delete(job.url); }
  }
}

function pendingCount() { refreshCounters(); return state.pending; }

// ── AŞAĞI ÇEKME ──────────────────────────────────────────────
// ── DURUM GERİ GİTME KORUMASI ────────────────────────────────
// Sorun: çevrimdışıyken "Hazırlanıyor" yapılan bir sipariş, internet gelince
// sunucudaki ESKİ hâliyle (bekliyor) geri yazılıyordu. Kalemler yeniden
// "istasyona gönderilmemiş" sayıldığı için istasyondan AYNI FİŞ İKİNCİ KEZ
// çıkıyordu.
//
// Kural: senkron sırasında durum yalnızca İLERİ gidebilir.
//  • Uzaktaki durum local'dekinden ileriyse → uygulanır (siteden verilen
//    siparişin durumu uygulamada da doğru görünür).
//  • Uzaktaki durum GERİDEYSE → yok sayılır ve local ilerlemesi sunucuya
//    gönderilmek üzere kuyruğa alınır (iki taraf yine aynı yere gelir).
//  • İptal (voided_at) her zaman uygulanır — bu bir geri gitme değildir.
const ORDER_STATUS_RANK = {
  pending: 0, new: 0, waiting: 0,
  preparing: 1, in_progress: 1,
  ready: 2,
  served: 3, delivered: 3,
  completed: 4, paid: 4,
};
// Bir kez 1 olunca senkronla asla 0'a dönmeyecek alanlar.
const MONOTONIC_FLAGS = {
  orders: ['is_paid'],
  order_items: ['sent_to_kitchen', 'is_ready'],
};

function rankOf(status) {
  const r = ORDER_STATUS_RANK[String(status || '').toLowerCase()];
  return r === undefined ? null : r;
}

// Uzaktan gelen satırı, local'deki ilerlemeyi geri almayacak şekilde düzeltir.
// Dönen { row, regressed }: regressed=true ise local sunucudan ileridedir.
function guardRegression(db, table, row, localRow) {
  if (!localRow) return { row, regressed: false };
  const out = { ...row };
  let regressed = false;

  // İptal edilmiş sipariş: uzak hâl aynen geçerlidir.
  if (table === 'orders' && (row.voided_at || localRow.voided_at)) return { row: out, regressed: false };

  for (const f of (MONOTONIC_FLAGS[table] || [])) {
    if (!(f in out)) continue;
    const remoteOn = Number(out[f] === true ? 1 : out[f] || 0) === 1;
    const localOn = Number(localRow[f] === true ? 1 : localRow[f] || 0) === 1;
    if (localOn && !remoteOn) { out[f] = 1; regressed = true; }
  }

  if (table === 'orders' && out.status !== undefined) {
    const rRank = rankOf(out.status), lRank = rankOf(localRow.status);
    // Tanımadığımız bir durum varsa karışmıyoruz — uzak taraf haklı sayılır.
    if (rRank !== null && lRank !== null && rRank < lRank) {
      out.status = localRow.status;
      regressed = true;
    }
  }
  return { row: out, regressed };
}

// Local sunucudan ileriyse, farkı sunucuya göndermek üzere kuyruğa al.
// Aynı kayıt için bekleyen istek varsa bu satıra zaten pull dokunmuyor
// (blocked listesi), dolayısıyla buraya yalnızca kuyruğu boş olan —
// yani sunucunun gerçekten haberi olmayan — kayıtlar düşer.
function requeueLocalAhead(table, row) {
  try {
    const body = {};
    for (const f of (MONOTONIC_FLAGS[table] || [])) if (f in row) body[f] = row[f];
    if (table === 'orders' && row.status !== undefined) body.status = row.status;
    if (!Object.keys(body).length) return;
    body.id = row.id;
    queueWrite({
      idempotency_key: H.uuid(),
      method: 'PUT',
      path: `/api/index.php?table=${table}&id=${encodeURIComponent(row.id)}`,
      body: JSON.stringify(body),
      entity_table: table,
      entity_id: row.id,
    });
    console.log(`[sync] ${table}#${row.id}: local durum sunucudan ileride — fark tekrar kuyruğa alındı`);
  } catch (e) { console.warn('[sync] requeue hatası:', e.message); }
}

function applyOrders(db, orders, opts = {}) {
  const blocked = opts.blocked || {};
  let changed = 0;

  // İçerik parmak izi — sunucu id'lerimizi yok sayarsa kalemi içerikten tanırız.
  const sig = (i) => [
    i.product_id || '', (i.product_name || '').trim(), (i.variant_name || '').trim(),
    Number(i.quantity || 0), Number(i.price || 0),
  ].join('|');
  const looseSig = (i) => [
    i.product_id || '', (i.product_name || '').trim(), (i.variant_name || '').trim(),
    Number(i.price || 0),
  ].join('|');

  db.transaction((list) => {
    for (const o of list) {
      // Sunucu kalem listesini GERÇEKTEN gönderdi mi, yoksa alan hiç yok mu?
      // Bu ayrım kritik: "kalem listesi boş" (hepsi silinmiş) ile "kalem bilgisi
      // gelmedi" (liste uç noktası kalemleri döndürmüyor) aynı şey değildir.
      const hasItemsField = Array.isArray(o.order_items);
      const remoteItems = o.order_items || [];
      delete o.order_items;

      // ── GELEN SATIRI LOCAL KİMLİĞİNE ÇEVİR ──
      const remoteOrderId = o.id;
      const localOrderId = localIdFor('orders', remoteOrderId);
      o.id = localOrderId;

      // ÖNEMLİ: Uzaktan gelen her sipariş için de eşleme/onay kaydı yazıyoruz.
      // Aksi halde SİTEDE oluşturulmuş siparişlerin "sunucu bunu biliyor" kaydı
      // hiç oluşmuyor ve silme mutabakatı bu siparişleri hiç incelemiyordu —
      // sitede silinen sipariş uygulamada olduğu gibi kalıyordu.
      learnId('orders', localOrderId, remoteOrderId);

      if (blocked.orders && blocked.orders.has(localOrderId)) continue; // local sürüm henüz gönderilmedi
      const localOrderRow = db.prepare('SELECT * FROM orders WHERE id=?').get(localOrderId);
      const og = guardRegression(db, 'orders', o, localOrderRow);
      if (og.regressed) requeueLocalAhead('orders', { ...localOrderRow, id: localOrderId });
      const orderChanged = upsertRow(db, 'orders', og.row);
      let itemsChanged = false;

      const localRows = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(localOrderId);

      // ── KALEMLERİ EŞLE ──
      // 1) Bilinen eşleme  2) Aynı id  3) İçerik (adet dahil)  4) İçerik (adet hariç)
      const taken = new Set();
      const pairs = [];   // { remote, local|null }
      for (const ri of remoteItems) {
        const mappedLocal = localIdFor('order_items', ri.id);
        const byMap = localRows.find(l => l.id === mappedLocal && !taken.has(l.id));
        if (byMap) { taken.add(byMap.id); pairs.push({ remote: ri, local: byMap }); continue; }
        pairs.push({ remote: ri, local: null });
      }
      for (const pass of [0, 1]) {
        for (const pr of pairs) {
          if (pr.local) continue;
          const cand = localRows.find(l => !taken.has(l.id) &&
            !isMappedRemote('order_items', l.id) &&
            (pass === 0 ? sig(l) === sig(pr.remote) : looseSig(l) === looseSig(pr.remote)));
          if (cand) { taken.add(cand.id); pr.local = cand; }
        }
      }

      const keepLocal = new Set();
      for (const pr of pairs) {
        if (pr.local) {
          // Eşleşti: local id KORUNUR, sunucunun id'si eşleme tablosuna yazılır.
          if (pr.remote.id !== pr.local.id) learnId('order_items', pr.local.id, pr.remote.id);
          keepLocal.add(pr.local.id);
          // Gönderilmeyi bekleyen local değişiklik varsa uzak ESKİ hâl ezmesin.
          if (blocked.order_items && blocked.order_items.has(pr.local.id)) continue;
          // Local ilerlemesi (istasyona gönderildi / hazır) uzak ESKİ hâl
          // tarafından geri alınmasın — yoksa kalem yeniden "gönderilmemiş"
          // sayılıp istasyondan ikinci kez fiş çıkar.
          const ig = guardRegression(db, 'order_items', {
            ...pr.remote, id: pr.local.id, restaurant_id: o.restaurant_id, order_id: localOrderId,
          }, pr.local);
          if (ig.regressed) requeueLocalAhead('order_items', { ...pr.local, id: pr.local.id });
          if (upsertRow(db, 'order_items', ig.row)) itemsChanged = true;
        } else {
          // Uzakta yeni eklenmiş kalem: local'e olduğu gibi iner.
          keepLocal.add(pr.remote.id);
          if (upsertRow(db, 'order_items', {
            ...pr.remote, restaurant_id: o.restaurant_id, order_id: localOrderId,
          })) itemsChanged = true;
        }
      }

      // Uzakta silinmiş kalemleri local'den de temizle
      // Uzakta silinmiş kalemleri local'den de temizle.
      // DİKKAT: Bu döngü eskiden yalnızca "uzakta en az 1 kalem varsa" çalışıyordu.
      // Bu yüzden sitede bir siparişin TÜM kalemleri birden silindiğinde (masadaki
      // kutunun içindekilerin hepsi) uzak liste boş geliyor, döngü hiç çalışmıyor
      // ve kalemler uygulamada olduğu gibi kalıyordu. Tek tek silmede sorun
      // görünmemesinin sebebi de buydu: geriye hep en az bir kalem kalıyordu.
      // Artık boş liste de geçerli bir cevap; yalnızca kalem alanı HİÇ gelmediyse
      // (sunucu kalemleri göndermiyorsa) dokunmuyoruz.
      if (hasItemsField) {
        for (const ex of localRows) {
          if (keepLocal.has(ex.id)) continue;
          if (blocked.order_items && blocked.order_items.has(ex.id)) continue; // henüz gönderilmedi
          db.prepare('DELETE FROM order_items WHERE id=?').run(ex.id);
          db.prepare('DELETE FROM id_map WHERE entity_table=? AND local_id=?').run('order_items', ex.id);
          itemsChanged = true;
        }
      }

      if (orderChanged || itemsChanged) changed++;
    }
  })(orders);
  return changed;
}

const _emptyStreak = {};
// Uzak listede üst üste kaç turdur görünmeyen sipariş (silme kararı için)
const _missStreak = new Map();
let _pulling = false;
async function pullRemoteUpdates({ force = false } = {}) {
  if (_pulling) return { pulled: 0, busy: true };
  const db = getDB();
  const serverUrl = H.cfgGet('server_url');
  const rid = restaurantId();
  if (!serverUrl || !H.cfgGet('auth_token') || !rid) {
    state.lastError = !serverUrl ? 'Sunucu adresi kayıtlı değil'
                     : !H.cfgGet('auth_token') ? 'Giriş oturumu kayıtlı değil — kurulum ekranından tekrar giriş yapın'
                     : 'restaurant_id kayıtlı değil';
    broadcastStatus();
    return { pulled: 0, skipped: true };
  }

  _pulling = true;
  state.syncing = true;
  const base = serverUrl.replace(/\/$/, '');
  const blocked = pendingEntityIds();
  let pulled = 0;
  const touched = new Set();

  const get = async (table, qs = '') => {
    const url = `${base}/api/index.php?table=${encodeURIComponent(table)}&restaurant_id=${encodeURIComponent(rid)}${qs}`;
    const resp = await httpJson(url, { headers: authHeaders() });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} (${table})`);
    return resp.json();
  };

  // Uzak taraftaki SİLMELERİ local'e yansıt.
  // Kök sorun: pull şimdiye kadar yalnızca ekliyor/güncelliyordu. Bu yüzden
  // siteden silinen bir sipariş/ürün/masa local'de sonsuza kadar duruyordu.
  // Tam liste çektiğimiz tablolarda, uzakta artık olmayan satırları siliyoruz.
  // Güvenlik kuralları:
  //  • Sadece TAM liste çekilen tablolarda çalışır (filtreli sorgularda asla).
  //  • Boş/başarısız yanıtta hiçbir şey silinmez (yanlışlıkla her şeyi silmeyelim).
  //  • Kuyrukta bekleyen/gönderilemeyen (local'de yeni oluşturulmuş) kayıtlar korunur.
  //  • Yalnızca bu restorana ait satırlar.
  const reconcileDeletes = (t, list) => {
    if (t === 'settings') return 0;
    const cols = localColumnsOf(db, t);
    if (!cols.has('id')) return 0;
    const remoteIds = new Set(list.map(r => r && r.id).filter(Boolean).map(id => localIdFor(t, id)));
    // Uzak liste BOŞ olabilir — bu geçerli bir cevaptır (sitedeki son ürün de
    // silinmiş olabilir). Ama tek seferlik bir aksaklık yüzünden local'i
    // boşaltmayalım: boş yanıtı üst üste iki turda görmeden silmiyoruz.
    if (!remoteIds.size) {
      _emptyStreak[t] = (_emptyStreak[t] || 0) + 1;
      if (_emptyStreak[t] < 2) return 0;
    } else {
      _emptyStreak[t] = 0;
    }
    const scoped = cols.has('restaurant_id');
    const localRows = scoped
      ? db.prepare(`SELECT id FROM "${t}" WHERE restaurant_id=?`).all(rid)
      : db.prepare(`SELECT id FROM "${t}"`).all();
    const doomed = localRows
      .map(r => r.id)
      .filter(id => !remoteIds.has(id) && !(blocked[t] && blocked[t].has(id)));
    if (!doomed.length) return 0;
    const del = db.prepare(`DELETE FROM "${t}" WHERE id=?`);
    const delMap = db.prepare('DELETE FROM id_map WHERE entity_table=? AND local_id=?');
    db.transaction((ids) => { for (const id of ids) { del.run(id); delMap.run(t, id); } })(doomed);
    console.log(`[sync] ${t}: uzakta silinmiş ${doomed.length} kayıt local'den de silindi`);
    touched.add(t);
    return doomed.length;
  };

  const applyList = (t, rows, { full = false } = {}) => {
    const list = Array.isArray(rows) ? rows : (rows && rows.id ? [rows] : []);
    // Boş liste de anlamlıdır: uzakta hiç kayıt kalmamış olabilir. Sadece istek
    // GERÇEKTEN başarılı olduysa (get() hata fırlatmadıysa) buraya geliyoruz.
    if (!list.length && !(full && Array.isArray(rows))) return 0;
    let n = 0;
    db.transaction((l) => {
      for (const r of l) {
        // Gelen satır local kimliğine çevrilir (sunucu farklı id kullanıyorsa).
        const row = { ...r, id: localIdFor(t, r.id) };
        if (blocked[t] && blocked[t].has(row.id)) continue;
        if (upsertRow(db, t, row)) n++;
      }
    })(list);
    if (full) n += reconcileDeletes(t, list);
    if (n) touched.add(t);
    // Bu satırlarda görsel alanı varsa ve dosya bu cihazda yoksa (başka bir
    // cihazda yüklenmiş demektir), arka planda indir — aksi halde ürün/logo
    // resimleri diğer cihazlarda hep 404 kalırdı.
    downloadMissingImages(base, list).catch(() => {});
    return n;
  };

  try {
    // 1) Siparişler — artımlı, 15 dk güvenlik payıyla (saat farkı / geç yazılan satır)
    const lastPull = H.cfgGet('last_incremental_sync') || H.cfgGet('last_full_sync');
    const sinceDate = lastPull
      ? new Date(new Date(lastPull).getTime() - 15 * 60 * 1000)
      : new Date(Date.now() - 90 * 24 * 3600 * 1000);
    const since = sinceDate.toISOString().slice(0, 19).replace('T', ' ');

    // ── DERİN TARAMA ──
    // Normal pull yalnızca SON SENKRONDAN BU YANA değişenlere bakar. Sitede
    // TOPLU silme yapıldığında (gün kapatma, masa temizleme) silinen siparişlerin
    // çoğu bu pencerenin DIŞINDA kalır ve local'de sonsuza kadar dururdu —
    // "tek tek silince gidiyor, toplu silince gitmiyor" sorununun sebebi buydu.
    // Bu yüzden belirli aralıklarla (ve uzaktan olay geldiğinde) son 7 günün
    // TAMAMINI tarayıp mutabakat yapıyoruz.
    const lastDeep = Number(H.cfgGet('last_deep_reconcile') || 0);
    const deep = force || (Date.now() - lastDeep > DEEP_RECONCILE_MS);
    const deepSince = new Date(Date.now() - DEEP_WINDOW_DAYS * 24 * 3600 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');
    const effectiveSince = deep ? deepSince : since;

    try {
      const orders = await get('orders', `&gte_created_at=${encodeURIComponent(effectiveSince)}`);
      if (Array.isArray(orders)) {
        if (deep) H.cfgSet('last_deep_reconcile', String(Date.now()));
        if (orders.length) {
          const n = applyOrders(db, orders, { blocked });
          if (n) { pulled += n; touched.add('orders'); }
        }
        // SİTEDE SİLİNEN SİPARİŞLER: çektiğimiz zaman aralığında uzakta artık
        // olmayan siparişler local'den de silinir (kalemleriyle birlikte).
        // Kuyrukta bekleyen/gönderilemeyen local siparişlere dokunulmaz.
        const remoteIds = new Set(orders.map(o => o && o.id).filter(Boolean).map(id => localIdFor('orders', id)));
        const localInWindow = db.prepare(
          'SELECT id FROM orders WHERE restaurant_id=? AND created_at >= ?').all(rid, effectiveSince);
        // Az önce gönderilmiş bir sipariş, sunucunun listesine henüz yansımamış
        // olabilir. Son 60 saniyede oluşturulan siparişleri silmiyoruz ki
        // kasadaki yeni sipariş gözünün önünde kaybolmasın. (Daha uzun bir süre,
        // sitede silinen siparişin local'den gitmesini gereksiz geciktirirdi.)
        // Koruma YALNIZCA sunucunun henüz haberi olmayan yeni siparişler için:
        // gönderimi onaylanmış (id_map'te kaydı olan) bir sipariş uzak listede
        // yoksa SİTEDE SİLİNMİŞTİR ve local'den de hemen silinmelidir.
        const graceIso = new Date(Date.now() - 60000).toISOString().slice(0, 19).replace('T', ' ');
        const confirmed = new Set(db.prepare(
          `SELECT local_id FROM id_map WHERE entity_table='orders'`).all().map(r => r.local_id));
        const fresh = new Set(db.prepare(
          'SELECT id FROM orders WHERE restaurant_id=? AND created_at >= ?').all(rid, graceIso)
          .map(r => r.id).filter(id => !confirmed.has(id)));
        // Sunucuya HİÇ ulaşmamış siparişler (eşleme kaydı yok) dokunulmaz;
        // ulaşmış olanlar için liste + kesin doğrulama karar verir.
        const doomed = localInWindow
          .map(r => r.id)
          .filter(id => !remoteIds.has(id) && !fresh.has(id) && confirmed.has(id));
        // ── KESİN DOĞRULAMA ──
        // Liste karşılaştırması tek başına yeterli değil: sunucunun liste uç
        // noktası filtreleyebilir, sayfalayabilir ya da farklı bir zaman alanına
        // göre süzebilir. Bu yüzden silmeden ÖNCE her şüpheli siparişi doğrudan
        // id ile soruyoruz. 404 = gerçekten silinmiş. Cevap alınamazsa dokunmuyoruz.
        const verified = [];
        for (const id of doomed.slice(0, 25)) {
          const remoteKey = remoteIdFor('orders', id);
          let decided = false;
          try {
            // restaurant_id de gönderiyoruz: bazı sunucular bu parametre
            // olmadan 400 döndürüp soruyu cevapsız bırakıyor.
            const r = await httpJson(
              `${base}/api/index.php?table=orders&id=${encodeURIComponent(remoteKey)}` +
              `&restaurant_id=${encodeURIComponent(rid)}`,
              { headers: authHeaders(), timeout: 10000 });
            if (r.status === 404 || r.status === 410) { verified.push(id); decided = true; }
            else if (r.ok) {
              const row = await r.json().catch(() => null);
              const found = Array.isArray(row)
                ? row.some(x => x && String(x.id) === String(remoteKey))
                : !!(row && row.id);
              if (found) { _missStreak.delete(id); decided = true; }   // duruyor
              else { verified.push(id); decided = true; }              // yok
            }
          } catch (e) { decided = true; /* ağ sorunu → asla silme */ }

          // ── CEVAPSIZ KALDIYSA ──
          // Sunucu bu soruya anlamlı cevap vermiyorsa (400/5xx/yetki), tek
          // seferlik bir aksaklık yüzünden veri silmeyelim diye ısrar ediyoruz:
          // sipariş ÜST ÜSTE 2 TURDA uzak listede yoksa silinmiş kabul edilir.
          if (!decided) {
            const n = (_missStreak.get(id) || 0) + 1;
            _missStreak.set(id, n);
            if (n >= 2) { verified.push(id); _missStreak.delete(id); }
          }
        }
        for (const id of verified) _missStreak.delete(id);
        doomed.length = 0;
        doomed.push(...verified);

        if (doomed.length) {
          const delItems = db.prepare('DELETE FROM order_items WHERE order_id=?');
          const delOrder = db.prepare('DELETE FROM orders WHERE id=?');
          db.transaction((ids) => {
            for (const id of ids) {
              // Sunucuda kesin olarak YOK: bu siparişe ait kuyrukta bekleyen
              // istekler artık anlamsızdır (sipariş sitede silinmiş). Onları
              // düşürüyoruz, yoksa sipariş local'de sonsuza kadar takılı kalırdı.
              const itemIds = db.prepare('SELECT id FROM order_items WHERE order_id=?').all(id).map(r => r.id);
              const drop = db.prepare(
                `UPDATE sync_queue SET status='synced', synced_at=datetime('now')
                  WHERE status IN ('pending','failed') AND entity_id=?`);
              drop.run(id);
              for (const iid of itemIds) { drop.run(iid); db.prepare('DELETE FROM id_map WHERE entity_table=? AND local_id=?').run('order_items', iid); }
              delItems.run(id); delOrder.run(id);
              db.prepare("DELETE FROM id_map WHERE entity_table='orders' AND local_id=?").run(id);
            }
          })(doomed);
          pulled += doomed.length;
          touched.add('orders');
          console.log(`[sync] uzakta silinmiş ${doomed.length} sipariş local'den de silindi`);
        }
      }
    } catch (e) {
      // Siparişler alınamadıysa diğer tablolar yine de çekilsin.
      state.lastError = String(e.message || e);
    }

    // 2) Sık değişen küçük tablolar — her turda
    for (const t of HOT_TABLES) {
      try { pulled += applyList(t, await get(t), { full: true }); }
      catch (e) { /* tek tablo hatası tüm senkronu durdurmasın */ }
    }

    // 3) Menü/katalog — daha seyrek (ya da zorlandığında)
    const lastCat = Number(H.cfgGet('last_catalog_sync') || 0);
    if (force || Date.now() - lastCat > CATALOG_MS) {
      for (const t of SYNC_TABLES) {
        if (HOT_TABLES.includes(t)) continue;
        try { pulled += applyList(t, await get(t), { full: true }); } catch (e) {}
      }
      // Restoran kaydı (ad, logo, KDV ayarları) katalogla birlikte tazelenir.
      // Eskiden yalnızca ilk kurulumda indiriliyordu; sonradan değişen/eklenen
      // logo hiçbir zaman gelmiyordu.
      try {
        const r = await get('restaurants');
        const row = Array.isArray(r) ? r.find(x => x && x.id === rid) : r;
        if (row && row.id) {
          // Sunucu logoyu 'logo' veya 'image' adıyla gönderebilir; local sütun
          // adı 'logo_url'. Eşlemezsek alan sessizce düşer ve logo hiç görünmez.
          if (!row.logo_url && (row.logo || row.image)) row.logo_url = row.logo || row.image;
          if (upsertRow(db, 'restaurants', row)) { pulled++; touched.add('restaurants'); }
          downloadMissingImages(base, [row]).catch(() => {});
        }
      } catch (e) {}
      {
      }
      H.cfgSet('last_catalog_sync', String(Date.now()));
    }

    H.cfgSet('last_incremental_sync', new Date().toISOString());
    state.online = true;
    state.lastPullAt = new Date().toISOString();
    state.authError = false;
    state.lastError = null;

    // Uzaktan veri geldiyse arayüzü ANINDA tazele
    if (touched.has('orders')) E.publish(rid, 'order_update', { source: 'sync' });
    if (touched.has('tables')) E.publish(rid, 'table_update', { source: 'sync' });
    for (const t of touched) {
      if (t === 'orders' || t === 'tables') continue;
      E.publish(rid, 'data_update', { table: t, source: 'sync' });
    }
    return { pulled };
  } catch (e) {
    // Tek bir tablo/istek hatası "internet yok" demek DEĞİLDİR; bağlantı
    // durumunu yalnızca probeOnline() belirler. Burada sadece hatayı gösteriyoruz.
    state.lastError = String(e.message || e);
    return { pulled: 0, error: state.lastError };
  } finally {
    _pulling = false;
    state.syncing = false;
    broadcastStatus();
  }
}

// ── UZAK SSE: karşı taraftaki değişiklikleri ANINDA öğren ────
let _remoteAbort = null;
let _remoteRetry = 2000;

async function connectRemoteRealtime() {
  const serverUrl = H.cfgGet('server_url');
  const rid = restaurantId();
  if (!serverUrl || !rid || _remoteAbort || !_running) return;

  const ctl = new AbortController();
  _remoteAbort = ctl;
  const url = `${serverUrl.replace(/\/$/, '')}/api/index.php?table=realtime&restaurant_id=${encodeURIComponent(rid)}&last_id=0`;

  try {
    const resp = await fetch(url, {
      headers: { Accept: 'text/event-stream', ...authHeaders() },
      signal: ctl.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(`SSE HTTP ${resp.status}`);

    state.realtime = true;
    state.online = true;
    _remoteRetry = 2000;
    broadcastStatus();

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let lastData = Date.now();

    // Akış sessizleşirse (hosting buffer'lıyor olabilir) bağlantıyı tazele
    const watchdog = setInterval(() => {
      if (Date.now() - lastData > 45000) { try { ctl.abort(); } catch (e) {} }
    }, 10000);

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastData = Date.now();
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split('\n\n');
        buf = chunks.pop() || '';
        for (const chunk of chunks) {
          const evLine = chunk.split('\n').find(l => l.startsWith('event:'));
          const ev = evLine ? evLine.slice(6).trim() : 'message';
          if (ev === 'ping' || !chunk.trim()) continue;
          triggerSync({ reason: 'remote:' + ev }); // uzakta değişiklik → gecikmesiz çek
        }
      }
    } finally { clearInterval(watchdog); }
  } catch (e) {
    // SSE yoksa/koptuysa sorun değil — uyarlanabilir zamanlayıcı yedeği çalışır
  } finally {
    state.realtime = false;
    _remoteAbort = null;
    broadcastStatus();
    if (_running) {
      _remoteRetry = Math.min(Math.round(_remoteRetry * 1.6), 60000);
      setTimeout(() => connectRemoteRealtime(), _remoteRetry);
    }
  }
}

// ── DÖNGÜ / TETİKLEYİCİLER ───────────────────────────────────
let _running = false;
let _tick = null;
let _immediate = null;
let _cycling = false;

function scheduleImmediatePush() {
  if (!_running || _immediate) return;
  // Art arda gelen yazmaları tek turda toplamak için kısa gecikme
  _immediate = setTimeout(() => { _immediate = null; runCycle('local-write'); }, 250);
}

function triggerSync({ reason } = {}) {
  if (!_running) return;
  runCycle(reason || 'manual');
}

let _rerun = false;
async function runCycle(reason) {
  // Tur devam ederken gelen tetikleme ESKİDEN sessizce düşüyordu: siteden gelen
  // bir silme/değişiklik olayı, o an bir senkron turu çalışıyorsa kayboluyor ve
  // değişiklik local'e ancak dakikalar sonra (zamanlayıcıyla) geliyordu.
  // Artık tetikleme kaydediliyor ve tur biter bitmez yeni tur başlıyor.
  if (_cycling) { _rerun = true; return; }
  _cycling = true;
  try {
    // Önce gerçekten çevrimiçi miyiz? (rozetin doğru olması için)
    const wasOnline = state.online;
    const online = await probeOnline();
    if (online !== wasOnline) broadcastStatus();
    if (!online) return;             // ağ yok: boşuna deneyip hata biriktirme
    // Çevrimdışıdan çevrimiçine geçiş: bekleyen hataları otomatik onar/dene.
    if (!wasOnline || reason === 'network-online' || reason === 'startup') reviveFailed();
    await pushQueue();
    // Uzaktan bir olay geldiyse (siteden silme/değişiklik) katalog tabloları da
    // beklemeden tazelensin — 2 dakikalık katalog aralığını bekletmeyelim.
    await pullRemoteUpdates({ force: String(reason || '').startsWith('remote:') });
  } catch (e) {
    state.lastError = String(e.message || e);
  } finally {
    _cycling = false;
    rearm();
  }
  if (_rerun) { _rerun = false; await runCycle('coalesced'); }
}

function rearm() {
  if (!_running) return;
  if (_tick) clearTimeout(_tick);
  refreshCounters();
  let delay = TICK_IDLE_MS;
  if (!state.online) delay = TICK_OFFLINE_MS;
  else if (state.pending > 0) delay = TICK_ACTIVE_MS;
  else if (state.realtime) delay = TICK_IDLE_MS * 2; // SSE anlık haber veriyor
  // Uzak SSE kurulamadıysa (hosting stream'i kapatıyorsa) sitedeki değişikliklerin
  // buraya gelmesi tamamen bu zamanlayıcıya kalır → sık yokla.
  else delay = 5000;
  _tick = setTimeout(() => runCycle('timer'), delay);
}

function startBackgroundSync() {
  if (_running) return;
  _running = true;
  runCycle('startup');
  connectRemoteRealtime();
}

function stopBackgroundSync() {
  _running = false;
  if (_tick) clearTimeout(_tick);
  if (_immediate) clearTimeout(_immediate);
  if (_remoteAbort) { try { _remoteAbort.abort(); } catch (e) {} }
}

// Ölü-mektup kutusundaki kayıtları kullanıcı isteğiyle tekrar dene
function retryFailed() {
  getDB().prepare(`UPDATE sync_queue SET status='pending', attempts=0, next_attempt_at=NULL WHERE status='failed'`).run();
  refreshCounters();
  triggerSync({ reason: 'retry-failed' });
  return { requeued: state.pending };
}

// Onarılamayan (ör. artık geçersiz) kayıtları kullanıcı isteğiyle kuyruktan at.
// Bunlar local'de zaten uygulanmış durumda; sadece sunucuya gönderilemeyenler.
function clearFailed() {
  const info = getDB().prepare(`DELETE FROM sync_queue WHERE status='failed'`).run();
  refreshCounters();
  broadcastStatus();
  return { cleared: info.changes };
}

function failedItems(limit = 50) {
  return getDB().prepare(
    `SELECT id, method, path, entity_table, entity_id, attempts, last_error, created_at
     FROM sync_queue WHERE status='failed' ORDER BY id DESC LIMIT ?`).all(limit);
}

// ── SUNUCU SÖZLEŞME TESTİ ────────────────────────────────────
// Gerçek online sunucunun (ör. menux.ge) bizim id'lerimize saygı duyup
// duymadığını CANLI olarak ölçer. Hatanın local'de mi sunucuda mı olduğunu
// tahmin etmeyi bitirir.
async function diagnose() {
  const serverUrl = H.cfgGet('server_url');
  const rid = restaurantId();
  const out = { server_url: serverUrl, restaurant_id: rid, steps: [] };
  const add = (name, ok, detail) => out.steps.push({ name, ok, detail: String(detail).slice(0, 300) });
  if (!serverUrl || !rid) { add('yapılandırma', false, 'server_url/restaurant_id yok'); return out; }
  const base = serverUrl.replace(/\/$/, '');

  try {
    const r = await httpJson(`${base}/api/index.php?table=events_ping&restaurant_id=${rid}`, { headers: authHeaders() });
    add('sunucuya erişim', r.ok, `HTTP ${r.status}`);
  } catch (e) { add('sunucuya erişim', false, e.message); return out; }

  // Deneme siparişi: sunucu bizim id'mizi kullanıyor mu?
  const testOrderId = H.uuid();
  const testItemId = H.uuid();
  try {
    const r = await httpJson(`${base}/api/index.php?table=orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        id: testOrderId, restaurant_id: rid, status: 'pending', total: 0.01,
        note: 'TANI TESTI - silinebilir',
        order_items: [{ id: testItemId, product_name: 'TANI', quantity: 1, price: 0.01 }],
      }),
    });
    const data = await r.json().catch(() => ({}));
    add('sipariş oluşturma', r.ok, `HTTP ${r.status} dönen id=${data && data.id}`);
    add('SUNUCU SİPARİŞ ID\'MİZİ KULLANIYOR', !!(data && data.id === testOrderId),
        `gönderdik=${testOrderId} döndü=${data && data.id}`);
    const items = (data && data.order_items) || [];
    add('SUNUCU KALEM ID\'MİZİ KULLANIYOR', items.some(i => i.id === testItemId),
        `gönderdik=${testItemId} döndü=${items.map(i => i.id).join(',')}`);

    // Kalem güncellemesi çalışıyor mu?
    const r2 = await httpJson(`${base}/api/index.php?table=order_items&id=${testItemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ quantity: 2 }),
    });
    add('kalem güncelleme (PUT order_items)', r2.ok, `HTTP ${r2.status} ${(await r2.text()).slice(0, 120)}`);

    // Temizlik
    const r3 = await httpJson(`${base}/api/index.php?table=orders&id=${testOrderId}`, { method: 'DELETE', headers: authHeaders() });
    add('deneme siparişi silindi', r3.ok, `HTTP ${r3.status}`);
  } catch (e) { add('sipariş testi', false, e.message); }

  return out;
}

module.exports = {
  diagnose,
  pullInitialData, remoteLoginAndBootstrap,
  queueWrite, queueUpload, pushQueue, pendingCount,
  pullRemoteUpdates, startBackgroundSync, stopBackgroundSync,
  triggerSync, scheduleImmediatePush, getStatus, retryFailed, failedItems, clearFailed, probeOnline, reviveFailed,
  normalizeServerUrl,
};
