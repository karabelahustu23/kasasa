// test/mock-remote.js — "Site" tarafını taklit eden sunucu.
// Gerçekçi olsun diye KATI davranır:
//  • PUT ile olmayan kayıt → 404
//  • POST ile var olan id → 409
//  • DELETE ile olmayan kayıt → 404
//  • Gövdede id varsa AYNI id ile kaydeder, yoksa kendi id'sini üretir
const express = require('express');
const crypto = require('crypto');

const RID = 'rest-1';
const TOKEN = 'test-token-abc';

const store = {}; // { table: Map(id -> row) }
// menux.ge gibi bazı sunucular alt satır id'lerini yok sayıp kendi id'sini üretir.
const uploadFiles = new Map();
const opts = { ignoreItemIds: false, ignoreOrderIds: false, dropResponses: 0, listLimit: 0, breakIdLookup: false };
const T = (t) => (store[t] = store[t] || new Map());
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

let sseClients = new Set();
function notify(event) {
  for (const res of sseClients) {
    try { res.write(`event: ${event}\ndata: {}\n\n`); } catch (e) {}
  }
}

function createRemote({ strictAuth = true, supportsRealtime = true } = {}) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(require('multer')({ storage: require('multer').memoryStorage() }).any());

  app.get(/^\/uploads\//, (req, res) => {
    const f = uploadFiles.get(req.path);
    if (!f) return res.status(404).end();
    res.set('Content-Type', 'image/png').send(f);
  });

  app.all('/api/index.php', (req, res) => {
    const table = req.query.table || '';
    const action = req.query.action || '';
    const id = req.query.id || '';
    const m = req.method;
    const body = req.body || {};

    if (table === 'auth' && action === 'login') {
      return res.json({ token: TOKEN, user: { id: 'u1', email: body.email, role: 'admin', restaurant_id: RID } });
    }
    const auth = (req.headers.authorization || '').replace('Bearer ', '');
    if (strictAuth && auth !== TOKEN) return res.status(401).json({ error: 'yetkisiz' });
    if (table === 'auth' && action === 'me') return res.json({ id: 'u1', restaurant_id: RID });
    if (table === 'events_ping') return res.json({ last_id: 1 });
    if (table === 'realtime') {
      if (!supportsRealtime) return res.status(404).end();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (table === 'upload') {
      const f = (req.files || [])[0];
      return res.json({ url: `/uploads/remote/${uuid()}.jpg`, size: f ? f.buffer.length : 0 });
    }
    if (table === 'restaurants') {
      const r = { id: RID, name: 'Test Restoran', email: 'rest@test.local', vat_enabled: 0, vat_rate: 0, ...(opts.restaurantExtra || {}) };
      return res.json(req.query.id || m === 'GET' && !req.query.list ? r : [r]);
    }

    const tbl = T(table);

    if (m === 'GET') {
      // Bazı gerçek sunucular "id ile tek kayıt sorgusu"nu desteklemez:
      // 400 döner ya da id'yi yok sayıp tüm listeyi verir.
      if (id && opts.breakIdLookup === '400') return res.status(400).json({ error: 'gecersiz istek' });
      if (id && opts.breakIdLookup === 'list') return res.json([...tbl.values()]);
      if (id) { const r = tbl.get(id); return r ? res.json(r) : res.status(404).json({ error: 'yok' }); }
      let rows = [...tbl.values()];
      if (table === 'orders') {
        const since = req.query.gte_created_at;
        if (since) rows = rows.filter(r => String(r.created_at || '') >= since);
        rows = rows.map(r => ({ ...r, order_items: [...T('order_items').values()].filter(i => i.order_id === r.id) }));
        // Gerçek sunucular listeyi sayfalayabilir/sınırlayabilir.
        if (opts.listLimit > 0) rows = rows.slice(0, opts.listLimit);
      }
      return res.json(rows);
    }

    if (m === 'POST') {
      // order_items: dizi de olabilir
      const list = Array.isArray(body) ? body : [body];
      const created = [];
      if (table === 'order_items' && opts.ignoreItemIds) {
        for (const raw of list) {
          const iid = uuid();
          tbl.set(iid, { ...raw, id: iid, restaurant_id: RID });
          created.push(tbl.get(iid));
        }
        notify('data_update');
        return res.status(201).json({ success: true });
      }
      for (const raw of list) {
        const row = { ...raw };
        if (table === 'orders') {
          const items = row.order_items || [];
          delete row.order_items;
          row.id = opts.ignoreOrderIds ? uuid() : (row.id || uuid());
          if (tbl.has(row.id)) return res.status(409).json({ error: 'duplicate id' });
          row.restaurant_id = row.restaurant_id || RID;
          row.created_at = row.created_at || now();
          tbl.set(row.id, row);
          for (const it of items) {
            const iid = opts.ignoreItemIds ? uuid() : (it.id || uuid());
            T('order_items').set(iid, { ...it, id: iid, order_id: row.id, restaurant_id: RID });
          }
          created.push({ ...row, order_items: [...T('order_items').values()].filter(i => i.order_id === row.id) });
          continue;
        }
        row.id = row.id || uuid();
        if (tbl.has(row.id)) return res.status(409).json({ error: 'duplicate id' });
        row.restaurant_id = row.restaurant_id || RID;
        row.created_at = row.created_at || now();
        tbl.set(row.id, row);
        created.push(row);
      }
      notify('data_update');
      if (opts.dropResponses > 0) { opts.dropResponses--; return req.socket.destroy(); }
      return res.status(201).json(created.length === 1 ? created[0] : created);
    }

    if (m === 'PUT') {
      const key = id || body.id;
      if (!key || !tbl.has(key)) return res.status(404).json({ error: 'kayit yok' });
      const row = { ...tbl.get(key), ...body, id: key };
      const items = row.order_items; delete row.order_items;
      tbl.set(key, row);
      if (table === 'orders' && Array.isArray(items)) {
        for (const it of items) {
          const iid = it.id || uuid();
          T('order_items').set(iid, { ...it, id: iid, order_id: key, restaurant_id: RID });
        }
      }
      notify('data_update');
      return res.json(row);
    }

    if (m === 'DELETE') {
      if (table === 'order_items' && !id && req.query.order_id) {
        for (const [k, v] of T('order_items')) if (v.order_id === req.query.order_id) T('order_items').delete(k);
        notify('data_update');
        return res.json({ success: true });
      }
      if (!id || !tbl.has(id)) return res.status(404).json({ error: 'kayit yok' });
      const row0 = tbl.get(id);
      tbl.delete(id);
      if (table === 'orders') {
        for (const [k, v] of T('order_items')) if (v.order_id === id) T('order_items').delete(k);
        // gerçek sunucu gibi: masada başka açık sipariş kalmadıysa masayı boşalt
        const tid = row0 && row0.table_id;
        if (tid) {
          const stillOpen = [...T('orders').values()].some(o => o.table_id === tid);
          const tRow = T('tables').get(tid);
          if (!stillOpen && tRow) tRow.status = 'empty';
        }
      }
      notify('data_update');
      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'method' });
  });

  return app;
}

module.exports = { createRemote, store, T, RID, TOKEN, notify, sseClients, opts, uploadFiles };
