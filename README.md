# Kasa (Electron, Offline-first)

## Kurulum
```
npm install
npm run start
```
İlk açılışta bir kurulum ekranı çıkar: sunucu adresi + email + şifre girip
"Bağlan ve İndir" dersin. Sadece o restorana ait veriler local SQLite'a
(`%AppData%/Kasa/eqeqe-data/local.db` — userData klasörü) iner. Sonraki
açılışlarda internet gerekmez, program local server + local DB ile çalışır.

## Offline yazma senkronu
Offline yapılan her POST/PUT/DELETE `sync_queue` tablosuna kuyruklanır.
İnternet gelince (main.js içindeki arka plan zamanlayıcı ~20sn'de bir)
`server/sync.js -> pushQueue()` bunları aynı `X-Idempotency-Key` ile online
sunucudaki `/api/index.php`'ye tekrar gönderir. Sunucu tarafı bu key'i zaten
`idempotency_keys` tablosuyla destekliyor (index.php/config.php içinde mevcut),
o yüzden çift kayıt oluşmaz.

## Kapsam (Faz 1 — bu paket)
Auth, restaurants, categories, products, product_variants, tables, orders,
order_items, order_refunds, ingredients, stock_logs, product_stock_logs,
recipes, settings, expenses, daily_reports, feedback, coupons, happy_hours,
carousel_slides, upload.

Henüz portlanmadı (online'da PHP tarafında çalışmaya devam eder, local'de
`table=...` isteği 501 döner): staff/employees, shifts, reservations,
loyalty_points, kiosk_state, break_requests, restaurant_stories,
table_chat, food_selfies, fun_settings, product_views, weekly_performance,
payment_bog, rfid.

## Build (kurulum dosyası üretmek için)
```
npm run dist
```
electron-builder ile win/mac/linux paketleri `dist_build/` altına çıkar
(ilgili platformda çalıştırılmalı).

## Notlar
- `better-sqlite3` native modül; Electron'un Node ABI'siyle uyuşmazsa
  `npx electron-rebuild` çalıştırman gerekebilir (internetli iken, bir kere).
- Vendor kütüphaneler (lucide, qrcodejs, jszip, jspdf) `public/vendor/`
  altında local — CDN'e bağımlılık yok, tamamen offline açılır.
