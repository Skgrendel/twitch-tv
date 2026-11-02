/* Twitch TV personal para webOS.
 * Compatible con Chromium 53+ (webOS 4.0): sin async/await, sin optional chaining, sin spread de objetos. */
(function () {
  'use strict';

  var CFG = window.TWITCH_CONFIG || {};
  var API = 'https://api.twitch.tv/helix';
  var LS_TOKEN = 'tw_token';
  var LS_STATE = 'tw_state';
  var LS_CHAT = 'tw_chat';

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK_WEBOS: 461, BACKSPACE: 8, ESC: 27 };

  var state = {
    token: null,
    userId: null,
    tab: 'home',        // home | following | browse | search
    cursor: null,
    gameId: null,
    gameName: null,
    chatOn: true,
    current: null,      // canal que se esta viendo
    view: 'login',
    sidebarAt: 0
  };

  var avatars = {};     // user_id -> url de la foto de perfil
  var infoTimer = null;

  try { state.chatOn = localStorage.getItem(LS_CHAT) !== '0'; } catch (e) {}

  function $(id) { return document.getElementById(id); }
  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined && text !== null) { e.textContent = text; }
    return e;
  }

  /* ---------------- Auth ---------------- */

  function randomState() {
    var a = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(a);
    var s = '';
    for (var i = 0; i < a.length; i++) { s += ('0' + a[i].toString(16)).slice(-2); }
    return s;
  }

  function loginUrl() {
    var st = randomState();
    try { localStorage.setItem(LS_STATE, st); } catch (e) {}
    return 'https://id.twitch.tv/oauth2/authorize' +
      '?client_id=' + encodeURIComponent(CFG.CLIENT_ID) +
      '&redirect_uri=' + encodeURIComponent(CFG.REDIRECT_URI) +
      '&response_type=token' +
      '&scope=' + encodeURIComponent('user:read:follows') +
      '&state=' + st;
  }

  function readTokenFromHash() {
    if (!location.hash || location.hash.indexOf('access_token') === -1) { return null; }
    var p = new URLSearchParams(location.hash.slice(1));
    var token = p.get('access_token');
    var st = p.get('state');
    var saved = null;
    try { saved = localStorage.getItem(LS_STATE); } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search);
    if (token && st && saved && st === saved) { return token; }
    return null;
  }

  function logout() {
    try { localStorage.removeItem(LS_TOKEN); } catch (e) {}
    state.token = null;
    state.userId = null;
    state.sidebarAt = 0;
    showLogin();
  }

  /* ---------------- API ---------------- */

  function api(path) {
    return fetch(API + path, {
      headers: { 'Authorization': 'Bearer ' + state.token, 'Client-Id': CFG.CLIENT_ID }
    }).then(function (r) {
      if (r.status === 401) { logout(); throw new Error('Sesión expirada'); }
      if (!r.ok) { throw new Error('Error de Twitch (' + r.status + ')'); }
      return r.json();
    });
  }

  function img(url, w, h) {
    return (url || '').replace('{width}', w).replace('{height}', h);
  }

  function fmtViewers(n) {
    if (n >= 1000) {
      var v = (n / 1000).toFixed(1);
      if (v.slice(-2) === '.0') { v = v.slice(0, -2); }
      return v.replace('.', ',') + ' mil';
    }
    return String(n);
  }

  function ensureUser() {
    if (state.userId) { return Promise.resolve(); }
    return api('/users').then(function (r) { state.userId = r.data[0].id; });
  }

  /* ---- avatares (foto de perfil) por lotes ---- */

  function fetchAvatars(ids) {
    var missing = [], seen = {};
    ids.forEach(function (id) {
      if (id && !avatars[id] && !seen[id]) { seen[id] = 1; missing.push(id); }
    });
    if (!missing.length) { return Promise.resolve(); }
    missing = missing.slice(0, 100);
    return api('/users?' + missing.map(function (i) { return 'id=' + i; }).join('&'))
      .then(function (r) {
        r.data.forEach(function (u) { avatars[u.id] = u.profile_image_url; });
      })
      .catch(function () { /* sin avatares no pasa nada */ });
  }

  function applyAvatars() {
    var imgs = document.querySelectorAll('img[data-uid]');
    for (var i = 0; i < imgs.length; i++) {
      var u = imgs[i].getAttribute('data-uid');
      if (u && avatars[u] && imgs[i].getAttribute('src') !== avatars[u]) { imgs[i].src = avatars[u]; }
    }
  }

  /* Convierte un objeto "stream" de Helix en un objeto de canal propio. */
  function fromStream(s) {
    return {
      login: s.user_login, name: s.user_name, userId: s.user_id, title: s.title,
      game: s.game_name, viewers: s.viewer_count, tags: s.tags || [], live: true,
      thumb: img(s.thumbnail_url, 440, 248)
    };
  }

  /* ---------------- Vistas ---------------- */

  function setView(name) {
    state.view = name;
    hide('view-login'); hide('view-browse'); hide('view-player');
    show('view-' + name);
  }

  function showLogin(msg) {
    destroyPlayer();
    setView('login');
    $('login-error').textContent = msg || '';
    $('btn-login').focus();
  }

  function showBrowse() {
    destroyPlayer();
    setView('browse');
    if (state.tab === 'search') { state.tab = 'home'; }
    selectTab(state.tab, true);
    if (Date.now() - state.sidebarAt > 60000) { loadSidebar(); }
  }

  function selectTab(tab, keepFocus) {
    state.tab = tab;
    state.cursor = null;
    state.gameId = null;
    state.gameName = null;
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === tab);
    }
    $('grid').innerHTML = '';
    $('status').textContent = '';
    hide('btn-more');

    var titles = {
      home: 'Canales en vivo recomendados',
      following: 'Canales que sigues en vivo',
      browse: 'Explorar categorías'
    };
    $('section-title').textContent = titles[tab] || '';
    loadList(false);
  }

  /* ---------------- Listados ---------------- */

  function showSkeleton(n) {
    var g = $('grid');
    for (var i = 0; i < n; i++) {
      var w = el('div', 'card-wrap skel');
      var c = el('div', 'card');
      c.appendChild(el('div', 'thumb'));
      c.appendChild(el('div', 'line'));
      w.appendChild(c);
      g.appendChild(w);
    }
  }

  function clearSkeleton() {
    var s = $('grid').querySelectorAll('.skel');
    for (var i = 0; i < s.length; i++) { s[i].parentNode.removeChild(s[i]); }
  }

  function loadList(append) {
    $('status').textContent = '';
    hide('btn-more');
    if (!append) { showSkeleton(8); }
    var cursor = append && state.cursor ? '&after=' + encodeURIComponent(state.cursor) : '';
    var p;

    if (state.gameId) {
      p = api('/streams?first=24&game_id=' + state.gameId + cursor).then(renderStreams);
    } else if (state.tab === 'home') {
      p = api('/streams?first=24' + cursor).then(renderStreams);
    } else if (state.tab === 'following') {
      p = ensureUser().then(function () {
        return api('/streams/followed?first=24&user_id=' + state.userId + cursor);
      }).then(renderStreams);
    } else if (state.tab === 'browse') {
      p = api('/games/top?first=24' + cursor).then(renderGames);
    } else {
      return;
    }

    p.catch(function (e) { clearSkeleton(); $('status').textContent = e.message; });

    function renderStreams(res) {
      state.cursor = res.pagination && res.pagination.cursor || null;
      if (!append) { $('grid').innerHTML = ''; }
      clearSkeleton();
      res.data.forEach(function (s) { streamCard(fromStream(s)); });
      finishList(res.data.length);
      fetchAvatars(res.data.map(function (s) { return s.user_id; })).then(applyAvatars);
    }

    function renderGames(res) {
      state.cursor = res.pagination && res.pagination.cursor || null;
      if (!append) { $('grid').innerHTML = ''; }
      clearSkeleton();
      res.data.forEach(function (g) { gameCard(g); });
      finishList(res.data.length);
    }
  }

  function finishList(count) {
    $('status').textContent = count ? '' : 'No hay resultados.';
    if (state.cursor) { show('btn-more'); } else { hide('btn-more'); }
    if (!document.activeElement || document.activeElement === document.body) {
      var first = $('grid').querySelector('.card');
      if (first) { first.focus(); }
    }
  }

  /* ---------------- Tarjetas ---------------- */

  function streamCard(o) {
    var wrap = el('div', 'card-wrap');
    var card = el('div', 'card');
    card.tabIndex = 0;

    var thumb = el('div', 'thumb');
    var im = el('img'); im.src = o.thumb; im.alt = '';
    thumb.appendChild(im);
    if (o.live) { thumb.appendChild(el('span', 'badge badge-live', 'En vivo')); }
    if (o.viewers !== null && o.viewers !== undefined) {
      thumb.appendChild(el('span', 'badge badge-viewers', fmtViewers(o.viewers) + ' espectadores'));
    }
    card.appendChild(thumb);

    var info = el('div', 'info');
    var av = el('img', 'avatar'); av.alt = '';
    av.setAttribute('data-uid', o.userId || '');
    if (o.userId && avatars[o.userId]) { av.src = avatars[o.userId]; }
    info.appendChild(av);

    var txt = el('div', 'txt');
    txt.appendChild(el('div', 'title', o.title || o.name));
    txt.appendChild(el('div', 'chan', o.name));
    if (o.game) { txt.appendChild(el('div', 'game', o.game)); }
    if (o.tags && o.tags.length) {
      var tg = el('div', 'tags');
      o.tags.slice(0, 3).forEach(function (t) { tg.appendChild(el('span', 'tag', t)); });
      txt.appendChild(tg);
    }
    info.appendChild(txt);
    card.appendChild(info);
    wrap.appendChild(card);

    card.addEventListener('click', function () { openPlayer(o); });
    $('grid').appendChild(wrap);
  }

  function gameCard(g) {
    var wrap = el('div', 'card-wrap');
    var card = el('div', 'card game');
    card.tabIndex = 0;
    var thumb = el('div', 'thumb');
    var im = el('img'); im.src = img(g.box_art_url, 285, 380); im.alt = '';
    thumb.appendChild(im);
    card.appendChild(thumb);
    var info = el('div', 'info');
    var txt = el('div', 'txt');
    txt.style.marginLeft = '0';
    txt.appendChild(el('div', 'title', g.name));
    info.appendChild(txt);
    card.appendChild(info);
    wrap.appendChild(card);
    card.addEventListener('click', function () { openGame(g); });
    $('grid').appendChild(wrap);
  }

  function openGame(g) {
    state.gameId = g.id;
    state.gameName = g.name;
    state.cursor = null;
    $('section-title').textContent = g.name + ' — canales en vivo';
    $('grid').innerHTML = '';
    loadList(false);
  }

  /* ---------------- Barra lateral ---------------- */

  function loadSidebar() {
    var followed = [], recs = [];
    var pF = ensureUser().then(function () {
      return api('/streams/followed?first=10&user_id=' + state.userId);
    }).then(function (r) { followed = r.data; }).catch(function () {});
    var pR = api('/streams?first=10').then(function (r) { recs = r.data; }).catch(function () {});

    Promise.all([pF, pR]).then(function () {
      var ids = followed.concat(recs).map(function (s) { return s.user_id; });
      return fetchAvatars(ids);
    }).then(function () {
      state.sidebarAt = Date.now();
      renderSide('side-followed', followed, 'Ningún canal que sigues está en vivo.');
      renderSide('side-recs', recs, 'Sin recomendados.');
      applyAvatars();
    });
  }

  function renderSide(containerId, list, emptyText) {
    var c = $(containerId);
    c.innerHTML = '';
    if (!list.length) { c.appendChild(el('div', 'side-empty', emptyText)); return; }
    list.forEach(function (s) {
      var o = fromStream(s);
      var item = el('div', 'side-item');
      item.tabIndex = 0;
      var av = el('img', 'avatar'); av.alt = '';
      av.setAttribute('data-uid', o.userId);
      if (avatars[o.userId]) { av.src = avatars[o.userId]; }
      item.appendChild(av);
      var st = el('div', 'st');
      st.appendChild(el('div', 'sn', o.name));
      st.appendChild(el('div', 'sg', o.game || ''));
      item.appendChild(st);
      var sv = el('div', 'sv');
      sv.appendChild(el('span', 'dot'));
      sv.appendChild(document.createTextNode(fmtViewers(o.viewers)));
      item.appendChild(sv);
      item.addEventListener('click', function () { openPlayer(o); });
      c.appendChild(item);
    });
  }

  /* ---------------- Busqueda ---------------- */

  function runSearch() {
    var q = $('search-input').value.trim();
    if (!q) { return; }
    state.tab = 'search';
    state.gameId = null;
    state.cursor = null;
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) { tabs[i].classList.remove('active'); }
    $('section-title').textContent = 'Resultados para "' + q + '"';
    $('status').textContent = '';
    hide('btn-more');
    $('grid').innerHTML = '';
    showSkeleton(8);

    api('/search/channels?first=24&live_only=true&query=' + encodeURIComponent(q)).then(function (res) {
      $('grid').innerHTML = '';
      res.data.forEach(function (c) {
        if (c.id && c.thumbnail_url) { avatars[c.id] = c.thumbnail_url; }
        streamCard({
          login: c.broadcaster_login, name: c.display_name, userId: c.id, title: c.title,
          game: c.game_name, viewers: null, tags: c.tags || [], live: c.is_live,
          thumb: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_' + c.broadcaster_login + '-440x248.jpg'
        });
      });
      $('status').textContent = res.data.length ? '' : 'Sin canales en vivo para esa búsqueda.';
      var first = $('grid').querySelector('.card');
      if (first) { first.focus(); }
    }).catch(function (e) { $('grid').innerHTML = ''; $('status').textContent = e.message; });
  }

  /* ---------------- Reproductor ---------------- */

  function setMeta(o) {
    var parts = [];
    if (o.game) { parts.push(o.game); }
    if (o.viewers !== null && o.viewers !== undefined) { parts.push(fmtViewers(o.viewers) + ' espectadores'); }
    $('pi-meta').textContent = parts.join('  ·  ');
  }

  function applyChat() {
    if (state.chatOn) { show('chat-frame'); } else { hide('chat-frame'); }
    $('btn-chat').textContent = state.chatOn ? 'Ocultar chat' : 'Mostrar chat';
  }

  function openPlayer(o) {
    state.current = o;
    setView('player');
    $('pi-name').textContent = o.name || o.login;
    $('pi-title').textContent = o.title || '';
    var av = $('pi-avatar');
    av.setAttribute('data-uid', o.userId || '');
    if (o.userId && avatars[o.userId]) { av.src = avatars[o.userId]; } else { av.removeAttribute('src'); }
    setMeta(o);

    $('player-embed').innerHTML = '';
    var host = location.hostname;

    if (window.Twitch && window.Twitch.Embed) {
      new window.Twitch.Embed('player-embed', {
        width: '100%', height: '100%', channel: o.login,
        layout: 'video', autoplay: true, muted: false, parent: [host]
      });
    } else {
      $('player-embed').innerHTML = '<p style="padding:48px">No se pudo cargar el reproductor de Twitch.</p>';
    }

    $('chat-frame').src = 'https://www.twitch.tv/embed/' + encodeURIComponent(o.login) +
      '/chat?darkpopout&parent=' + encodeURIComponent(host);
    applyChat();
    $('btn-back').focus();

    // Refresca espectadores y titulo cada minuto.
    clearInterval(infoTimer);
    infoTimer = setInterval(function () {
      api('/streams?user_login=' + encodeURIComponent(o.login)).then(function (r) {
        if (state.view !== 'player') { return; }
        if (r.data && r.data[0]) {
          o.viewers = r.data[0].viewer_count;
          o.title = r.data[0].title;
          o.game = r.data[0].game_name;
          $('pi-title').textContent = o.title;
          setMeta(o);
        } else {
          $('pi-meta').textContent = 'Fuera de línea';
        }
      }).catch(function () {});
    }, 60000);
  }

  function destroyPlayer() {
    clearInterval(infoTimer);
    infoTimer = null;
    $('player-embed').innerHTML = '';
    $('chat-frame').removeAttribute('src');
  }

  function toggleChat() {
    state.chatOn = !state.chatOn;
    try { localStorage.setItem(LS_CHAT, state.chatOn ? '1' : '0'); } catch (e) {}
    applyChat();
  }

  /* ---------------- Navegacion con control remoto ---------------- */

  function focusables() {
    var all = document.querySelectorAll('[tabindex="0"], input');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var b = all[i].getBoundingClientRect();
      if (b.width > 0 && b.height > 0 && all[i].offsetParent !== null) { out.push(all[i]); }
    }
    return out;
  }

  function move(dir) {
    var cur = document.activeElement;
    var els = focusables();
    if (!cur || cur === document.body || els.indexOf(cur) === -1) {
      if (els[0]) { els[0].focus(); }
      return;
    }
    var r = cur.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var best = null, bestScore = Infinity;

    els.forEach(function (e) {
      if (e === cur) { return; }
      var b = e.getBoundingClientRect();
      var dx = (b.left + b.width / 2) - cx, dy = (b.top + b.height / 2) - cy;
      var primary, secondary, ok;
      if (dir === 'left')  { ok = dx < -2; primary = -dx; secondary = Math.abs(dy); }
      if (dir === 'right') { ok = dx > 2;  primary = dx;  secondary = Math.abs(dy); }
      if (dir === 'up')    { ok = dy < -2; primary = -dy; secondary = Math.abs(dx); }
      if (dir === 'down')  { ok = dy > 2;  primary = dy;  secondary = Math.abs(dx); }
      if (!ok) { return; }
      var score = primary + secondary * 2.5;
      if (score < bestScore) { bestScore = score; best = e; }
    });

    if (best) {
      best.focus();
      if (best.scrollIntoView) { best.scrollIntoView({ block: 'nearest' }); }
    }
  }

  function goBack() {
    if (state.view === 'player') { showBrowse(); return true; }
    if (state.view === 'browse') {
      if (state.tab === 'search') { selectTab('home'); return true; }
      if (state.gameId) { selectTab('browse'); return true; }
    }
    return false; // dejar que webOS cierre la app
  }

  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    var inInput = document.activeElement && document.activeElement.tagName === 'INPUT';

    if (k === KEY.LEFT || k === KEY.RIGHT) {
      if (inInput) { return; } // mover cursor del texto
      e.preventDefault(); move(k === KEY.LEFT ? 'left' : 'right');
    } else if (k === KEY.UP) {
      e.preventDefault(); move('up');
    } else if (k === KEY.DOWN) {
      e.preventDefault(); move('down');
    } else if (k === KEY.ENTER) {
      if (inInput) { runSearch(); return; }
      var a = document.activeElement;
      if (a && a.click) { e.preventDefault(); a.click(); }
    } else if (k === KEY.BACK_WEBOS || k === KEY.ESC || (k === KEY.BACKSPACE && !inInput)) {
      if (inInput && k !== KEY.BACK_WEBOS) { return; }
      if (goBack()) { e.preventDefault(); }
    }
  });

  /* ---------------- Eventos de UI ---------------- */

  $('btn-login').addEventListener('click', function () {
    if (!CFG.CLIENT_ID || CFG.CLIENT_ID.indexOf('PEGA_AQUI') === 0) {
      $('login-error').textContent = 'Falta configurar CLIENT_ID en config.js';
      return;
    }
    location.href = loginUrl();
  });
  $('btn-logout').addEventListener('click', logout);
  $('btn-more').addEventListener('click', function () { loadList(true); });
  $('btn-search').addEventListener('click', runSearch);
  $('btn-back').addEventListener('click', showBrowse);
  $('btn-chat').addEventListener('click', toggleChat);
  $('tabs').addEventListener('click', function (e) {
    var t = e.target.getAttribute && e.target.getAttribute('data-tab');
    if (t) { selectTab(t); }
  });

  /* ---------------- Inicio ---------------- */

  function init() {
    var fromHash = readTokenFromHash();
    if (fromHash) {
      try { localStorage.setItem(LS_TOKEN, fromHash); } catch (e) {}
    }
    try { state.token = localStorage.getItem(LS_TOKEN); } catch (e) {}

    if (state.token) { showBrowse(); } else { showLogin(); }
  }

  init();
})();
