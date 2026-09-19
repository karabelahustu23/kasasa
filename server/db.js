// server/db.js — local SQLite bağlantısı
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { initSchema } = require('./schema');

let _db = null;

function getDataDir() {
  // Electron main process env'den gelir (userData); yoksa proje içi ./data
  const dir = process.env.EQEQE_DATA_DIR || path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getDB() {
  if (_db) return _db;
  const dbPath = path.join(getDataDir(), 'local.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

// Kapanışta WAL'ı birleştirip dosyayı temiz bırak (zorla kapatmada bozulmasın).
function closeDB() {
  if (!_db) return;
  try { _db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) {}
  try { _db.close(); } catch (e) {}
  _db = null;
}

module.exports = { getDB, getDataDir, closeDB };
