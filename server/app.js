// server/app.js — Local HTTP server: admin.html'i ve /api/index.php'yi
// tıpkı online sunucudaki gibi aynı adres şemasıyla sunar.
const express = require('express');
const path = require('path');
const { getDataDir } = require('./db');
const apiRoutes = require('./routes');
const { pendingCount, getStatus } = require('./sync');
const fs = require('fs');
const H = require('./helpers');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(express.json({ limit: '20mb' }));
  // ── GÖRSELLER ──
  // Önce local dosya. Dosya bu cihazda yoksa (logo başka bir cihazdan yüklenmiş
  // ya da hiç indirilmemiş olabilir) online sunucudan BİR KEZ indirilip diske
  // yazılır ve bundan sonra çevrimdışıyken de açılır. Logonun görünmemesinin
  // sebebi buydu: dosya local'de yoktu ve indirilmesi için bir yol yoktu.
  const uploadsDir = path.join(getDataDir(), 'uploads');
  const inflight = new Map();

  app.get(/^\/uploads\//, async (req, res, next) => {
    const rel = decodeURIComponent(req.path.replace(/^\/uploads\//, ''));
    if (rel.includes('..')) return res.status(400).end();
    const abs = path.join(uploadsDir, rel);
    if (fs.existsSync(abs)) return res.sendFile(abs);

    const base = H.cfgGet('server_url');
    if (!base) return next();
    const remote = base.replace(/\/$/, '') + '/uploads/' + rel;
    try {
      if (!inflight.has(remote)) {
        inflight.set(remote, (async () => {
          const token = H.cfgGet('auth_token');
          const r = await fetch(remote, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const buf = Buffer.from(await r.arrayBuffer());
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, buf);
          return true;
        })().finally(() => setTimeout(() => inflight.delete(remote), 1000)));
      }
      await inflight.get(remote);
      if (fs.existsSync(abs)) return res.sendFile(abs);
    } catch (e) { /* indirilemedi */ }
    return next();
  });
  app.use('/uploads', express.static(uploadsDir));
  app.use(apiRoutes);
  // Basit local durum uç noktası: kuyrukta bekleyen kayıt sayısı (admin.html'de
  // isteğe bağlı bir "X kayıt senkronize edilecek" göstergesi için kullanılabilir).
  app.get('/local-status', (req, res) => {
    const st = getStatus();
    res.json({ pending_sync: st.pending, ...st });
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
  return app;
}

module.exports = { createApp };
