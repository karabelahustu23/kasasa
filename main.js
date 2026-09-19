// main.js — Electron ana süreç.
// İlk açılışta: online sunucudan giriş + o restorana ait veriyi indiren kurulum ekranı.
// Sonraki açılışlarda: tamamen local server + local SQLite ile, internetsiz.
const { app, BrowserWindow, ipcMain, net } = require('electron');
const path = require('path');
const http = require('http');

// ── TEK ÖRNEK KİLİDİ ────────────────────────────────────────────────
// İkinci bir kopya açılırsa portu kapmaya çalışmasın; mevcut pencereyi öne alsın.
// (Win + mac, ikisinde de çalışır.)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// Kullanıcıya özel, kalıcı veri klasörü (Electron userData) — local.db + uploads burada tutulur.
process.env.EQEQE_DATA_DIR = path.join(app.getPath('userData'), 'eqeqe-data');

const H = require('./server/helpers');
const E = require('./server/events');
const { closeDB } = require('./server/db');
const { createApp } = require('./server/app');
const { remoteLoginAndBootstrap, startBackgroundSync, stopBackgroundSync, triggerSync } = require('./server/sync');

const BASE_PORT = 17845;
const PORT_TRIES = 20;          // 17845..17864 arası ilk boş portu kullan

let mainWindow = null;
let httpServer = null;
let actualPort = BASE_PORT;
let connWatcher = null;
const sockets = new Set();      // açık TCP soketleri — kapanışta zorla yok edilir
let shuttingDown = false;

function isBootstrapped() {
  return !!H.cfgGet('restaurant_id');
}

// ── SUNUCUYU BAŞLAT (port çakışmasına dayanıklı) ────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    const expressApp = createApp();
    const server = http.createServer(expressApp);

    // Soketleri say: server.close() bunları beklemesin diye kapanışta yok edeceğiz.
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    // Ölü keep-alive bağlantıları sonsuza kadar asılı kalmasın.
    server.keepAliveTimeout = 5000;
    server.headersTimeout = 10000;

    let attempt = 0;
    const tryListen = () => {
      const port = BASE_PORT + attempt;
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < PORT_TRIES - 1) {
          attempt++;
          console.warn(`[server] port ${port} dolu, ${BASE_PORT + attempt} deneniyor`);
          setTimeout(tryListen, 80);
        } else {
          reject(err);
        }
      });
      // 127.0.0.1: yalnızca bu makine erişir (dışarıya açık değil)
      server.listen(port, '127.0.0.1', () => {
        actualPort = port;
        httpServer = server;
        console.log(`Local API+UI http://127.0.0.1:${port}`);
        resolve(port);
      });
    };
    tryListen();
  });
}

// ── HER DURUMDA TEMİZ KAPANIŞ ───────────────────────────────────────
// Pencere çarpı ile kapatılsa da, Görev Yöneticisi / Activity Monitor'dan
// zorla kapatılsa da, terminalden Ctrl+C yapılsa da buradan geçilir:
// SSE akışları sonlandırılır, soketler yok edilir, port serbest kalır.
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { stopBackgroundSync(); } catch (e) {}
  if (connWatcher) { clearInterval(connWatcher); connWatcher = null; }
  try { E.closeAllStreams(); } catch (e) {}   // açık SSE yanıtlarını kapat
  if (httpServer) {
    try { httpServer.close(); } catch (e) {}
    // Node 18.2+ : bekleyen tüm bağlantıları da kes
    try { httpServer.closeAllConnections && httpServer.closeAllConnections(); } catch (e) {}
    httpServer = null;
  }
  for (const s of Array.from(sockets)) { try { s.destroy(); } catch (e) {} }
  sockets.clear();
  try { closeDB(); } catch (e) {}
  console.log('[server] kapatıldı, port serbest');
}

function openMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.focus(); return; }
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-main.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${actualPort}/`);

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.on('did-fail-load', (e, errorCode, errorDescription, validatedURL) => {
    console.error('[did-fail-load]', errorCode, errorDescription, validatedURL);
  });
  mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    console.error('[render-process-gone]', details);
  });
  // DevTools artık yalnızca istenirse: DEBUG_DEVTOOLS=1 npm run start
  // (Ayrık DevTools penceresi açık kalırsa uygulama kapanmıyordu.)
  if (process.env.DEBUG_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ── SESSİZ YAZDIRMA: sistem yazıcıları ─────────────────────────
function registerPrintHandlers() {
  ipcMain.handle('kasaPrint:getPrinters', async (event) => {
    try {
      return await event.sender.getPrintersAsync();
    } catch (e) {
      console.error('getPrinters error', e);
      return [];
    }
  });

  ipcMain.handle('kasaPrint:print', async (event, { printer, html, widthMm }) => {
    const mm = Number(widthMm) === 58 ? 58 : 80;
    const doc = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <style>
        @page { size: ${mm}mm auto; margin: 0; }
        html, body { margin:0; padding:0; width:${mm}mm; font-family: -apple-system, Segoe UI, Roboto, sans-serif; }
      </style></head><body>${html}</body></html>`;

    const printWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    try {
      await printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(doc));
      const result = await new Promise((resolve) => {
        printWin.webContents.print(
          {
            silent: true,
            printBackground: true,
            deviceName: printer,
            margins: { marginType: 'none' },
            pageSize: { width: mm * 1000, height: 297000 },
          },
          (success, errorType) => resolve({ ok: success, error: success ? null : errorType })
        );
      });
      return result;
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    } finally {
      printWin.destroy();
    }
  });
}

function openSetupWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 620,
    autoHideMenuBar: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-setup.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'public', 'setup.html'));

  ipcMain.handle('setup:bootstrap', async (event, { serverUrl, email, password }) => {
    await remoteLoginAndBootstrap({
      serverUrl, email, password,
      onProgress: (msg) => event.sender.send('setup:progress', msg),
    });
    win.close();
    openMainWindow();
    startBackgroundSync();
    watchConnectivity();
  });
}

app.whenReady().then(async () => {
  registerPrintHandlers();
  try {
    await startServer();
  } catch (e) {
    console.error('[server] başlatılamadı:', e);
    app.quit();
    return;
  }

  if (isBootstrapped()) {
    openMainWindow();
    startBackgroundSync();
    watchConnectivity();
  } else {
    openSetupWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      isBootstrapped() ? openMainWindow() : openSetupWindow();
    }
  });
});

// İkinci kopya açılmaya çalışıldığında mevcut pencereyi öne getir.
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else if (isBootstrapped()) {
    openMainWindow();
  }
});

// İşletim sistemi "internet geldi" dediği anda beklemeden senkronize et.
function watchConnectivity() {
  if (connWatcher) return;
  let wasOnline = net.isOnline();
  connWatcher = setInterval(() => {
    const now = net.isOnline();
    if (now && !wasOnline) {
      console.log('[sync] ağ bağlantısı geri geldi — anında senkron tetiklendi');
      triggerSync({ reason: 'network-online' });
    }
    wasOnline = now;
  }, 2000);
  connWatcher.unref && connWatcher.unref(); // bu zamanlayıcı süreci ayakta tutmasın
}

// ── KAPANIŞ KANCALARI (win + mac + linux) ───────────────────────────
app.on('before-quit', shutdown);
app.on('will-quit', shutdown);
app.on('quit', shutdown);

// Pencere kapandığında macOS'ta da tamamen çık: kullanıcı uygulamayı
// kapattığında arkada server açık kalmasın.
app.on('window-all-closed', () => {
  shutdown();
  app.quit();
});

// Terminalden / OS'tan gelen sonlandırma sinyalleri
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, () => { shutdown(); app.quit(); process.exit(0); });
  } catch (e) {}
}
process.on('exit', shutdown);
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  shutdown();
  app.quit();
});
