// server/schema.js — Local SQLite şeması (schema.sql'in SQLite karşılığı)
// MySQL'deki UUID()/JSON/ENUM/ON UPDATE gibi özellikler SQLite'ta yok;
// bunlar uygulama katmanında (helpers.js) karşılanıyor.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS restaurants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  auth_user_id TEXT,
  logo_url TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  country TEXT DEFAULT 'TR',
  description TEXT,
  plan TEXT DEFAULT 'basic',
  is_active INTEGER DEFAULT 1,
  menu_number INTEGER,
  slug TEXT,
  primary_color TEXT DEFAULT '#d4af37',
  theme TEXT DEFAULT 'dark',
  total_orders INTEGER DEFAULT 0,
  total_revenue REAL DEFAULT 0,
  custom_menu_url TEXT,
  trial_ends_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'owner',
  restaurant_id TEXT,
  role_key TEXT,
  permissions TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  name TEXT,
  icon TEXT,
  image_url TEXT,
  sort_order INTEGER DEFAULT 0,
  translations TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  category_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  price REAL NOT NULL,
  image_url TEXT,
  is_available INTEGER DEFAULT 1,
  is_featured INTEGER DEFAULT 0,
  translations TEXT,
  stock INTEGER,
  hidden_from_menu INTEGER DEFAULT 0,
  vat_exempt INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  sort_order INTEGER DEFAULT 0,
  translations TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tables (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  number INTEGER NOT NULL,
  status TEXT DEFAULT 'empty',
  color TEXT DEFAULT '#1a1a2e',
  label TEXT,
  is_takeaway INTEGER DEFAULT 0,
  opened_at TEXT,
  zone TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  table_id TEXT,
  status TEXT DEFAULT 'pending',
  total REAL DEFAULT 0,
  note TEXT,
  is_paid INTEGER DEFAULT 0,
  ready_at TEXT,
  served_at TEXT,
  payment_method TEXT,
  discount_amount REAL DEFAULT 0,
  paid_at TEXT,
  bank_name TEXT,
  delivery_company TEXT,
  vat_amount REAL DEFAULT 0,
  employee_name TEXT,
  receipt_printed_at TEXT,
  voided_at TEXT,
  void_reason TEXT,
  replacement_order_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  order_id TEXT,
  product_id TEXT,
  product_name TEXT NOT NULL,
  variant_name TEXT,
  quantity INTEGER NOT NULL,
  price REAL NOT NULL,
  ingredient_cost REAL,
  is_ready INTEGER DEFAULT 0,
  sent_to_kitchen INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_refunds (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  amount REAL NOT NULL,
  reason TEXT,
  employee_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT UNIQUE,
  site_name TEXT DEFAULT 'Restoran',
  currency TEXT DEFAULT '₺',
  logo_url TEXT,
  vat_enabled INTEGER DEFAULT 0,
  vat_rate REAL DEFAULT 0,
  is_open INTEGER DEFAULT 1,
  is_day_closed INTEGER DEFAULT 0,
  last_closed_at TEXT,
  timezone TEXT DEFAULT 'Europe/Istanbul',
  stock_enabled INTEGER DEFAULT 0,
  recipe_stock_enabled INTEGER DEFAULT 0,
  pos_category_first_enabled INTEGER DEFAULT 0,
  pos_category_no_photo_enabled INTEGER DEFAULT 0,
  menu_category_first_enabled INTEGER DEFAULT 0,
  delete_pin TEXT,
  pin_enabled INTEGER DEFAULT 0,
  bog_payment_enabled INTEGER DEFAULT 0,
  bog_client_id TEXT,
  bog_client_secret TEXT,
  custom_roles TEXT,
  bank_names TEXT,
  delivery_companies TEXT,
  kitchen_stations TEXT,
  table_zones TEXT,
  kitchen_auto_print INTEGER DEFAULT 0,
  phone_order_auto_print INTEGER DEFAULT 0,
  pos_send_auto_print INTEGER DEFAULT 0,
  host_device_no_pin_delete INTEGER DEFAULT 0,
  day_close_report_print INTEGER DEFAULT 0,
  expenses_enabled INTEGER DEFAULT 0,
  printer_width_mm INTEGER DEFAULT 80,
  revenue_pin TEXT,
  phone_order_print_device_id TEXT,
  phone_order_print_device_name TEXT,
  host_device_enabled INTEGER DEFAULT 0,
  host_device_last_seen TEXT,
  kitchen_ticket_lang1 TEXT,
  kitchen_ticket_lang2 TEXT,
  receipt_ticket_lang1 TEXT,
  receipt_ticket_lang2 TEXT,
  default_break_minutes INTEGER DEFAULT 15,
  break_overtime_alert INTEGER DEFAULT 1,
  enabled_languages TEXT,
  az_translate_products INTEGER DEFAULT 0,
  schedule_enabled INTEGER DEFAULT 1,
  instagram_url TEXT,
  gmail TEXT,
  location_url TEXT,
  google_reviews_url TEXT,
  contact_phone TEXT,
  working_hours TEXT,
  working_days TEXT,
  location_lat REAL,
  location_lng REAL,
  admin_enabled_languages TEXT,
  default_admin_lang TEXT DEFAULT 'tr',
  openai_api_key TEXT,
  groq_api_key TEXT,
  gemini_api_key TEXT,
  ai_order_provider TEXT DEFAULT 'openai',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  description TEXT,
  employee_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_reports (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  report_date TEXT NOT NULL,
  total_revenue REAL DEFAULT 0,
  total_orders INTEGER DEFAULT 0,
  all_orders_count INTEGER DEFAULT 0,
  total_discount REAL DEFAULT 0,
  total_refunds REAL DEFAULT 0,
  net_revenue REAL DEFAULT 0,
  voided_orders_count INTEGER DEFAULT 0,
  total_expenses REAL DEFAULT 0,
  top_products TEXT,
  payment_breakdown TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id TEXT,
  table_number INTEGER,
  rating INTEGER,
  comment TEXT,
  is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  code TEXT NOT NULL,
  discount_type TEXT NOT NULL DEFAULT 'percent',
  discount_value REAL NOT NULL,
  min_order_amount REAL DEFAULT 0,
  start_date TEXT,
  end_date TEXT,
  max_usage INTEGER,
  usage_count INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  auto_apply INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS happy_hours (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  name TEXT NOT NULL,
  discount_type TEXT NOT NULL DEFAULT 'percent',
  discount_value REAL NOT NULL,
  min_order_amount REAL DEFAULT 0,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  days_of_week TEXT DEFAULT '0,1,2,3,4',
  scope TEXT DEFAULT 'all',
  category_id TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS carousel_slides (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  image_url TEXT,
  title TEXT,
  subtitle TEXT,
  height INTEGER DEFAULT 180,
  autoplay_interval INTEGER DEFAULT 4,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ingredients (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'gr',
  stock REAL DEFAULT 0,
  min_stock REAL DEFAULT 0,
  cost_per_unit REAL DEFAULT 0,
  category TEXT,
  supplier TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  ingredient_id TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(product_id, ingredient_id)
);

CREATE TABLE IF NOT EXISTS stock_logs (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  ingredient_id TEXT NOT NULL,
  order_id TEXT,
  change_type TEXT NOT NULL DEFAULT 'deduct',
  qty_before REAL NOT NULL,
  qty_change REAL NOT NULL,
  qty_after REAL NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product_stock_logs (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  order_id TEXT,
  change_type TEXT NOT NULL DEFAULT 'manual',
  qty_before INTEGER NOT NULL DEFAULT 0,
  qty_change INTEGER NOT NULL DEFAULT 0,
  qty_after INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ── OFFLINE SENKRON ────────────────────────────────────────────
-- Bu cihazda offline iken yapılan TÜM yazma istekleri, internet gelince
-- online sunucuya (aynı X-Idempotency-Key koruması ile) tekrar gönderilmek
-- üzere burada kuyruklanır.
CREATE TABLE IF NOT EXISTS sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT UNIQUE NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  body TEXT,
  is_form INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  synced_at TEXT
);

-- ID EŞLEME KATMANI
-- Local kayıtların id'si ile online sunucudaki karşılıklarının id'si her zaman
-- aynı olmayabilir (sunucu gönderdiğimiz id'yi yok sayıp kendi id'sini üretebilir).
-- Bu tablo ikisini birbirine bağlar: local id ASLA değişmez, dışarı giden her
-- istek gönderilirken uzak id'ye çevrilir, gelen her satır local id'ye çevrilir.
-- 404 / kopya kayıt / kaybolan durum bilgisi sorunlarının tamamı buradan çözülür.
CREATE TABLE IF NOT EXISTS id_map (
  entity_table TEXT NOT NULL,
  local_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (entity_table, local_id)
);
CREATE INDEX IF NOT EXISTS idx_idmap_remote ON id_map(entity_table, remote_id);

-- Bu cihazın kimlik/bağlantı bilgileri (ilk kurulumda doldurulur)
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Local gerçek zamanlı olay defteri (SSE / uzun-bekleyen yedek için)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_rid ON events(restaurant_id, id);

-- Offline'da kaydedilen dosyaların online sunucudaki karşılığı
-- (yükleme senkronize edilince local /uploads/... yolu remote URL ile eşlenir)
CREATE TABLE IF NOT EXISTS url_map (
  local_url TEXT PRIMARY KEY,
  remote_url TEXT,
  bucket TEXT,
  file_path TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_syncq_status ON sync_queue(status, id);

-- Personel/vardiya/mola/rezervasyon gibi henüz tam olarak local'e taşınmamış
-- modüller için genel amaçlı depo. Bu sayede routes.js bu tablolar için 501
-- döndürmek yerine en azından okuma/yazma yapabiliyor; yazmalar zaten
-- sync_queue üzerinden online sunucunun GERÇEK (tam işlenmiş) uç noktasına
-- gönderiliyor — buradaki depo sadece offline'dayken görünürlük sağlar.
CREATE TABLE IF NOT EXISTS aux_records (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  restaurant_id TEXT,
  data TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_aux_lookup ON aux_records(table_name, restaurant_id);
`;

// Var olan kurulumlarda (eski sürümden güncelleyenlerde) eksik sütunları ekler.
// SQLite'ta "ADD COLUMN IF NOT EXISTS" yok; PRAGMA ile kontrol ediyoruz.
const MIGRATIONS = {
  sync_queue: {
    next_attempt_at: `ALTER TABLE sync_queue ADD COLUMN next_attempt_at TEXT`,
    entity_table: `ALTER TABLE sync_queue ADD COLUMN entity_table TEXT`,
    entity_id: `ALTER TABLE sync_queue ADD COLUMN entity_id TEXT`,
    file_path: `ALTER TABLE sync_queue ADD COLUMN file_path TEXT`,
    local_url: `ALTER TABLE sync_queue ADD COLUMN local_url TEXT`,
  },
};

function migrate(db) {
  for (const [table, cols] of Object.entries(MIGRATIONS)) {
    let existing;
    try { existing = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name)); }
    catch (e) { continue; }
    if (!existing.size) continue;
    for (const [col, sql] of Object.entries(cols)) {
      if (existing.has(col)) continue;
      try { db.exec(sql); } catch (e) { console.warn(`migrate ${table}.${col}:`, e.message); }
    }
  }
}

function initSchema(db) {
  db.exec(SCHEMA);
  migrate(db);
}

module.exports = { initSchema };
