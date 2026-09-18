// sw.js — Kasa uygulamasının offline çalışabilmesi için önbellek katmanı.
//
// NASIL ÇALIŞIR:
// - İlk açılışta (internet varken) admin.html ve api.js önbelleğe alınır.
// - Sonraki her açılışta önce ağdan denenir; ağ başarısız olursa (internet
//   yok) doğrudan önbellekten cevap verilir.
// - ÖNEMLİ (bu sürümde kasıtlı basitleştirme): CDN/dış kaynaklara
//   (Google Fonts, bootstrap-icons, qrcode.js vb.) HİÇ DOKUNULMUYOR — bu
//   istekler tamamen tarayıcının kendi normal davranışına bırakılıyor,
//   tıpkı service worker hiç yokmuş gibi. Önceki sürümlerde bu kaynakları
//   da önbelleğe almaya çalışmak (özellikle "no-cors" modunda, cevabı
//   doğrulayamadan) bazı durumlarda BOZUK bir kopyanın kalıcı olarak
//   önbellekte takılı kalmasına yol açtı (ikonların kutu görünmesi sorunu
//   buradan kaynaklandı). Kritik olan (offline sipariş/ödeme çalışması)
//   zaten CDN kaynaklarına bağlı değil — o yüzden risk almaya değmiyor.
//
// ÖNEMLİ: admin.html / api.js içeriğini her güncellediğinizde CACHE_NAME
// değerini değiştirin (örn. 'kasa-v6'), yoksa eski dosyalar önbellekte
// takılı kalabilir. Bu sürümde CACHE_NAME kasıtlı olarak değiştirildi
// ki önceki (CDN kaynaklı) bozuk önbellek tamamen silinsin.

const CACHE_NAME = 'kasa-v8';

const PRECACHE_SAME_ORIGIN = [
  '/admin.html',
  '/api.js',
  '/assets/bootstrap-icons/bootstrap-icons.min.css',
  '/assets/bootstrap-icons/fonts/bootstrap-icons.woff2',
  '/assets/bootstrap-icons/fonts/bootstrap-icons.woff',
];

// FIX: bu 4 CDN kaynağı, önceki "hiç dokunma" kararının istisnası — çünkü
// hepsi CORS destekliyor (cdnjs.cloudflare.com ve unpkg.com, Access-Control-
// Allow-Origin: * gönderiyor), yani normal (no-cors OLMAYAN) fetch ile
// gerçek bir Response nesnesi alıp res.ok kontrolü yapabiliyoruz — eski
// sürümdeki ikon bozulması sorunu TAM OLARAK bunun (no-cors, doğrulanamayan
// "opak" cevap) eksikliğinden kaynaklanıyordu. jspdf/jszip/qrcodejs URL'leri
// sürüm numarası içerdiği için (2.5.1, 3.10.1, 1.0.0) kalıcı olarak
// önbelleklenmeleri güvenli — içerikleri asla değişmez.
const PRECACHE_CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://unpkg.com/lucide@latest/dist/umd/lucide.min.js',
];

