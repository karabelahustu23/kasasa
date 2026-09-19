// test/e2e.js — Uçtan uca senkron testleri.
// Gerçek local sunucu + gerçek SQLite + "site"yi taklit eden katı bir uzak sunucu.
const fs = require('fs');
const path = require('path');

const DATA = '/tmp/e2e-data';
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.EQEQE_DATA_DIR = DATA;

const { createRemote, T, RID, opts, uploadFiles } = require('./mock-remote');
const { createApp } = require('../server/app');
const sync = require('../server/sync');
const H = require('../server/helpers');
const { getDB } = require('../server/db');

const REMOTE_PORT = 18101;
const LOCAL_PORT = 18100;
const REMOTE = `http://127.0.0.1:${REMOTE_PORT}`;
const LOCAL = `http://127.0.0.1:${LOCAL_PORT}`;

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Ağı kesip açmak için: uzak sunucuya giden istekleri engelle
let NET_DOWN = false;
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  if (NET_DOWN && String(url).includes(`:${REMOTE_PORT}`)) {
    return Promise.reject(new Error('ECONNREFUSED (test: ağ kapalı)'));
  }
  return realFetch(url, opts);
};

let token = null;
async function api(method, qs, body, extra = {}) {
  const resp = await realFetch(`${LOCAL}/api/index.php?${qs}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await resp.json(); } catch (e) {}
  return { status: resp.status, data };
}

const db = () => getDB();
const localCount = (t, where = '', args = []) =>
  db().prepare(`SELECT COUNT(*) n FROM "${t}" ${where}`).get(...args).n;
const queueStat = () => db().prepare(
  `SELECT status, COUNT(*) n FROM sync_queue GROUP BY status`).all()
  .reduce((a, r) => (a[r.status] = r.n, a), {});
const failedErrors = () => db().prepare(
  `SELECT method, entity_table, entity_id, last_error FROM sync_queue WHERE status='failed'`).all();

async function main() {
  const remoteSrv = createRemote().listen(REMOTE_PORT);
  const localSrv = createApp().listen(LOCAL_PORT);
  await sleep(300);

  console.log('\n── 1. Kurulum (site\'den giriş + ilk veri indirme) ───────────');
  await sync.remoteLoginAndBootstrap({
    serverUrl: REMOTE, email: 'a@b.c', password: 'sifre123',
  });
  check('bootstrap tamam', !!H.cfgGet('auth_token') && H.cfgGet('restaurant_id') === RID);

  // local login (admin.html'in yaptığı gibi) — token'ı local sunucudan al
  const login = await api('POST', 'table=auth&action=login', { email: 'a@b.c', password: 'sifre123' });
  token = login.data && login.data.token;
  check('local giriş', !!token, JSON.stringify(login.data).slice(0, 100));

  sync.startBackgroundSync();
  await sleep(600);

  console.log('\n── 2. ÇEVRİMİÇİ: masa + ürün oluştur, site\'ye gitsin ────────');
  const t1 = await api('POST', 'table=tables', { restaurant_id: RID, number: 1 });
  const cat = await api('POST', 'table=categories', { restaurant_id: RID, name: 'İçecek' });
  const prod = await api('POST', 'table=products', {
    restaurant_id: RID, category_id: cat.data && cat.data.id, name: 'Çay', price: 20,
  });
  check('ürün local\'de oluştu', prod.status < 400, JSON.stringify(prod.data).slice(0, 120));
  await sync.triggerSync({ reason: 'manual' }); await sleep(800);
  const remoteProd = [...T('products').values()][0];
  check('ürün site\'ye gitti', !!remoteProd);
  check('ürün id\'leri AYNI', remoteProd && remoteProd.id === prod.data.id,
    `local=${prod.data && prod.data.id} remote=${remoteProd && remoteProd.id}`);

  console.log('\n── 3. Çevrimiçi durum göstergesi ────────────────────────────');
  await sync.probeOnline();
  check('rozet çevrimiçi gösteriyor', sync.getStatus().online === true);

  console.log('\n── 4. ÇEVRİMDIŞI: sipariş aç, kalem ekle, düzenle, sil ──────');
  NET_DOWN = true;
  await sync.probeOnline();
  check('ağ kesilince çevrimdışı', sync.getStatus().online === false);

  const tableId = (t1.data && (Array.isArray(t1.data) ? t1.data[0].id : t1.data.id));
  const ord = await api('POST', 'table=orders', {
    restaurant_id: RID, table_id: tableId,
    order_items: [{ product_id: prod.data.id, product_name: 'Çay', quantity: 2, price: 20 }],
  });
  check('offline sipariş açıldı', ord.status < 400, JSON.stringify(ord.data).slice(0, 150));
  const orderId = ord.data && ord.data.id;
  const itemId = ord.data && ord.data.order_items && ord.data.order_items[0] && ord.data.order_items[0].id;

  // aynı siparişe kalem ekle
  const addItem = await api('POST', 'table=order_items', [
    { order_id: orderId, product_id: prod.data.id, product_name: 'Çay', quantity: 1, price: 20 },
  ]);
  check('offline kalem eklendi', addItem.status < 400, JSON.stringify(addItem.data).slice(0, 120));

  // aynı kaydı defalarca düzenle (kuyruk şişmesi senaryosu)
  for (let i = 0; i < 5; i++) {
    await api('PUT', `table=orders&id=${orderId}`, { note: 'not ' + i });
  }
  // kalemi güncelle + sil
  await api('PUT', `table=order_items&id=${itemId}`, { quantity: 3 });
  await api('DELETE', `table=order_items&id=${itemId}`);

  // offline ürün düzenle
  await api('PUT', `table=products&id=${prod.data.id}`, { price: 25 });

  const qOffline = queueStat();
  check('kuyrukta bekleyen işler var', (qOffline.pending || 0) > 0, JSON.stringify(qOffline));

  console.log('\n── 5. İNTERNET GERİ GELDİ: hepsi hatasız gitsin ─────────────');
  NET_DOWN = false;
  for (let i = 0; i < 6; i++) { await sync.triggerSync({ reason: 'network-online' }); await sleep(500); }
  const q = queueStat();
  check('gönderilemeyen kayıt YOK', !q.failed, JSON.stringify(failedErrors()).slice(0, 600));
  check('bekleyen kayıt kalmadı', !q.pending, JSON.stringify(q));

  const remoteOrder = T('orders').get(orderId);
  check('sipariş site\'ye AYNI id ile gitti', !!remoteOrder, `orderId=${orderId}`);
  const remoteItems = [...T('order_items').values()].filter(i => i.order_id === orderId);
  check('site\'de kalem sayısı doğru (1)', remoteItems.length === 1,
    `remote=${remoteItems.length} local=${localCount('order_items', 'WHERE order_id=?', [orderId])}`);
  check('site\'de kopya kalem yok', remoteItems.length === localCount('order_items', 'WHERE order_id=?', [orderId]));
  check('offline ürün fiyatı site\'ye işlendi',
    T('products').get(prod.data.id) && Number(T('products').get(prod.data.id).price) === 25,
    JSON.stringify(T('products').get(prod.data.id)));

  console.log('\n── 6. SİTEDE SİLME → local\'de de silinsin ───────────────────');
  T('orders').delete(orderId);
  for (const [k, v] of T('order_items')) if (v.order_id === orderId) T('order_items').delete(k);
  // 60 sn'lik "yeni sipariş koruması"nı atlamak için siparişi eskitiyoruz
  db().prepare("UPDATE orders SET created_at=datetime('now','-5 minutes') WHERE id=?").run(orderId);
  await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(600);
  check('site\'de silinen sipariş local\'den silindi',
    localCount('orders', 'WHERE id=?', [orderId]) === 0,
    `local hâlâ ${localCount('orders', 'WHERE id=?', [orderId])} satır`);
  check('siparişin kalemleri de temizlendi',
    localCount('order_items', 'WHERE order_id=?', [orderId]) === 0);

  console.log('\n── 7. SİTEDE ürün silme → local\'de de silinsin ─────────────');
  T('products').delete(prod.data.id);
  // (uzak liste tamamen boşaldıysa güvenlik gereği iki tur bekleniyor)
  await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(800);
  await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(800);
  check('site\'de silinen ürün local\'den silindi',
    localCount('products', 'WHERE id=?', [prod.data.id]) === 0);

  console.log('\n── 8. SİTEDE ekleme → local\'e anında gelsin ────────────────');
  const siteProdId = 'site-prod-1';
  T('products').set(siteProdId, {
    id: siteProdId, restaurant_id: RID, category_id: cat.data.id, name: 'Kahve', price: 40, created_at: '2020-01-01 00:00:00',
  });
  await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(600);
  check('site\'de eklenen ürün local\'e indi', localCount('products', 'WHERE id=?', [siteProdId]) === 1);

  console.log('\n── 9. Offline kayıt, site tarafından EZİLMEMELİ ─────────────');
  NET_DOWN = true;
  const ord2 = await api('POST', 'table=orders', {
    restaurant_id: RID, table_id: tableId,
    order_items: [{ product_id: siteProdId, product_name: 'Kahve', quantity: 1, price: 40 }],
  });
  const ord2Id = ord2.data && ord2.data.id;
  NET_DOWN = false;
  // site bu siparişi henüz bilmiyor; pull sırasında SİLİNMEMELİ
  await sync.pullRemoteUpdates({ force: true }); await sleep(200);
  check('gönderilmemiş offline sipariş korunuyor', localCount('orders', 'WHERE id=?', [ord2Id]) === 1);
  for (let i = 0; i < 4; i++) { await sync.triggerSync({ reason: 'manual' }); await sleep(400); }
  check('sonra site\'ye gitti', !!T('orders').get(ord2Id));
  check('bu turda da hata yok', !queueStat().failed, JSON.stringify(failedErrors()).slice(0, 400));

  console.log('\n── 10. Sunucuda olmayan kaydı güncelleme (PUT→POST onarımı) ─');
  const p2 = await api('POST', 'table=products', { restaurant_id: RID, category_id: cat.data.id, name: 'Soda', price: 15 });
  await sync.triggerSync({ reason: 'manual' }); await sleep(400);
  T('products').delete(p2.data.id);                 // site'den elle uçtu
  db().prepare('DELETE FROM sync_queue').run();      // kuyruk temiz
  await api('PUT', `table=products&id=${p2.data.id}`, { price: 18 });
  await sync.triggerSync({ reason: 'manual' }); await sleep(600);
  check('PUT→POST onarımı çalıştı (hata yok)', !queueStat().failed, JSON.stringify(failedErrors()).slice(0, 300));
  check('kayıt site\'de yeniden oluştu', !!T('products').get(p2.data.id));
  check('kopya ürün oluşmadı',
    [...T('products').values()].filter(p => p.name === 'Soda').length === 1);

  console.log('\n── 11. Zaten silinmiş kaydı silme (DELETE 404 → başarı) ─────');
  const p3 = await api('POST', 'table=products', { restaurant_id: RID, category_id: cat.data.id, name: 'Ayran', price: 12 });
  await sync.triggerSync({ reason: 'manual' }); await sleep(400);
  T('products').delete(p3.data.id);
  await api('DELETE', `table=products&id=${p3.data.id}`);
  await sync.triggerSync({ reason: 'manual' }); await sleep(600);
  check('DELETE 404 hata üretmedi', !queueStat().failed, JSON.stringify(failedErrors()).slice(0, 300));

  console.log('\n── 12. Görsel: offline yükle, online olunca site\'ye gitsin ─');
  NET_DOWN = true;
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('fake-image-bytes')]), 'test.jpg');
  const up = await realFetch(`${LOCAL}/api/index.php?table=upload&bucket=products`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
  });
  const upData = await up.json();
  check('offline görsel local\'e kaydedildi', !!(upData && upData.url), JSON.stringify(upData).slice(0, 120));
  const p4 = await api('POST', 'table=products', {
    restaurant_id: RID, category_id: cat.data.id, name: 'Limonata', price: 30, image: upData.url,
  });
  NET_DOWN = false;
  for (let i = 0; i < 5; i++) { await sync.triggerSync({ reason: 'network-online' }); await sleep(400); }
  const remoteP4 = T('products').get(p4.data.id);
  check('görselli ürün site\'ye gitti', !!remoteP4);
  check('görsel URL\'i gerçek uzak adrese çevrildi',
    !!(remoteP4 && remoteP4.image && !remoteP4.image.startsWith('/uploads/products/')),
    JSON.stringify(remoteP4 && remoteP4.image));
  check('görsel adımında hata yok', !queueStat().failed, JSON.stringify(failedErrors()).slice(0, 300));

  console.log('\n── 13. Uzun kesinti + çok işlem (yığın testi) ───────────────');
  NET_DOWN = true;
  const bulkIds = [];
  for (let i = 0; i < 25; i++) {
    const r = await api('POST', 'table=orders', {
      restaurant_id: RID, table_id: tableId,
      order_items: [{ product_id: siteProdId, product_name: 'Kahve', quantity: 1, price: 40 }],
    });
    bulkIds.push(r.data.id);
    await api('PUT', `table=orders&id=${r.data.id}`, { note: 'yığın ' + i });
  }
  NET_DOWN = false;
  for (let i = 0; i < 10; i++) { await sync.triggerSync({ reason: 'network-online' }); await sleep(400); }
  const gone = bulkIds.filter(id => T('orders').get(id)).length;
  check('25 offline siparişin tamamı site\'ye gitti', gone === 25, `giden=${gone}/25`);
  check('yığın sonrası hata yok', !queueStat().failed, JSON.stringify(failedErrors()).slice(0, 500));
  check('yığın sonrası kuyruk boş', !queueStat().pending, JSON.stringify(queueStat()));

  console.log('\n── 14. Sunucu 5xx verirken sıra bozulmasın ──────────────────');
  // (mock sunucu 5xx üretmez; bunun yerine ağ hatası ile sıralama korunuyor mu bakıyoruz)
  NET_DOWN = true;
  const pA = await api('POST', 'table=categories', { restaurant_id: RID, name: 'Tatlı' });
  await api('PUT', `table=categories&id=${pA.data.id}`, { name: 'Tatlılar' });
  await sync.triggerSync({ reason: 'manual' }); await sleep(300);
  NET_DOWN = false;
  for (let i = 0; i < 5; i++) { await sync.triggerSync({ reason: 'manual' }); await sleep(400); }
  check('kesinti sonrası POST+PUT sırayla gitti',
    T('categories').get(pA.data.id) && T('categories').get(pA.data.id).name === 'Tatlılar',
    JSON.stringify(T('categories').get(pA.data.id)));
  check('sıra testinde hata yok', !queueStat().failed, JSON.stringify(failedErrors()).slice(0, 300));

  console.log('\n── 15. Local SSE: arayüze anlık olay gidiyor mu ─────────────');
  let sseGot = null;
  const ctl = new AbortController();
  realFetch(`${LOCAL}/api/index.php?table=realtime&restaurant_id=${RID}&last_id=999999`, {
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` }, signal: ctl.signal,
  }).then(async (r) => {
    const rd = r.body.getReader(); const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      const txt = dec.decode(value);
      if (txt.includes('event: new_order') || txt.includes('event: data_update')) { sseGot = txt; break; }
    }
  }).catch(() => {});
  await sleep(400);
  await api('POST', 'table=categories', { restaurant_id: RID, name: 'Anlık' });
  await sleep(500);
  check('local SSE olayı anında geldi', !!sseGot, String(sseGot).slice(0, 80));
  ctl.abort();

  console.log('\n── 16. Sunucu kalem id\'lerini YOK SAYIYORSA (menux.ge senaryosu) ─');
  opts.ignoreItemIds = true;
  db().prepare('DELETE FROM sync_queue').run();
  const ordX = await api('POST', 'table=orders', {
    restaurant_id: RID, table_id: tableId,
    order_items: [{ product_id: siteProdId, product_name: 'Kahve', quantity: 1, price: 40 }],
  });
  const itemX = ordX.data.order_items[0].id;
  await sync.triggerSync({ reason: 'manual' }); await sleep(600);
  // sunucu kendi id'sini ürettiği için bu PUT 404 verecek → onarım devreye girmeli
  await api('PUT', `table=order_items&id=${itemX}`, { quantity: 4 });
  await api('PUT', `table=order_items&id=${itemX}`, { is_ready: 1 });
  for (let i = 0; i < 5; i++) { await sync.triggerSync({ reason: 'manual' }); await sleep(400); }
  check('kalem id\'si yok sayılsa bile hata birikmedi',
    !queueStat().failed, JSON.stringify(failedErrors()).slice(0, 400));
  check('kuyruk temizlendi', !queueStat().pending, JSON.stringify(queueStat()));
  opts.ignoreItemIds = false;

  console.log('\n── 17. Local\'de silinmiş kayda ait bekleyen güncelleme düşer ─');
  const pZ = await api('POST', 'table=products', { restaurant_id: RID, category_id: cat.data.id, name: 'Gazoz', price: 10 });
  await sync.triggerSync({ reason: 'manual' }); await sleep(400);
  db().prepare('DELETE FROM sync_queue').run();
  T('products').delete(pZ.data.id);
  await api('PUT', `table=products&id=${pZ.data.id}`, { price: 11 });
  db().prepare('DELETE FROM products WHERE id=?').run(pZ.data.id); // local\'de de yok artık
  for (let i = 0; i < 3; i++) { await sync.triggerSync({ reason: 'manual' }); await sleep(400); }
  check('anlamsız güncelleme hata üretmeden düştü',
    !queueStat().failed && !queueStat().pending, JSON.stringify(failedErrors()).slice(0, 300));

  console.log('\n── 18. KOPYA SİPARİŞ testi: yanıt kaybolunca tekrar gönderim ─');
  db().prepare('DELETE FROM sync_queue').run();
  NET_DOWN = true;
  const dupOrd = await api('POST', 'table=orders', {
    restaurant_id: RID, table_id: tableId,
    order_items: [{ product_id: siteProdId, product_name: 'Kahve', quantity: 2, price: 40 }],
  });
  const dupId = dupOrd.data.id;
  NET_DOWN = false;
  opts.dropResponses = 2;   // sunucu kaydedecek ama cevap istemciye ulaşmayacak (iki kez)
  for (let i = 0; i < 12; i++) { await sync.triggerSync({ reason: 'network-online' }); await sleep(700); }
  const dupItems = [...T('order_items').values()].filter(i => Number(i.quantity) === 2 && Number(i.price) === 40);
  const dupCount = new Set(dupItems.map(i => i.order_id)).size;
  check('yanıt kaybolsa da sipariş site\'de TEK', dupCount === 1, `site'de ${dupCount} adet`);
  check('kopya testinde hata yok', !queueStat().failed, JSON.stringify(failedErrors()).slice(0, 300));

  console.log('\n── 19. KOPYA SİPARİŞ: sunucu sipariş id\'sini de yok sayarsa ─');
  db().prepare('DELETE FROM sync_queue').run();
  opts.ignoreOrderIds = true;
  NET_DOWN = true;
  const dup2 = await api('POST', 'table=orders', {
    restaurant_id: RID, table_id: tableId,
    order_items: [{ product_id: siteProdId, product_name: 'Kahve', quantity: 7, price: 40 }],
  });
  NET_DOWN = false;
  opts.dropResponses = 2;
  for (let i = 0; i < 12; i++) { await sync.triggerSync({ reason: 'network-online' }); await sleep(700); }
  const dup2Items = [...T('order_items').values()].filter(i => Number(i.quantity) === 7);
  const dup2Count = new Set(dup2Items.map(i => i.order_id)).size;
  check('id yok sayılsa bile sipariş site\'de TEK', dup2Count === 1, `site'de ${dup2Count} adet`);
  opts.ignoreOrderIds = false;

  console.log('\n── 20. LOCAL KOPYA KALEM: offline 4 ürün → online\'da 8 olmamalı ─');
  db().prepare('DELETE FROM sync_queue').run();
  opts.ignoreItemIds = true;          // menux.ge gibi: kalem id'lerini yok sayıyor
  NET_DOWN = true;
  const bm = await api('POST', 'table=orders', {
    restaurant_id: RID, table_id: tableId,
    order_items: [
      { product_id: siteProdId, product_name: 'BigMac', quantity: 1, price: 50 },
      { product_id: siteProdId, product_name: 'BigMac', quantity: 1, price: 50 },
      { product_id: siteProdId, product_name: 'BigMac', quantity: 1, price: 50 },
      { product_id: siteProdId, product_name: 'BigMac', quantity: 1, price: 50 },
    ],
  });
  const bmId = bm.data.id;
  check('offline 4 kalem local\'de', localCount('order_items', 'WHERE order_id=?', [bmId]) === 4);
  NET_DOWN = false;
  for (let i = 0; i < 8; i++) { await sync.triggerSync({ reason: 'network-online' }); await sleep(500); }
  const localItems = localCount('order_items', 'WHERE order_id=?', [bmId]);
  const bmRemoteItems = [...T('order_items').values()].filter(i => i.order_id === bmId).length;
  check('online olunca local\'de HÂLÂ 4 kalem (8 değil)', localItems === 4, `local=${localItems} remote=${bmRemoteItems}`);
  check('kopya kalem hatası birikmedi', !queueStat().failed, JSON.stringify(failedErrors()).slice(0, 400));
  // ikinci tur: tekrar tekrar çoğalmıyor mu
  for (let i = 0; i < 4; i++) { await sync.triggerSync({ reason: 'manual' }); await sleep(400); }
  check('tekrar senkronda da çoğalmıyor',
    localCount('order_items', 'WHERE order_id=?', [bmId]) === 4,
    `local=${localCount('order_items', 'WHERE order_id=?', [bmId])}`);
  opts.ignoreItemIds = false;

  console.log('\n── 21. KALEM DURUMU: offline hazır/mutfak işaretleri korunmalı ─');
  db().prepare('DELETE FROM sync_queue').run();
  opts.ignoreItemIds = true;
  NET_DOWN = true;
  const stOrd = await api('POST', 'table=orders', {
    restaurant_id: RID, table_id: tableId,
    order_items: [
      { product_id: siteProdId, product_name: 'Pizza', quantity: 1, price: 60 },
      { product_id: siteProdId, product_name: 'Salata', quantity: 2, price: 25 },
    ],
  });
  const stId = stOrd.data.id;
  const [i1, i2] = stOrd.data.order_items;
  // offline: birini mutfağa gönder, sonra hazır işaretle; diğerinin adedini değiştir
  await api('PUT', `table=order_items&id=${i1.id}`, { sent_to_kitchen: 1 });
  await api('PUT', `table=order_items&id=${i1.id}`, { is_ready: 1 });
  await api('PUT', `table=order_items&id=${i2.id}`, { quantity: 5 });
  NET_DOWN = false;
  for (let i = 0; i < 10; i++) { await sync.triggerSync({ reason: 'network-online' }); await sleep(500); }

  const rows = db().prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY product_name').all(stId);
  check('kalem sayısı hâlâ 2', rows.length === 2, `local=${rows.length}`);
  const pizza = rows.find(r => r.product_name === 'Pizza');
  const salata = rows.find(r => r.product_name === 'Salata');
  check('offline "mutfağa gönderildi" korundu', pizza && Number(pizza.sent_to_kitchen) === 1, JSON.stringify(pizza));
  check('offline "hazır" korundu', pizza && Number(pizza.is_ready) === 1, JSON.stringify(pizza));
  check('offline adet değişikliği korundu', salata && Number(salata.quantity) === 5, JSON.stringify(salata));

  const rPizza = [...T('order_items').values()].find(i => i.order_id === stId && i.product_name === 'Pizza');
  const rSalata = [...T('order_items').values()].find(i => i.order_id === stId && i.product_name === 'Salata');
  check('durum site\'ye de işlendi', rPizza && Number(rPizza.is_ready) === 1 && Number(rPizza.sent_to_kitchen) === 1, JSON.stringify(rPizza));
  check('adet site\'ye de işlendi', rSalata && Number(rSalata.quantity) === 5, JSON.stringify(rSalata));
  check('durum senkronunda hata yok', !queueStat().failed, JSON.stringify(failedErrors()).slice(0, 400));

  // tekrar senkronlarda durum geri dönmemeli
  for (let i = 0; i < 4; i++) { await sync.triggerSync({ reason: 'manual' }); await sleep(400); }
  const pizza2 = db().prepare("SELECT * FROM order_items WHERE order_id=? AND product_name='Pizza'").get(stId);
  check('durum sonraki senkronlarda geri dönmüyor', pizza2 && Number(pizza2.is_ready) === 1, JSON.stringify(pizza2));
  opts.ignoreItemIds = false;

  console.log('\n── 22. ONLINE iken sitede silme → uygulamadan HEMEN gitsin ──');
  db().prepare('DELETE FROM sync_queue').run();
  const liveOrd = await api('POST', 'table=orders', {
    restaurant_id: RID, table_id: tableId,
    order_items: [{ product_id: siteProdId, product_name: 'Lahmacun', quantity: 3, price: 35 }],
  });
  const liveId = liveOrd.data.id;
  for (let i = 0; i < 4; i++) { await sync.triggerSync({ reason: 'manual' }); await sleep(400); }
  const liveRemoteId = db().prepare("SELECT remote_id FROM id_map WHERE entity_table='orders' AND local_id=?").get(liveId);
  check('sipariş site\'ye gitti', !!(liveRemoteId && T('orders').get(liveRemoteId.remote_id)) || !!T('orders').get(liveId));

  // kullanıcının yaptığı: siteden sil (sipariş HENÜZ yeni, 60 sn dolmadı)
  const delKey = liveRemoteId ? liveRemoteId.remote_id : liveId;
  T('orders').delete(delKey);
  for (const [k, v] of T('order_items')) if (v.order_id === delKey) T('order_items').delete(k);
  await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(900);
  check('uygulamadan da silindi (bekleme yok)', localCount('orders', 'WHERE id=?', [liveId]) === 0,
    `local hâlâ ${localCount('orders', 'WHERE id=?', [liveId])} satır`);
  check('kalemleri de gitti', localCount('order_items', 'WHERE order_id=?', [liveId]) === 0);
  check('silme sonrası hata yok', !queueStat().failed, JSON.stringify(failedErrors()).slice(0, 300));

  console.log('\n── 23. Ama HENÜZ GÖNDERİLMEMİŞ yeni sipariş korunmalı ──────');
  NET_DOWN = true;
  const safeOrd = await api('POST', 'table=orders', {
    restaurant_id: RID, table_id: tableId,
    order_items: [{ product_id: siteProdId, product_name: 'Tost', quantity: 1, price: 20 }],
  });
  NET_DOWN = false;
  await sync.pullRemoteUpdates({ force: true }); await sleep(300);
  check('gönderilmemiş yeni sipariş silinmedi', localCount('orders', 'WHERE id=?', [safeOrd.data.id]) === 1);

  console.log('\n── 24. TOPLU SİLME: sitede eski siparişleri topluca sil ────');
  db().prepare('DELETE FROM sync_queue').run();
  // 3 sipariş aç, senkronla, sonra hepsini ESKİT (gün kapatma sonrası gibi)
  const bulk = [];
  for (let i = 0; i < 3; i++) {
    const r = await api('POST', 'table=orders', {
      restaurant_id: RID, table_id: tableId,
      order_items: [{ product_id: siteProdId, product_name: 'Dürüm', quantity: 1, price: 45 }],
    });
    bulk.push(r.data.id);
  }
  for (let i = 0; i < 5; i++) { await sync.triggerSync({ reason: 'manual' }); await sleep(400); }
  check('3 sipariş site\'ye gitti', bulk.every(id => {
    const m = db().prepare("SELECT remote_id FROM id_map WHERE entity_table='orders' AND local_id=?").get(id);
    return T('orders').get(m ? m.remote_id : id);
  }));

  // hepsini 2 gün öncesine al (normal pull penceresinin DIŞI)
  db().prepare("UPDATE orders SET created_at=datetime('now','-2 days') WHERE id IN (" +
    bulk.map(() => '?').join(',') + ')').run(...bulk);
  for (const id of bulk) {
    const m = db().prepare("SELECT remote_id FROM id_map WHERE entity_table='orders' AND local_id=?").get(id);
    const rk = m ? m.remote_id : id;
    const ro = T('orders').get(rk);
    if (ro) ro.created_at = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  }
  // senkron olsun ki local 'last_incremental_sync' ilerlesin (dar pencere)
  await sync.triggerSync({ reason: 'manual' }); await sleep(600);

  // ŞİMDİ sitede TOPLUCA sil
  for (const id of bulk) {
    const m = db().prepare("SELECT remote_id FROM id_map WHERE entity_table='orders' AND local_id=?").get(id);
    const rk = m ? m.remote_id : id;
    T('orders').delete(rk);
    for (const [k, v] of T('order_items')) if (v.order_id === rk) T('order_items').delete(k);
  }
  await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(1200);
  const kalan = bulk.filter(id => localCount('orders', 'WHERE id=?', [id]) > 0).length;
  check('toplu silinen ESKİ siparişler local\'den de gitti', kalan === 0, `local'de kalan: ${kalan}/3`);
  check('toplu silme sonrası hata yok', !queueStat().failed, JSON.stringify(failedErrors()).slice(0, 300));

  console.log('\n── 25. MASALARDA TOPLU İPTAL (btn-cancel-order) senaryosu ──');
  db().prepare('DELETE FROM sync_queue').run();
  // 4 masaya açık sipariş: gerçek kullanımda olduğu gibi masalar dolu
  const tblIds = [];
  for (let n = 10; n < 14; n++) {
    const r = await api('POST', 'table=tables', { restaurant_id: RID, number: n });
    const row = (Array.isArray(r.data) ? r.data : [r.data]).find(x => Number(x.number) === n);
    tblIds.push(row.id);
  }
  await sync.triggerSync({ reason: 'manual' }); await sleep(600);
  const openOrders = [];
  for (const tid of tblIds) {
    const r = await api('POST', 'table=orders', {
      restaurant_id: RID, table_id: tid,
      order_items: [{ product_id: siteProdId, product_name: 'Menü', quantity: 1, price: 55 }],
    });
    openOrders.push(r.data.id);
  }
  for (let i = 0; i < 5; i++) { await sync.triggerSync({ reason: 'manual' }); await sleep(400); }
  check('4 masa dolu ve siparişler site\'de',
    localCount('tables', "WHERE status='occupied'") >= 4 &&
    openOrders.every(id => {
      const m = db().prepare("SELECT remote_id FROM id_map WHERE entity_table='orders' AND local_id=?").get(id);
      return T('orders').get(m ? m.remote_id : id);
    }),
    `dolu masa=${localCount('tables', "WHERE status='occupied'")}`);

  // SİTEDEN topluca iptal et (btn-cancel-order = DELETE orders&id=..)
  for (const id of openOrders) {
    const m = db().prepare("SELECT remote_id FROM id_map WHERE entity_table='orders' AND local_id=?").get(id);
    const rk = m ? m.remote_id : id;
    await realFetch(`${REMOTE}/api/index.php?table=orders&id=${rk}`, {
      method: 'DELETE', headers: { Authorization: `Bearer test-token-abc` },
    });
  }
  await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(1200);
  const kalanOrd = openOrders.filter(id => localCount('orders', 'WHERE id=?', [id]) > 0).length;
  check('toplu iptal edilen siparişler local\'den gitti', kalanOrd === 0, `kalan: ${kalanOrd}/4`);
  const doluKalan = tblIds.filter(t => {
    const row = db().prepare('SELECT status FROM tables WHERE id=?').get(t);
    return row && row.status === 'occupied';
  }).length;
  check('masalar local\'de de boşaldı', doluKalan === 0, `hâlâ dolu: ${doluKalan}/4`);
  check('toplu iptalde hata yok', !queueStat().failed, JSON.stringify(failedErrors()).slice(0, 300));

  console.log('\n── 26. Kuyrukta TAKILI hata varken sitede silme ─────────────');
  db().prepare('DELETE FROM sync_queue').run();
  const stuckOrd = await api('POST', 'table=orders', {
    restaurant_id: RID, table_id: tableId,
    order_items: [{ product_id: siteProdId, product_name: 'Köfte', quantity: 1, price: 70 }],
  });
  const stuckId = stuckOrd.data.id;
  for (let i = 0; i < 4; i++) { await sync.triggerSync({ reason: 'manual' }); await sleep(400); }
  const mm = db().prepare("SELECT remote_id FROM id_map WHERE entity_table='orders' AND local_id=?").get(stuckId);
  const stuckRemote = mm ? mm.remote_id : stuckId;
  // Gerçek hayattaki durum: bu siparişe ait onarılamayan bir kayıt kuyrukta takılı
  db().prepare(`INSERT INTO sync_queue (idempotency_key, method, path, body, entity_table, entity_id, status, attempts, last_error)
                VALUES (?,?,?,?,?,?,'failed',99,'takılı kalmış eski hata')`)
    .run('stuck-' + Date.now(), 'PUT', `/api/index.php?table=orders&id=${stuckId}`,
         JSON.stringify({ note: 'x' }), 'orders', stuckId);
  // site'den sil
  T('orders').delete(stuckRemote);
  for (const [k, v] of T('order_items')) if (v.order_id === stuckRemote) T('order_items').delete(k);
  for (let i = 0; i < 4; i++) { await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(600); }
  check('takılı hata varken de sitede silinen sipariş gitti',
    localCount('orders', 'WHERE id=?', [stuckId]) === 0,
    `local hâlâ ${localCount('orders', 'WHERE id=?', [stuckId])} satır`);

  console.log('\n── 27. Sunucu listesi SINIRLI dönerse yanlış silme olmamalı ─');
  db().prepare('DELETE FROM sync_queue').run();
  const keepIds = [];
  for (let i = 0; i < 5; i++) {
    const r = await api('POST', 'table=orders', {
      restaurant_id: RID, table_id: tableId,
      order_items: [{ product_id: siteProdId, product_name: 'Çorba', quantity: 1, price: 30 }],
    });
    keepIds.push(r.data.id);
  }
  for (let i = 0; i < 6; i++) { await sync.triggerSync({ reason: 'manual' }); await sleep(400); }
  opts.listLimit = 2;   // sunucu listeyi kırpıyor — hepsi "yok" gibi görünüyor
  for (let i = 0; i < 3; i++) { await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(800); }
  const hayatta = keepIds.filter(id => localCount('orders', 'WHERE id=?', [id]) > 0).length;
  check('eksik liste yüzünden sipariş SİLİNMEDİ', hayatta === 5, `hayatta: ${hayatta}/5`);
  opts.listLimit = 0;

  console.log('\n── 28. SİTEDE oluşan sipariş, sitede silinince local\'den gitmeli ─');
  db().prepare('DELETE FROM sync_queue').run();
  // Sipariş SİTEDE oluşturuluyor (uygulama hiç göndermedi)
  const siteOrderId = 'site-order-' + Date.now();
  T('orders').set(siteOrderId, {
    id: siteOrderId, restaurant_id: RID, table_id: tableId, status: 'pending',
    total: 90, is_paid: 0, created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  });
  T('order_items').set('site-item-1', {
    id: 'site-item-1', order_id: siteOrderId, restaurant_id: RID,
    product_id: siteProdId, product_name: 'Izgara', quantity: 2, price: 45,
  });
  for (let i = 0; i < 3; i++) { await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(600); }
  check('sitede açılan sipariş uygulamaya indi', localCount('orders', 'WHERE id=?', [siteOrderId]) === 1);

  // sonra SİTEDE siliniyor (masalardan toplu iptal gibi)
  T('orders').delete(siteOrderId);
  for (const [k, v] of T('order_items')) if (v.order_id === siteOrderId) T('order_items').delete(k);
  for (let i = 0; i < 3; i++) { await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(700); }
  check('sitede silinince uygulamadan da gitti',
    localCount('orders', 'WHERE id=?', [siteOrderId]) === 0,
    `local hâlâ ${localCount('orders', 'WHERE id=?', [siteOrderId])} satır`);
  check('kalemleri de gitti', localCount('order_items', 'WHERE order_id=?', [siteOrderId]) === 0);

  console.log('\n── 29. Sitede siparişin TÜM kalemlerini birden silme ───────');
  db().prepare('DELETE FROM sync_queue').run();
  const boxOrd = await api('POST', 'table=orders', {
    restaurant_id: RID, table_id: tableId,
    order_items: [
      { product_id: siteProdId, product_name: 'A', quantity: 1, price: 10 },
      { product_id: siteProdId, product_name: 'B', quantity: 2, price: 20 },
      { product_id: siteProdId, product_name: 'C', quantity: 1, price: 30 },
    ],
  });
  const boxId = boxOrd.data.id;
  for (let i = 0; i < 5; i++) { await sync.triggerSync({ reason: 'manual' }); await sleep(400); }
  check('3 kalem local\'de', localCount('order_items', 'WHERE order_id=?', [boxId]) === 3);

  const bm2 = db().prepare("SELECT remote_id FROM id_map WHERE entity_table='orders' AND local_id=?").get(boxId);
  const boxRemote = bm2 ? bm2.remote_id : boxId;

  // ── ÖNCE TEK TEK sil (bu zaten çalışıyordu) ──
  const firstItem = [...T('order_items').values()].find(i => i.order_id === boxRemote);
  T('order_items').delete(firstItem.id);
  for (let i = 0; i < 3; i++) { await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(600); }
  check('tek kalem silme yansıdı', localCount('order_items', 'WHERE order_id=?', [boxId]) === 2,
    `local=${localCount('order_items', 'WHERE order_id=?', [boxId])}`);

  // ── ŞİMDİ KALANLARIN HEPSİNİ BİRDEN sil (kutudaki tüm ürünler) ──
  for (const [k, v] of T('order_items')) if (v.order_id === boxRemote) T('order_items').delete(k);
  for (let i = 0; i < 3; i++) { await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(700); }
  check('TÜM kalemler birden silinince de yansıdı',
    localCount('order_items', 'WHERE order_id=?', [boxId]) === 0,
    `local hâlâ ${localCount('order_items', 'WHERE order_id=?', [boxId])} kalem`);
  check('toplu kalem silmede hata yok', !queueStat().failed, JSON.stringify(failedErrors()).slice(0, 300));

  console.log('\n── 30. Sunucu \'bu id var mı\' sorusuna cevap vermezse bile silinmeli ─');
  db().prepare('DELETE FROM sync_queue').run();
  opts.brokenVerify = true;
  const bvOrd = await api('POST', 'table=orders', {
    restaurant_id: RID, table_id: tableId,
    order_items: [{ product_id: siteProdId, product_name: 'Sufle', quantity: 1, price: 25 }],
  });
  const bvId = bvOrd.data.id;
  for (let i = 0; i < 5; i++) { await sync.triggerSync({ reason: 'manual' }); await sleep(400); }
  const bvm = db().prepare("SELECT remote_id FROM id_map WHERE entity_table='orders' AND local_id=?").get(bvId);
  const bvRemote = bvm ? bvm.remote_id : bvId;
  check('sipariş site\'ye gitti (bozuk doğrulamaya rağmen)', !!T('orders').get(bvRemote));
  T('orders').delete(bvRemote);
  for (const [k, v] of T('order_items')) if (v.order_id === bvRemote) T('order_items').delete(k);
  for (let i = 0; i < 6; i++) { await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(700); }
  check('cevapsız doğrulamaya rağmen local\'den silindi',
    localCount('orders', 'WHERE id=?', [bvId]) === 0,
    `local hâlâ ${localCount('orders', 'WHERE id=?', [bvId])} satır`);
  const bvKeep = [];
  for (let i = 0; i < 3; i++) {
    const r = await api('POST', 'table=orders', {
      restaurant_id: RID, table_id: tableId,
      order_items: [{ product_id: siteProdId, product_name: 'Baklava', quantity: 1, price: 40 }],
    });
    bvKeep.push(r.data.id);
  }
  for (let i = 0; i < 6; i++) { await sync.triggerSync({ reason: 'manual' }); await sleep(400); }
  opts.listLimit = 1;
  await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(800);
  const bvAlive = bvKeep.filter(id => localCount('orders', 'WHERE id=?', [id]) > 0).length;
  check('tek turluk liste aksaklığında YANLIŞ silme yok', bvAlive === 3, `hayatta: ${bvAlive}/3`);
  opts.listLimit = 0; opts.brokenVerify = false;

  console.log('\n── 31. LOGO: sitedeki logo uygulamada görünmeli ─────────────');
  const logoPath = '/uploads/logos/menux-logo.png';
  uploadFiles.set(logoPath, Buffer.from('PNG-LOGO-BYTES'));
  opts.restaurantExtra = { logo: logoPath };  // sunucu 'logo' adıyla gönderiyor
  for (let i = 0; i < 3; i++) { await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(700); }
  const restRow = db().prepare('SELECT * FROM restaurants WHERE id=?').get(RID);
  check('logo alanı local\'e indi (logo → logo_url eşlemesi)',
    !!(restRow && restRow.logo_url), JSON.stringify(restRow && restRow.logo_url));
  const logoResp = await realFetch(`${LOCAL}${logoPath}`);
  check('logo uygulamadan servis ediliyor', logoResp.status === 200, `HTTP ${logoResp.status}`);
  const logoBuf = Buffer.from(await logoResp.arrayBuffer());
  check('logo içeriği doğru', logoBuf.toString() === 'PNG-LOGO-BYTES');

  // çevrimdışıyken de açılmalı (artık diskte)
  NET_DOWN = true;
  const offResp = await realFetch(`${LOCAL}${logoPath}`);
  check('logo çevrimdışıyken de açılıyor', offResp.status === 200, `HTTP ${offResp.status}`);
  NET_DOWN = false;

  // mutlak URL biçiminde gelen logo da inmeli
  const logo2 = '/uploads/logos/abs-logo.png';
  uploadFiles.set(logo2, Buffer.from('ABS-LOGO'));
  opts.restaurantExtra = { logo: `${REMOTE}${logo2}` };
  for (let i = 0; i < 3; i++) { await sync.triggerSync({ reason: 'remote:data_update' }); await sleep(700); }
  const abs = await realFetch(`${LOCAL}${logo2}`);
  check('mutlak URL\'li logo da indi', abs.status === 200, `HTTP ${abs.status}`);
  opts.restaurantExtra = null;

  console.log('\n── 32. Temiz kapanış: port serbest kalıyor mu ───────────────');
  sync.stopBackgroundSync();
  require('../server/events').closeAllStreams();
  await new Promise(r => localSrv.close(r));
  let reusable = false;
  try {
    const again = createApp().listen(LOCAL_PORT);
    await sleep(200); reusable = again.listening; again.close();
  } catch (e) {}
  check('port yeniden kullanılabiliyor', reusable);

  remoteSrv.close();
  console.log(`\n══ SONUÇ: ${pass} geçti, ${fail} kaldı ══`);
  if (fail) {
    console.log('\nBAŞARISIZ TESTLER:');
    for (const r of results) if (!r.ok) console.log(` • ${r.name}\n   ${r.detail}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('TEST ÇÖKTÜ:', e); process.exit(2); });
