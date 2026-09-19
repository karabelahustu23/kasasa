// ============================================================
// api.js — MySQL/PHP API istemcisi (Supabase SDK uyumlu)
// ============================================================
(function(global) {
  'use strict';

  const API  = '/api/index.php';
  const AUTH = '/api/index.php?table=auth&action=';

  // ── TOKEN ─────────────────────────────────────────────────
  const getToken = () => localStorage.getItem('qr_token');
  const setToken = t => t ? localStorage.setItem('qr_token', t) : localStorage.removeItem('qr_token');

  // ── HTTP ──────────────────────────────────────────────────
  async function req(method, url, body, isForm) {
    const opts = { method, headers: {} };
    const tok = getToken();
    if (tok) opts.headers['Authorization'] = 'Bearer ' + tok;
    if (body && !isForm) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    else if (isForm) opts.body = body;
    const res = await fetch(url, opts);
    const txt = await res.text();
    let data; try { data = JSON.parse(txt); } catch { data = { error: txt }; }
    return { data: res.ok ? data : null, error: res.ok ? null : (data?.error || 'Hata ' + res.status) };
  }

  function buildUrl(table, params, id) {
    let url = API + '?table=' + encodeURIComponent(table);
    if (id) url += '&id=' + encodeURIComponent(id);
    if (params) for (const [k,v] of Object.entries(params))
      if (v !== undefined && v !== null) url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(String(v));
    return url;
  }

  // ── AUTH ──────────────────────────────────────────────────
  const auth = {
    _s: null,
    _make(d) {
      if (!d?.user) return null;
      return { user: { id: d.user.id, email: d.user.email, role: d.user.role, restaurant_id: d.user.restaurant_id, permissions: d.user.permissions || null, role_key: d.user.role_key || null }, restaurant: d.restaurant || null, token: d.token || getToken() };
    },
    async signInWithPassword({ email, password }) {
      const { data, error } = await req('POST', AUTH + 'login', { email, password });
      if (data?.token) { setToken(data.token); auth._s = auth._make(data); return { data: { user: auth._s.user, session: auth._s, restaurant: data.restaurant }, error: null }; }
      return { data: null, error };
    },
    async signOut() { await req('POST', AUTH + 'logout'); setToken(null); auth._s = null; },
    async getSession() {
      if (auth._s) return { data: { session: auth._s } };
      if (!getToken()) return { data: { session: null } };
      try {
        const { data } = await req('GET', AUTH + 'me');
        if (data?.user) { auth._s = auth._make(data); return { data: { session: auth._s } }; }
        // API cevap verdi ama user yok — token geçersiz, sil
        setToken(null); return { data: { session: null } };
      } catch(e) {
        // Ağ hatası veya sunucu hatası — token'ı SILME, mevcut oturumu koru
        // Sayfayı yeniden açınca tekrar denenir
        const fakeSession = { user: { id: null, email: null, role: null, restaurant_id: null }, restaurant: null, token: getToken() };
        return { data: { session: fakeSession }, error: e };
      }
    }
  };

  // ── QUERY BUILDER ─────────────────────────────────────────
  class Q {
    constructor(table, method, body) {
      this._t = table; this._m = method || 'GET'; this._b = body || null;
      this._p = {}; this._id = null; this._orders = [];
      this._lim = null; this._one = false; this._maybe = false;
    }
    eq(f, v)        { this._p[f] = v; return this; }
    neq(f, v)       { this._p['neq_'+f] = v; return this; }
    in(f, arr)      { this._p[f] = arr.join(','); return this; }
    or(cond)        { this._p['_or'] = cond; return this; }
    select(c)       { if (c && c !== '*') this._p['_select'] = c; return this; }
    order(f, o)     { this._orders.push({ f, asc: o?.ascending !== false }); return this; }
    limit(n)        { this._lim = n; return this; }
    single()        { this._one = true; return this; }
    maybeSingle()   { this._maybe = true; return this; }
    gte(f,v)        { this._p['gte_'+f]=v; return this; }
    lte(f,v)        { this._p['lte_'+f]=v; return this; }
    gt(f,v)         { this._p['gt_'+f]=v; return this; }
    lt(f,v)         { this._p['lt_'+f]=v; return this; }
    is(f,v)         { this._p['is_'+f]=v===null?'null':v; return this; }
    not(f,op,v)     { this._p['not_'+f]=op+'_'+v; return this; }

    async _run() {
      // PUT/DELETE için eq('id') → URL id parametresine taşı
      let id = this._id;
      const p = { ...this._p };
      if ((this._m === 'PUT' || this._m === 'DELETE') && p['id']) {
        id = p['id']; delete p['id'];
      }
      let url = buildUrl(this._t, p, id);
      if (this._lim) url += '&_limit=' + this._lim;
      if (this._orders.length) url += '&_order_by=' + this._orders[0].f + '&_order_dir=' + (this._orders[0].asc ? 'asc' : 'desc');
      const { data, error } = await req(this._m, url, this._b);
      if (this._one || this._maybe) {
        if (Array.isArray(data)) return { data: data[0] || null, error };
        return { data, error };
      }
      return { data, error };
    }
    then(res, rej) { return this._run().then(res, rej); }
  }

  // ── FROM ──────────────────────────────────────────────────
  function from(table) {
    return {
      select(cols) {
        const q = new Q(table, 'GET');
        if (cols && cols !== '*') q._p['_select'] = cols;
        return q;
      },
      insert(rows) {
        // Tek obje veya dizi — dizi ise rows[] olarak gönder
        const isArr = Array.isArray(rows);
        const payload = isArr && rows.length === 1 ? rows[0] : (isArr ? { rows } : rows);
        const q = new Q(table, 'POST', payload);
        q._run = async function() {
          const url = buildUrl(table, {});
          const { data, error } = await req('POST', url, payload);
          if (this._one || this._maybe) return { data: Array.isArray(data) ? (data[0]||null) : data, error };
          return { data, error };
        };
        return q;
      },
      update(fields) {
        const q = new Q(table, 'PUT', fields);
        q._run = async function() {
          let id = null;
          const p = { ...this._p };
          if (p['id']) { id = p['id']; delete p['id']; }
          const url = buildUrl(table, p, id);
          return req('PUT', url, fields);
        };
        return q;
      },
      delete() {
        const q = new Q(table, 'DELETE');
        q._run = async function() {
          let id = null;
          const p = { ...this._p };
          // 'id' varsa URL id parametresine taşı, diğerleri query string'de kalır
          if (p['id']) { id = p['id']; delete p['id']; }
          const url = buildUrl(table, p, id);
          return req('DELETE', url, null);
        };
        return q;
      },
      upsert(rows) {
        const payload = { ...(Array.isArray(rows) ? rows[0] : rows), _upsert: true };
        const q = new Q(table, 'POST', payload);
        q._run = async function() {
          return req('POST', buildUrl(table, {}), payload);
        };
        return q;
      }
    };
  }

  // ── STORAGE ───────────────────────────────────────────────
  const storage = {
    from(bucket) {
      return {
        async upload(path, file, opts) {
          const fd = new FormData();
          fd.append('file', file);
          const url = API + '?table=upload&bucket=' + encodeURIComponent(bucket);
          const { data, error } = await req('POST', url, fd, true);
          // data.url = tam public URL döner (örn: /uploads/products/xxx.jpg)
          return { data: data ? { path: data.url, publicUrl: data.url } : null, error };
        },
        getPublicUrl(pathOrUrl) {
          if (!pathOrUrl) return { data: { publicUrl: '' } };
          // Zaten tam URL ise direkt döndür
          if (pathOrUrl.startsWith('http') || pathOrUrl.startsWith('/')) {
            return { data: { publicUrl: pathOrUrl } };
          }
          return { data: { publicUrl: '/uploads/' + bucket + '/' + pathOrUrl } };
        },
        async remove(paths) {
          return req('DELETE', API + '?table=upload&bucket=' + bucket, { paths });
        }
      };
    }
  };

  // ── REALTIME (SSE + otomatik hafif yedek mod) ─────────────
  // Öncelik SSE (anlık push). Bazı paylaşımlı hosting'ler SSE akışını
  // sessizce buffer'layıp hiç veri geçirmeyebilir — bu durumda bağlantı
  // "açık" görünür ama olay/ping asla gelmez, yani normal onerror da
  // tetiklenmez. Bunu yakalamak için bir "watchdog" süresi kullanıyoruz:
  // belirli bir süre hiçbir canlılık sinyali (ping ya da olay) gelmezse,
  // SSE bu hosting'te çalışmıyor kabul edilip KALICI olarak çok hafif bir
  // yedek moda (events_ping ile 4sn'de bir tek sayı kontrolü) geçilir.
  // Böylece sistem hangi hosting'de olursa olsun ya en iyi haliyle (SSE)
  // ya da hafifçe gecikmeli ama garanti çalışan yedek moda düşerek işler —
  // hiçbir zaman kırılmaz, hiçbir zaman sunucuya ağır istek atmaz.
  function channel(name) {
    return {
      _name: name, _h: {}, _sse: null, _mode: null, _destroyed: false,
      _retryTimer: null, _watchdogTimer: null, _fallbackTimer: null, _fallbackAbortCtl: null,
      on(ev, filter, cb) {
        const tbl = filter.table || 'all';
        (this._h[tbl] = this._h[tbl] || []).push({ ev: filter.event || '*', cb });
        return this;
      },
      subscribe(onStatus) {
        const m = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        const rid = m ? m[0] : null;
        if (!rid) { onStatus?.('SUBSCRIBED'); return this; }
        const self = this;
        let last = 0;
        let retryDelay = 3000; // SSE reconnect başlangıç gecikmesi
        let sseEverWorked = false;
        let sseFailCount = 0;
        const SSE_WATCHDOG_MS = 12000; // bu sürede canlılık sinyali gelmezse buffer'lanmış say
        const SSE_MAX_FAILS = 3;       // hiç çalışmadan bu kadar hata alırsa kalıcı yedeğe geç

        const dispatchGeneric = () => {
          // Yedek modda hangi olay tipi olduğunu bilmiyoruz — kayıtlı tüm
          // handler'ları "bir şeyler değişti, yenile" tetiklemesiyle çağırıyoruz.
          Object.values(self._h).forEach(list => list.forEach(h => { try { h.cb({ new: {} }); } catch(e){} }));
        };

        const startFallback = () => {
          if (self._destroyed || self._mode === 'fallback') return;
          self._mode = 'fallback';
          console.log('%c[realtime] yedek moda geçildi (SSE bu hosting\'te çalışmıyor) — uzun-bekleyen istekle neredeyse anlık', 'color:#c98500');
          if (self._retryTimer) clearTimeout(self._retryTimer);
          if (self._watchdogTimer) clearTimeout(self._watchdogTimer);
          if (self._sse) { try { self._sse.close(); } catch(e){} self._sse = null; }
          onStatus?.('SUBSCRIBED'); // kullanıcı için görünürde bir fark yok, sistem çalışıyor
          let knownLastId = null;
          let fallbackFailStreak = 0;
          const tick = async () => {
            if (self._destroyed || self._mode !== 'fallback') return;
            try {
              const token = localStorage.getItem('qr_token') || '';
              const sinceParam = knownLastId === null ? 0 : knownLastId;
              const ctl = new AbortController();
              self._fallbackAbortCtl = ctl;
              // FIX: 4sn'de bir kısa soru yerine, sunucunun değişiklik olana (ya da
              // ~20sn zaman aşımına) kadar bekletip TEK seferde cevap döndüğü
              // events_wait'e bağlanıyoruz. SSE'nin aksine tek bir final cevap
              // olduğu için çıktıyı buffer'layan hosting'lerde de sorunsuz çalışır.
              const res = await fetch(API + '?table=events_wait&restaurant_id=' + encodeURIComponent(rid) + '&since_id=' + sinceParam, { headers: token ? { 'Authorization': 'Bearer ' + token } : {}, signal: ctl.signal });
              const data = await res.json();
              fallbackFailStreak = 0;
              const curId = data?.last_id ?? null;
              if (knownLastId === null) {
                knownLastId = curId; // ilk çağrıda sadece referans noktasını al
              } else if (curId !== null && curId !== knownLastId && !data?.timed_out) {
                knownLastId = curId;
                console.log('%c[realtime] (yedek mod) değişiklik tespit edildi — anında yenileniyor', 'color:#185FA5');
                dispatchGeneric();
              }
              // timed_out veya overloaded ise: değişiklik yok / sunucu şu an fazla
              // yüklü, hemen tekrar dener (overloaded'da sunucu zaten beklemeden
              // dönmüştür, art arda istek fırtınası olmasın diye kısa bir ara verilir)
              if (self._mode === 'fallback' && !self._destroyed) {
                self._fallbackTimer = setTimeout(tick, data?.overloaded ? 3000 : 0);
              }
            } catch(e) {
              // Ağ hatası: art arda çok sık denemeyip artan bir bekleme uygula
              fallbackFailStreak++;
              const backoff = Math.min(2000 * fallbackFailStreak, 15000);
              if (self._mode === 'fallback' && !self._destroyed) self._fallbackTimer = setTimeout(tick, backoff);
            }
          };
          tick();
        };

        const connect = () => {
          if (self._destroyed || self._mode === 'fallback') return;
          const sse = new EventSource(API + '?table=realtime&restaurant_id=' + rid + '&last_id=' + last);
          self._sse = sse;
          self._mode = 'sse';

          const map   = { new_order:'orders', order_update:'orders', order_deleted:'orders', order_voided:'orders', order_refunded:'orders', table_update:'tables', break_request:'breaks', break_approved:'breaks', break_rejected:'breaks', break_cover_start:'breaks', break_cover_end:'breaks', break_cover_assigned:'breaks', active_status_update:'active_status', rfid_scan:'rfid' };
          const evMap = { new_order:'INSERT',  order_update:'UPDATE',  order_deleted:'DELETE', order_voided:'UPDATE', order_refunded:'UPDATE', table_update:'UPDATE', break_request:'INSERT', break_approved:'UPDATE', break_rejected:'UPDATE', break_cover_start:'UPDATE', break_cover_end:'UPDATE', break_cover_assigned:'UPDATE', active_status_update:'UPDATE', rfid_scan:'INSERT' };

          const markAlive = () => {
            if (!sseEverWorked) console.log('%c[realtime] SSE çalışıyor — anlık push aktif', 'color:#1D9E75');
            sseEverWorked = true;
            sseFailCount = 0;
            retryDelay = 3000;
            if (self._watchdogTimer) clearTimeout(self._watchdogTimer);
            // Her canlılık sinyalinden sonra watchdog'u sıfırlayıp yeniden kuruyoruz —
            // bir sonraki sinyal bu süre içinde gelmezse hosting'in akışı buffer'ladığını
            // varsayıp sessizce (kullanıcı hiçbir şey fark etmeden) yedek moda geçiyoruz.
            self._watchdogTimer = setTimeout(() => { sse.close(); startFallback(); }, SSE_WATCHDOG_MS);
          };

          // FIX: bağlantı kurulur kurulmaz (onopen'ı BEKLEMEDEN) watchdog'u başlatıyoruz.
          // Bazı hosting'ler HTTP header'larını bile hiç göndermeden bağlantıyı buffer'lar —
          // bu durumda onopen ASLA tetiklenmez (ne başarı ne hata sinyali gelir, browser
          // sonsuza kadar "connecting" durumunda bekler). Watchdog'u onopen'a bağlı
          // başlatırsak bu senaryoda hiç devreye giremez. Bağlantı anında başlatınca,
          // headers hiç gelmese bile SSE_WATCHDOG_MS sonunda otomatik yedeğe düşüyoruz.
          self._watchdogTimer = setTimeout(() => { sse.close(); startFallback(); }, SSE_WATCHDOG_MS);

          sse.addEventListener('ping', markAlive);
          for (const ev of Object.keys(map)) {
            sse.addEventListener(ev, e => {
              try {
                last = parseInt(e.lastEventId) || last;
                markAlive();
                console.log('%c[realtime] olay geldi: ' + ev, 'color:#185FA5');
                const d = JSON.parse(e.data);
                const tbl = map[ev]; const supaEv = evMap[ev];
                (self._h[tbl] || []).forEach(h => {
                  if (h.ev === '*' || h.ev === supaEv) h.cb(supaEv === 'DELETE' ? { old: d.payload||d } : { new: d.payload||d });
                });
              } catch(err) {}
            });
          }

          // FIX (local/offline sürüm): menü, ayarlar, stok gibi tablolarda yapılan
          // değişiklikler için sunucu genel bir 'data_update' olayı yayınlıyor.
          // Belirli bir tabloya bağlı olmadığı için kayıtlı TÜM handler'ları
          // "yenile" tetiklemesiyle çağırıyoruz — aynı fallback modundaki gibi.
          sse.addEventListener('data_update', e => {
            try { last = parseInt(e.lastEventId) || last; } catch(err) {}
            markAlive();
            dispatchGeneric();
          });

          // Senkron durumu (çevrimiçi/çevrimdışı, bekleyen kayıt sayısı) —
          // arayüzdeki gösterge bunu dinliyor.
          sse.addEventListener('sync_status', e => {
            markAlive();
            try {
              const d = JSON.parse(e.data);
              window.dispatchEvent(new CustomEvent('kasa:sync-status', { detail: d.payload || d }));
            } catch(err) {}
          });

          sse.onopen = () => {
            onStatus?.('SUBSCRIBED');
            // Headers geldi — bağlantı en azından kuruldu. Yine de ilk 'ping' bu
            // noktadan sonra da gecikebilir/buffer'lanabilir diye watchdog'u burada
            // TEKRAR kurmuyoruz, yukarıda bağlantı anında kurulan watchdog zaten geçerli.
          };

          sse.onerror = () => {
            sse.close();
            if (self._destroyed || self._mode === 'fallback') return;
            sseFailCount++;
            if (!sseEverWorked && sseFailCount >= SSE_MAX_FAILS) {
              // SSE bu hosting'te hiçbir zaman çalışmadı (birkaç denemede tek bir
              // canlılık sinyali bile alınamadı) — kalıcı olarak hafif yedek moda geç.
              startFallback();
              return;
            }
            if (self._watchdogTimer) clearTimeout(self._watchdogTimer);
            self._retryTimer = setTimeout(connect, retryDelay);
            retryDelay = Math.min(retryDelay * 1.5, 30000);
          };
        };

        connect();
        return this;
      },
      unsubscribe() {
        // FIX: eski koddaki closure hatası düzeltildi — durum artık `self` (this)
        // üzerinde tutuluyor, böylece unsubscribe() gerçekten her şeyi durdurabiliyor
        // (eski haliyle destroyed/retryTimer değişkenlerine hiç erişemiyordu,
        // sekme kapanınca bağlantılar arka planda "zombi" halde kalabiliyordu).
        this._destroyed = true;
        this._mode = null;
        if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
        if (this._watchdogTimer) { clearTimeout(this._watchdogTimer); this._watchdogTimer = null; }
        if (this._fallbackTimer) { clearTimeout(this._fallbackTimer); this._fallbackTimer = null; }
        if (this._fallbackAbortCtl) { try { this._fallbackAbortCtl.abort(); } catch(e){} this._fallbackAbortCtl = null; }
        if (this._sse) { try { this._sse.close(); } catch(e){} this._sse = null; }
      }
    };
  }

  function removeChannel(ch) { ch?.unsubscribe?.(); }

  const sb = { auth, from, storage, channel, removeChannel };
  global.createMySQLClient = () => sb;
  global._mysqlApiClient = sb;

  // ============================================================
  // OFFLINE MODÜLÜ
  // ============================================================
  // Amaç: (1) sunucu tamamen çökse/522 verse bile personel sipariş almaya,
  // masa değiştirmeye, ödeme işaretlemeye DEVAM edebilsin (istek kuyruğa
  // alınır, bağlantı dönünce otomatik gönderilir — kopya oluşmaz çünkü
  // backend'de zaten hazır olan X-Idempotency-Key sistemini kullanıyoruz).
  // (2) Panel sabah hiç internet yokken açılsa bile son bilinen menü/masa/
  // ayar verisiyle (IndexedDB'deki anlık görüntüden) çalışabilsin.
  // Tamamen admin.html'e dokunmadan, window.fetch'i şeffaf şekilde
  // sarmalayarak yapılıyor — mevcut kod (sb.from(...) ya da doğrudan
  // fetch(...)) hiçbir değişiklik gerektirmeden bundan faydalanıyor.
  (function offlineModule() {
    const DB_NAME = 'menux_offline';
    const DB_VERSION = 1;
    const GATEWAY_ERROR_CODES = new Set([502,503,504,508,511,520,521,522,523,524,525,526,527,530]);
    // Sipariş akışıyla ilgili GET'ler: cevap her başarılı istekte IndexedDB'ye
    // anlık görüntü olarak kaydedilir, bağlantı yokken oradan servis edilir.
    const SNAPSHOT_TABLES = ['products','categories','product_variants','tables','settings','employees','ingredients','auth','orders','order_items','active_employees','break_requests'];

    function openDB() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'localId' });
          if (!db.objectStoreNames.contains('snapshot')) db.createObjectStore('snapshot', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    async function idbPut(store, val) {
      try {
        const db = await openDB();
        return await new Promise((res, rej) => {
          const tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).put(val);
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        });
      } catch (e) { console.error('[offline] idbPut hatası (' + store + '):', e); }
    }
    async function idbDelete(store, key) {
      try {
        const db = await openDB();
        return await new Promise((res, rej) => {
          const tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).delete(key);
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        });
      } catch (e) {}
    }
    async function idbGetAll(store) {
      try {
        const db = await openDB();
        return await new Promise((res, rej) => {
          const tx = db.transaction(store, 'readonly');
          const r = tx.objectStore(store).getAll();
          r.onsuccess = () => res(r.result || []);
          r.onerror = () => rej(r.error);
        });
      } catch (e) { return []; }
    }
    async function idbGet(store, key) {
      try {
        const db = await openDB();
        return await new Promise((res, rej) => {
          const tx = db.transaction(store, 'readonly');
          const r = tx.objectStore(store).get(key);
          r.onsuccess = () => res(r.result || null);
          r.onerror = () => rej(r.error);
        });
      } catch (e) { return null; }
    }

    function uuid4() {
      if (crypto?.randomUUID) return crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }

    function parseApiUrl(url) {
      try {
        const u = new URL(url, location.origin);
        if (u.pathname !== '/api/index.php') return null;
        return { table: u.searchParams.get('table'), id: u.searchParams.get('id'), url: u };
      } catch (e) { return null; }
    }

    // ── Durum bildirimi: kayıtlı işlem sayısı değişince tetiklenir ────────
    let pendingCount = 0;
    function notifyPending(n) { pendingCount = n; renderBanner(); window.dispatchEvent(new CustomEvent('offline-queue-changed', { detail: { count: n } })); }
    async function refreshPendingCount() { const all = await idbGetAll('outbox'); notifyPending(all.length); }

    // ── Üst durum banner'ı KALDIRILDI ──
    // Bağlantı durumu artık yalnızca sağ alttaki yuvarlak göstergeden okunuyor
    // (renk = durum, tıklayınca ayrıntı paneli açılıyor). Ekranın üstünü kaplayan
    // uyarı şeridi gereksizdi ve arayüzü aşağı itiyordu.
    function renderBanner() {
      const el = document.getElementById('_offlineStatusBanner');
      if (el) el.remove(); // eski sürümden kalan varsa temizle
    }
    window.addEventListener('online', renderBanner);
    window.addEventListener('offline', renderBanner);
    if (document.readyState !== 'loading') renderBanner(); else document.addEventListener('DOMContentLoaded', renderBanner);

    // ── GET anlık görüntü: bağlantı yokken (soğuk başlangıç dahil) son bilinen veriyi döndürür ──
    // Anahtar tam URL değil, table + restaurant_id + (zamanla değişmeyen)
    // filtreler üzerinden normalize ediliyor. Sebep: aynı tabloya (örn.
    // 'orders') zaman zaman değişen bir "gt_created_at=..." gibi filtreyle
    // sorgu atılıyor — tam URL'ye göre anahtarlarsak her seferinde farklı
    // bir kayıt oluşur ve önbellek pratikte hiç tutmaz. Bunun yerine tabloya
    // ait EN GÜNCEL tam veriyi tek bir anahtar altında saklıyoruz.
    const VOLATILE_PARAMS = ['gt_created_at', 'since_id', 'since', 'last_id', '_cb', 't', '_order_by', '_order_dir', '_limit'];
    function cacheKeyFor(info, urlObj) {
      const parts = [info.table];
      const keys = [...urlObj.searchParams.keys()].filter(k => k !== 'table' && !VOLATILE_PARAMS.includes(k)).sort();
      for (const k of keys) parts.push(k + '=' + urlObj.searchParams.get(k));
      return parts.join('&');
    }
    async function snapshotGet(key) {
      const row = await idbGet('snapshot', key);
      return row ? row.value : null;
    }
    async function snapshotSet(key, bodyText) {
      await idbPut('snapshot', { key, value: bodyText, ts: Date.now() });
    }

    // ── Proaktif ısıtma: sadece kullanıcı bir ekranı açtığında değil,
    // arka planda DÜZENLİ olarak tüm kritik verileri önceden çekip
    // IndexedDB'de hazır tutar. Böylece hiç ziyaret edilmemiş bir sayfa
    // (örn. o gün hiç "Malzemeler" açılmamışsa) bile offline'a düşüldüğünde
    // güncele yakın veriyle çalışabilir — sadece "daha önce görülen" veriye
    // bağımlı kalınmaz.
    function warmupUrls() {
      // FIX: admin.html'de bu değişken `let currentRestaurantId` ile tanımlı —
      // `let` ile tanımlanan üst düzey değişkenler window nesnesine EKLENMEZ
      // (var'dan farklı olarak). Bu yüzden `window.currentRestaurantId` her
      // zaman undefined dönüyordu ve ısıtma sessizce hiç çalışmıyordu. Doğrusu:
      // aynı sayfadaki <script> etiketleri ortak bir üst düzey scope paylaşır,
      // bu yüzden değişkeni İSİMLE (window'suz) okumak çalışır. index_customer.html
      // (müşteri QR menü) sayfasında ise bu değişken `RID` adıyla var — o da
      // kontrol ediliyor. Hiçbiri tanımlı değilse (örn. henüz giriş yapılmadıysa)
      // typeof kontrolü sayesinde hata fırlatmadan sessizce atlanır.
      let rid = null;
      try { if (typeof currentRestaurantId !== 'undefined' && currentRestaurantId) rid = currentRestaurantId; } catch (e) {}
      if (!rid) { try { if (typeof RID !== 'undefined' && RID) rid = RID; } catch (e) {} }
      if (!rid) return [];
      const r = encodeURIComponent(rid);
      return [
        '/api/index.php?table=products&restaurant_id=' + r,
        '/api/index.php?table=categories&restaurant_id=' + r,
        '/api/index.php?table=product_variants&restaurant_id=' + r,
        '/api/index.php?table=tables&restaurant_id=' + r,
        '/api/index.php?table=settings&restaurant_id=' + r,
        '/api/index.php?table=employees&restaurant_id=' + r,
        '/api/index.php?table=ingredients&restaurant_id=' + r,
        '/api/index.php?table=orders&restaurant_id=' + r + '&status=pending,preparing,ready,served&_select=' + encodeURIComponent('*, order_items(*)'),
        '/api/index.php?table=active_employees&restaurant_id=' + r,
        '/api/index.php?table=break_requests&restaurant_id=' + r + '&status=pending',
      ];
    }
    let _firstWarmupDone = false;
    async function warmupSnapshots() {
      if (!navigator.onLine) return;
      const urls = warmupUrls();
      if (!urls.length) return; // henüz giriş yapılmamış / restoran bilinmiyor
      const isFirstRun = !_firstWarmupDone;
      if (isFirstRun) console.log('%c[offline] Offline veri önbelleklemesi başlıyor (0%)...', 'color:#185FA5;font-weight:bold');
      let done = 0;
      for (const u of urls) {
        try {
          const token = localStorage.getItem('qr_token') || '';
          await fetch(u, token ? { headers: { 'Authorization': 'Bearer ' + token } } : undefined);
        } catch (e) { /* tek tek başarısızlık sorun değil, bir sonraki turda tekrar denenir */ }
        done++;
        if (isFirstRun) {
          const pct = Math.round((done / urls.length) * 100);
          console.log('%c[offline] Önbelleğe alınıyor: ' + done + '/' + urls.length + ' (%' + pct + ')', 'color:#185FA5');
        }
      }
      if (isFirstRun) {
        _firstWarmupDone = true;
        console.log('%c[offline] ✅ HAZIR — tüm kritik veriler önbelleğe alındı (%100). Sunucu çökse/internet gitse bile panel çalışmaya devam eder.', 'color:#0F6E56;font-weight:bold;font-size:13px');
      }
    }
    setTimeout(warmupSnapshots, 4000); // ilk açılışta, auth/oturum oturduktan kısa süre sonra
    setInterval(() => { if (navigator.onLine) warmupSnapshots(); }, 60000); // sonra düzenli olarak
    window.addEventListener('online', warmupSnapshots); // bağlantı gelir gelmez hemen tazele

    // ── Kuyruğu önbelleğe uygulama ─────────────────────────────────────
    // Sorun: bir sipariş offline'da silinince kuyruğa alınıyor ve "başarılı"
    // dönüyordu, ama hemen ardından liste yenilenince ESKİ (silinmemiş)
    // önbellek gösteriliyordu — kullanıcı "silindi" görüyor ama liste
    // değişmiyordu. Çözüm: offline'da bir tablo listesini dönerken, o
    // tabloya ait kuyrukta bekleyen TÜM işlemleri (ekleme/güncelleme/silme)
    // sırayla listeye uyguluyoruz — böylece ekran her zaman "kuyruktaki
    // bekleyen değişikliklerle güncellenmiş" hâli gösteriyor.
    function applyOutboxToList(table, dataArray, outboxItems) {
      if (!Array.isArray(dataArray)) return dataArray; // sadece dizi cevaplarına uygulanabilir (settings gibi tekil objelere değil)
      let arr = dataArray.slice();
      const relevant = outboxItems
        .filter(it => { const info = parseApiUrl(it.url); return info && info.table === table; })
        .sort((a, b) => a.ts - b.ts);
      for (const it of relevant) {
        const info = parseApiUrl(it.url);
        let bodyObj = null;
        try { bodyObj = it.body ? JSON.parse(it.body) : null; } catch (e) {}
        if (it.method === 'DELETE') {
          const delId = info.id || bodyObj?.id;
          if (delId) arr = arr.filter(row => String(row.id) !== String(delId));
        } else if (it.method === 'POST' && bodyObj && !Array.isArray(bodyObj) && bodyObj.id) {
          if (!arr.some(row => String(row.id) === String(bodyObj.id))) arr.push(bodyObj);
        } else if (it.method === 'PUT') {
          const updId = info.id || bodyObj?.id;
          if (updId && bodyObj) {
            const idx = arr.findIndex(row => String(row.id) === String(updId));
            if (idx !== -1) arr[idx] = Object.assign({}, arr[idx], bodyObj);
          }
        }
      }
      // FIX: 'orders' tablosunun kendisini birleştirdikten sonra, her siparişin
      // İÇİNDEKİ order_items dizisini de ayrıca birleştiriyoruz. Sebep: yeni
      // eklenen kalemler (POST table=order_items, dizi gövdeli) ve "Mutfağa
      // Gönder"deki sent_to_kitchen işaretlemesi (PUT table=order_items) AYRI
      // bir tabloya kuyruklanıyor — bu olmadan sipariş satırı güncellenir ama
      // içindeki kalemler eski kalır, ekranda "eklenen yemek görünmüyor" ya da
      // "Mutfağa Gönder sonrası renk değişmiyor" gibi sorunlara yol açardı.
      if (table === 'orders') {
        const before = JSON.stringify(arr);
        arr = applyOrderItemsToOrders(arr, outboxItems);
        if (JSON.stringify(arr) !== before) console.log('%c[offline] siparişlerin içindeki kalemlere de kuyruktaki değişiklikler uygulandı (order_items)', 'color:#185FA5');
      }
      return arr;
    }

    function applyOrderItemsToOrders(ordersArray, outboxItems) {
      const itemOps = outboxItems
        .filter(it => { const info = parseApiUrl(it.url); return info && info.table === 'order_items'; })
        .sort((a, b) => a.ts - b.ts);
      for (const it of itemOps) {
        const info = parseApiUrl(it.url);
        let bodyObj = null;
        try { bodyObj = it.body ? JSON.parse(it.body) : null; } catch (e) {}
        if (it.method === 'POST') {
          // Toplu ekleme genelde bir DİZİ gövdedir (birden fazla kalem birden), ama
          // tekil obje de gelebilir — ikisini de aynı şekilde ele alıyoruz.
          const rows = Array.isArray(bodyObj) ? bodyObj : (bodyObj ? [bodyObj] : []);
          rows.forEach(row => {
            if (!row || !row.order_id) return;
            const order = ordersArray.find(o => String(o.id) === String(row.order_id));
            if (order) {
              order.order_items = Array.isArray(order.order_items) ? order.order_items.slice() : [];
              if (!order.order_items.some(x => String(x.id) === String(row.id))) order.order_items.push(row);
            }
          });
        } else if (it.method === 'PUT') {
          const updId = info.id || bodyObj?.id;
          if (updId && bodyObj) {
            for (const order of ordersArray) {
              if (!Array.isArray(order.order_items)) continue;
              const idx = order.order_items.findIndex(x => String(x.id) === String(updId));
              if (idx !== -1) {
                order.order_items = order.order_items.slice();
                order.order_items[idx] = Object.assign({}, order.order_items[idx], bodyObj);
                break;
              }
            }
          }
        } else if (it.method === 'DELETE') {
          const delId = info.id;
          if (delId) {
            for (const order of ordersArray) {
              if (Array.isArray(order.order_items)) {
                order.order_items = order.order_items.filter(x => String(x.id) !== String(delId));
              }
            }
          }
        }
      }
      return ordersArray;
    }
    async function queueRequest({ url, method, body, idemKey }) {
      const localId = uuid4();
      await idbPut('outbox', { localId, url, method, body, idemKey, ts: Date.now(), attempts: 0 });
      console.log('%c[offline] kuyruğa eklendi:', 'color:#B45309', method, url, '(localId=' + localId + ')');
      await refreshPendingCount();
      return localId;
    }

    async function trySend(item) {
      const token = localStorage.getItem('qr_token') || '';
      const headers = { 'Content-Type': 'application/json', 'X-Idempotency-Key': item.idemKey };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      try {
        // FIX: burada MUTLAKA orijinal (sarmalanmamış) fetch kullanılmalı.
        // Eğer global `fetch` çağrılsaydı, bu istek kendi sarmalayıcımıza
        // tekrar girer, YENİ bir idempotency key üretilir (item.idemKey göz
        // ardı edilir) ve hâlâ offline'sa istek TEKRAR kuyruğa eklenip bu
        // deneme yanlışlıkla "başarılı" sayılırdı — orijinal kayıt sunucuya
        // hiç ulaşmadan kuyruktan silinirdi. Bu yüzden _origFetch şart.
        const res = await _origFetch(item.url, { method: item.method, headers, body: item.body });
        const txt = await res.text();
        let validJson = true;
        try { JSON.parse(txt); } catch (e) { validJson = false; }
        if (!validJson || GATEWAY_ERROR_CODES.has(res.status)) {
          console.log('%c[offline] senkron denemesi başarısız (hâlâ ulaşılamıyor):', 'color:#A32D2D', item.method, item.url, 'status=' + res.status);
          return false;
        }
        console.log('%c[offline] senkron BAŞARILI:', 'color:#0F6E56', item.method, item.url, 'status=' + res.status);
        return true; // sunucu gerçek bir cevap verdi (başarı ya da iş kuralı hatası) — kuyruktan çıkar
      } catch (e) {
        console.log('%c[offline] senkron denemesi ağ hatasıyla başarısız:', 'color:#A32D2D', item.method, item.url, e?.message);
        return false;
      }
    }

    let syncing = false;
    async function flushOutbox() {
      if (syncing) return;
      syncing = true;
      let syncedAny = false;
      try {
        const items = await idbGetAll('outbox');
        if (items.length > 0) console.log('%c[offline] senkron döngüsü çalışıyor, kuyrukta ' + items.length + ' işlem var', 'color:#185FA5');
        for (const item of items.sort((a, b) => a.ts - b.ts)) {
          const ok = await trySend(item);
          if (ok) { await idbDelete('outbox', item.localId); syncedAny = true; }
        }
      } finally {
        syncing = false;
        await refreshPendingCount();
        if (syncedAny) {
          console.log('%c[offline] senkron tamamlandı — ekranlar en güncel sunucu verisiyle tazeleniyor', 'color:#0F6E56');
          forceRefreshVisibleScreens();
        }
      }
    }

    // FIX: kuyruk boşaldıktan sonra ekranın "eski, offline'da tahmin edilen"
    // hâlde kalmaması için — panelde hangi ekran/fonksiyonlar tanımlıysa
    // (sayfaya göre değişir) hepsini tetikleyip sunucudan TAZE veri çekiyoruz.
    // typeof kontrolleri sayesinde hangi sayfada olunursa olunsun güvenli;
    // tanımlı olmayan fonksiyon sessizce atlanır.
    function forceRefreshVisibleScreens() {
      try {
        if (typeof window.loadTablesAndOrders === 'function') window.loadTablesAndOrders();
        if (typeof window._pollOrders === 'function') window._pollOrders();
        if (typeof window.loadActiveStatus === 'function') window.loadActiveStatus();
        if (typeof window.loadKitchenOrders === 'function') window.loadKitchenOrders();
      } catch (e) {}
      window.dispatchEvent(new CustomEvent('offline-sync-complete'));
    }

    window.addEventListener('online', () => { console.log('%c[offline] bağlantı geri geldi, senkron deneniyor', 'color:#0F6E56'); flushOutbox(); });
    setInterval(() => { if (navigator.onLine) flushOutbox(); }, 6000);
    refreshPendingCount();

    // ── window.fetch'i şeffaf şekilde sarmalıyoruz ────────────────────
    const _origFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const method = (init?.method || 'GET').toUpperCase();
      const url = typeof input === 'string' ? input : input?.url || '';
      const info = parseApiUrl(url);

      // /api/index.php dışındaki (CDN, başka origin vb.) istekler dokunulmadan geçer
      if (!info) return _origFetch(input, init);

      // events_ping / events_wait / realtime zaten kendi hata yönetimini yapıyor — karışma
      if (info.table === 'events_ping' || info.table === 'events_wait' || info.table === 'realtime') {
        return _origFetch(input, init);
      }

      if (method === 'GET') {
        try {
          const res = await _origFetch(input, init);
          // Sunucudan GERÇEK bir cevap geldi mi kontrol et (401/403/404 dahil —
          // bunlar bağlantı sorunu değil, meşru sunucu cevaplarıdır ve ASLA eski
          // önbelleğe düşürülmemeli; örn. geçersiz oturumda yanlışlıkla eski
          // "giriş yapılmış" verisini göstermek ciddi bir güvenlik hatası olurdu).
          if (!GATEWAY_ERROR_CODES.has(res.status)) {
            if (res.ok) {
              const clone = res.clone();
              clone.text().then(txt => {
                try { JSON.parse(txt); } catch (e) { return; } // bozuk/HTML cevabı önbelleğe alma
                if (SNAPSHOT_TABLES.includes(info.table)) snapshotSet(cacheKeyFor(info, info.url), txt);
              }).catch(() => {});
            }
            return res; // 2xx, 4xx — her durumda olduğu gibi dön, bunlar meşru cevaplar
          }
          throw new Error('gateway ' + res.status);
        } catch (e) {
          // Sadece gerçek bağlantı/gateway hatasında (ağ koptu, 522/502/504 vb.)
          // son bilinen anlık görüntüye düşülür.
          const cached = await snapshotGet(cacheKeyFor(info, info.url));
          if (cached !== null) {
            let finalText = cached;
            try {
              let parsed = JSON.parse(cached);
              const outboxItems = await idbGetAll('outbox');
              const merged = applyOutboxToList(info.table, parsed, outboxItems);
              finalText = JSON.stringify(merged);
              if (merged !== parsed) console.log('%c[offline] GET yedeğe kuyruktaki bekleyen değişiklikler uygulandı:', 'color:#185FA5', info.table);
            } catch (mergeErr) { /* dizi olmayan cevaplarda (örn. tekil obje) olduğu gibi dön */ }
            console.log('%c[offline] GET yedekten servis edildi:', 'color:#B45309', url);
            return new Response(finalText, { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          console.warn('[offline] GET başarısız ve hiç önbellek yok:', url, e?.message);
          throw e; // hiç önbellek yoksa (ilk kez açılıyor + hiç internet yok) gerçek hatayı ilet
        }
      }

      // POST/PUT/DELETE: kuyruk + idempotency ile offline-güvenli
      if (['POST', 'PUT', 'DELETE'].includes(method)) {
        const idemKey = uuid4();
        let bodyObj = null;
        try { bodyObj = init?.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : null; } catch (e) {}
        // Yeni kayıt oluşturma isteklerinde (URL'de &id= yoksa) client-side
        // bir id üretip GÖVDEYE yazıyoruz. Böylece:
        // - Optimistic UI cevabında dönen id
        // - Bağlantı geri gelip sunucuya gerçekten gönderildiğinde oluşan kayıt
        // HER ZAMAN aynı id'yi taşır — referans kopması / kopya kayıt olmaz
        // (sunucu, config.php'deki resolveEntityId() ile bu id'yi zaten kabul ediyor).
        // FIX: bu artık sadece tekil obje gövdelerinde değil, DİZİ gövdelerde
        // (örn. order_items toplu ekleme: [{...},{...}]) de yapılıyor — her
        // elemana ayrı ayrı id atanıyor. Önceki halinde diziler atlanıyordu,
        // bu yüzden offline'da eklenen kalemlerin hiç id'si olmuyordu; panel
        // o kalemi daha sonra güncellemeye çalışınca "id=undefined" ile
        // isteğe gidip sunucudan 404 alıyordu (ve bu sessizce kayboluyordu).
        const isCreate = !info.id; // URL'de &id= yoksa yeni kayıt oluşturuluyor demektir
        if (isCreate && bodyObj && typeof bodyObj === 'object') {
          if (Array.isArray(bodyObj)) {
            bodyObj.forEach(row => { if (row && typeof row === 'object' && !row.id) row.id = uuid4(); });
          } else if (!bodyObj.id) {
            bodyObj.id = uuid4();
          }
        }
        const bodyText = bodyObj !== null ? JSON.stringify(bodyObj) : (typeof init?.body === 'string' ? init.body : null);
        const headers = Object.assign({}, init?.headers, { 'X-Idempotency-Key': idemKey });
        try {
          const res = await _origFetch(url, Object.assign({}, init, { headers, body: bodyText !== null ? bodyText : init?.body }));
          const clone = res.clone();
          const txt = await clone.text();
          let validJson = true;
          try { JSON.parse(txt); } catch (e) { validJson = false; }
          if (!validJson || GATEWAY_ERROR_CODES.has(res.status)) throw new Error('gateway');
          return res; // gerçek cevap (başarı ya da 409 gibi meşru iş hatası) — olduğu gibi dön
        } catch (e) {
          console.log('%c[offline] ' + method + ' başarısız oldu, kuyruğa alınıyor:', 'color:#B45309', url, '— sebep:', e?.message);
          // Bağlantı/sunucu hatası: isteği (client id'leriyle birlikte) kuyruğa al,
          // iyimser bir "kabul edildi" cevabı üret — çağıran kod (admin.html)
          // sanki sunucu cevap vermiş gibi normal akışına devam eder.
          await queueRequest({ url, method, body: bodyText, idemKey });
          let echo;
          if (Array.isArray(bodyObj)) {
            echo = bodyObj.map(row => Object.assign({}, row, { _offline_queued: true }));
          } else if (bodyObj && typeof bodyObj === 'object') {
            echo = Object.assign({}, bodyObj);
            if (!echo.id) echo.id = info.id || uuid4();
            echo._offline_queued = true;
          } else {
            echo = { ok: true, _offline_queued: true };
          }
          return new Response(JSON.stringify(echo), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }

      return _origFetch(input, init);
    };
  })();

})(window);