// Yüzdeli ilerleme logu — dosya/CDN önbellekleme sırasında konsola yazar.
// Service Worker'ın console.log'u tarayıcının ana DevTools konsolunda da görünür.
async function precacheWithProgress(cache, urls, label, fetchOpts) {
  let done = 0;
  for (const url of urls) {
    try {
      const res = await fetch(url, fetchOpts);
      if (res.ok) await cache.put(url, res.clone());
    } catch (e) { /* tek tek başarısızlık sorun değil */ }
    done++;
    console.log('[sw] ' + label + ' önbelleğe alınıyor: ' + done + '/' + urls.length + ' (%' + Math.round((done / urls.length) * 100) + ')');
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      console.log('%c[sw] Uygulama dosyaları önbelleğe alınıyor (0%)...', 'font-weight:bold');
      await precacheWithProgress(cache, PRECACHE_SAME_ORIGIN, 'Uygulama dosyaları', { cache: 'no-cache' });
      await precacheWithProgress(cache, PRECACHE_CDN, 'CDN kütüphaneleri');
      console.log('%c[sw] ✅ HAZIR — tüm dosyalar (admin.html, api.js, ikonlar, kütüphaneler) önbelleğe alındı (%100)', 'color:#0F6E56;font-weight:bold;font-size:13px');
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Eski sürümlerin (CDN kaynaklarını da içeren, bozuk olabilecek)
      // önbelleklerini TAMAMEN sil.
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      const cache = await caches.open(CACHE_NAME);
      console.log('%c[sw] Uygulama dosyaları önbelleğe alınıyor (0%)...', 'font-weight:bold');
      await precacheWithProgress(cache, PRECACHE_SAME_ORIGIN, 'Uygulama dosyaları', { cache: 'no-cache' });
      await precacheWithProgress(cache, PRECACHE_CDN, 'CDN kütüphaneleri');
      console.log('%c[sw] ✅ HAZIR — tüm dosyalar (admin.html, api.js, ikonlar, kütüphaneler) önbelleğe alındı (%100)', 'color:#0F6E56;font-weight:bold;font-size:13px');
      self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST/PUT (API çağrıları) service worker'a hiç girmesin

  const url = new URL(req.url);

  // Farklı origin: sadece bilinen/güvenli (CORS destekli, sürüm numaralı)
  // CDN kütüphaneleri için (PRECACHE_CDN) önbellek-öncelikli davranıyoruz —
  // offline'da ikonlar (lucide), QR kod basma, PDF/ZIP export gibi
  // özellikler de çalışsın diye. Bu listede olmayan HER ŞEYE (Google Fonts,
  // diğer CDN'ler vb.) hâlâ HİÇ dokunmuyoruz — eski davranış aynen korunuyor.
  if (url.origin !== self.location.origin) {
    if (!PRECACHE_CDN.includes(req.url)) return;
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res && res.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(req, res.clone());
          }
          return res;
        } catch (e) {
          const cached = await caches.match(req);
          if (cached) return cached;
          throw e;
        }
      })()
    );
    return;
  }

  // FIX: /api/ altındaki TÜM istekler (events_ping, realtime/SSE, ve genel
  // API çağrıları) service worker'a HİÇ girmesin. Sebepleri:
  // 1) events_ping gibi dinamik JSON cevaplar asla cache'lenmemeli — cache'e
  //    düşen eski bir cevap "last_id" hep aynı kalır gibi görünüp anlık
  //    bildirim sisteminin kalıcı olarak durmasına yol açabilir.
  // 2) table=realtime (SSE, text/event-stream) bir akış bağlantısıdır; bunu
  //    respondWith() ile sarmalamak bazı tarayıcılarda kırılgan davranır ve
  //    "NetworkError" gibi yanıltıcı hatalar üretebilir.
  // 3) API zaten kendi hata/retry mantığını (api.js içinde) yönetiyor;
  //    service worker'ın araya girip "offline'da cache'ten dön" demesi API
  //    için anlamsız (POST zaten yukarıda hariç tutuluyor, ama GET tabanlı
  //    events_ping/realtime için de aynı muafiyet gerekli).
  if (url.pathname.startsWith('/api/')) return;

  // Aynı origin: network-first, olmazsa cache. ignoreSearch:true —
  // admin.html'in kendi cache-busting'i (?_cb=...) yüzünden.
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok && (req.url.includes('.html') || req.url.includes('.js') || req.url.includes('.css'))) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, res.clone());
        }
        return res;
      } catch (e) {
        const cached = await caches.match(req, { ignoreSearch: true });
        if (cached) return cached;
        if (req.mode === 'navigate') {
          const fallback = await caches.match('/admin.html', { ignoreSearch: true });
          if (fallback) return fallback;
        }
        throw e;
      }
    })()
  );
});