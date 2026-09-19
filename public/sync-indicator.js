// public/sync-indicator.js — Senkron durumu göstergesi
// Sağ altta küçük bir rozet: çevrimiçi/çevrimdışı, bekleyen kayıt sayısı,
// gönderilemeyen kayıtlar. Tıklayınca detay + "şimdi senkronize et" / "tekrar dene".
(function () {
  if (window.__kasaSyncIndicator) return;
  window.__kasaSyncIndicator = true;

  const css = `
  /* Sadece küçük bir yuvarlak: durum RENKLE anlatılır, yazı yok.
     Yeşil = senkron, sarı = gönderiliyor, kırmızı = çevrimdışı/hata.
     Tıklayınca ayrıntı paneli açılır. */
  #kasaSync{position:fixed;right:16px;bottom:16px;z-index:99999;width:14px;height:14px;
    border-radius:50%;cursor:pointer;background:#22c55e;border:2px solid rgba(255,255,255,.35);
    box-shadow:0 2px 10px rgba(0,0,0,.4);transition:background .2s,transform .15s;user-select:none;
    -webkit-app-region:no-drag}
  #kasaSync:hover{transform:scale(1.25)}
  #kasaSync.off{background:#ef4444}
  #kasaSync.busy{background:#eab308;animation:kasaPulse 1.2s infinite}
  #kasaSync.err{background:#ef4444;animation:kasaPulse 1.2s infinite}
  @keyframes kasaPulse{0%,100%{opacity:1}50%{opacity:.3}}
  #kasaSyncPanel{position:fixed;right:16px;bottom:40px;z-index:99999;display:none;width:300px;padding:14px;
    border-radius:12px;background:#14161c;color:#e7e9ee;border:1px solid #2a2e38;
    box-shadow:0 12px 40px rgba(0,0,0,.5);font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
  #kasaSyncPanel h4{margin:0 0 8px;font-size:13px;color:#fff}
  #kasaSyncPanel .row{display:flex;justify-content:space-between;gap:10px;padding:3px 0;color:#aab0bd}
  #kasaSyncPanel .row b{color:#e7e9ee;font-weight:600;text-align:right;word-break:break-word}
  #kasaSyncPanel button{margin-top:10px;width:100%;padding:8px;border-radius:8px;border:1px solid #2f3542;
    background:#1e222b;color:#e7e9ee;cursor:pointer;font:600 12px/1 inherit}
  #kasaSyncPanel button:hover{background:#262b36}
  #kasaSyncPanel .err{margin-top:8px;color:#ff9a9a;font-size:11px;word-break:break-word}`;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const badge = document.createElement('div');
  badge.id = 'kasaSync';
  badge.title = 'Senkronizasyon durumu';
  const panel = document.createElement('div');
  panel.id = 'kasaSyncPanel';
  document.body.appendChild(badge);
  document.body.appendChild(panel);

  let state = {};

  function fmt(iso) {
    if (!iso) return '—';
    const d = new Date(iso), diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return Math.max(0, Math.round(diff)) + ' sn önce';
    if (diff < 3600) return Math.round(diff / 60) + ' dk önce';
    return d.toLocaleTimeString();
  }

  function render() {
    const s = state;
    badge.className = !s.online ? 'off'
      : (s.failed > 0 ? 'err'
      : (s.syncing || s.pending > 0 ? 'busy' : ''));
    // Yazı yok; üzerine gelince kısa bilgi görünsün diye title kullanıyoruz.
    let txt;
    if (!s.online) txt = s.pending > 0 ? `Çevrimdışı · ${s.pending} bekliyor` : 'Çevrimdışı';
    else if (s.pending > 0) txt = `Gönderiliyor · ${s.pending}`;
    else txt = s.realtime ? 'Anlık senkron' : 'Senkron';
    if (s.failed > 0) txt += ` · ${s.failed} hata`;
    badge.title = txt;

    panel.innerHTML = `
      <h4>Senkronizasyon</h4>
      <div class="row"><span>Bağlantı</span><b>${s.online ? 'Çevrimiçi' : 'Çevrimdışı'}</b></div>
      <div class="row"><span>Anlık kanal</span><b>${s.realtime ? 'Açık' : 'Kapalı (yoklama)'}</b></div>
      <div class="row"><span>Bekleyen kayıt</span><b>${s.pending ?? 0}</b></div>
      <div class="row"><span>Gönderilemeyen</span><b>${s.failed ?? 0}</b></div>
      <div class="row"><span>Son gönderim</span><b>${fmt(s.last_push_at)}</b></div>
      <div class="row"><span>Son çekme</span><b>${fmt(s.last_pull_at)}</b></div>
      <div class="row"><span>Sunucu</span><b>${s.server_url || '—'}</b></div>
      ${s.auth_error ? '<div class="err">Oturum süresi doldu — kurulum ekranından tekrar giriş yapın.</div>' : ''}
      ${s.last_error && !s.auth_error ? `<div class="err">${String(s.last_error).slice(0, 160)}</div>` : ''}
      <button data-act="now">Şimdi senkronize et</button>
      ${s.failed > 0 ? '<button data-act="retry">Gönderilemeyenleri tekrar dene</button>' : ''}
      ${s.failed > 0 ? '<button data-act="details">Hata ayrıntılarını göster</button>' : ''}
      ${s.failed > 0 ? '<button data-act="clear">Gönderilemeyenleri kuyruktan sil</button>' : ''}
      <div id="kasaSyncErrs"></div>`;
  }

  async function poll() {
    try {
      const r = await fetch('/api/sync/status');
      state = await r.json();
      render();
    } catch (e) { /* local sunucu kapalıysa sessiz geç */ }
  }

  badge.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    if (panel.style.display === 'block') poll();
  });

  // Hata ayrıntıları: hangi tablo, hangi istek, sunucu ne dedi.
  async function showDetails() {
    const box = document.getElementById('kasaSyncErrs');
    if (!box) return;
    box.innerHTML = '<div class="row"><span>Yükleniyor…</span></div>';
    try {
      const rows = await (await fetch('/api/sync/failed')).json();
      if (!rows.length) { box.innerHTML = '<div class="row"><span>Kayıt yok</span></div>'; return; }
      box.innerHTML = rows.slice(0, 10).map(r =>
        `<div class="err"><b>${r.method} ${r.entity_table || ''}</b> ${r.entity_id ? '#' + String(r.entity_id).slice(0, 8) : ''}<br>${String(r.last_error || '').slice(0, 220)}</div>`
      ).join('');
    } catch (e) { box.innerHTML = '<div class="err">Ayrıntılar alınamadı</div>'; }
  }

  panel.addEventListener('click', async (e) => {
    const act = e.target?.dataset?.act;
    if (!act) return;
    if (act === 'details') return showDetails();
    e.target.disabled = true;
    const urls = { retry: '/api/sync/retry', clear: '/api/sync/clear-failed', now: '/api/sync/now' };
    try { await fetch(urls[act] || urls.now, { method: 'POST' }); } catch (err) {}
    setTimeout(poll, 600);
  });

  // Sunucu durum değiştirdiğinde SSE ile anında haber veriyor (api.js yayınlıyor);
  // yoklama yalnızca yedek olarak, seyrek çalışır.
  window.addEventListener('kasa:sync-status', (e) => { state = e.detail || state; render(); });
  poll();
  setInterval(poll, 10000);
})();
