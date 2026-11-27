/*
 * Nuvio Lite for Samsung Orsay (2011-2014 Smart Hub)
 * ES5 only: Maple browser has no Promise, no let/const, no arrow functions.
 * All HTTPS traffic goes through a relay (TV Setup on the phone, the Orsay Relay
 * Cloudflare Worker, or the Orsay Bridge on a PC), because 2014 firmware cannot
 * validate modern TLS certificates. CFG comes from config.js, written by TV Setup.
 */
var widgetAPI = null, pluginAPI = null, tvKey = null;
try { widgetAPI = new Common.API.Widget(); pluginAPI = new Common.API.Plugin(); tvKey = new Common.API.TVKeyValue(); } catch (e) {}
if (!tvKey) {
  tvKey = { KEY_LEFT:37, KEY_UP:38, KEY_RIGHT:39, KEY_DOWN:40, KEY_ENTER:13, KEY_RETURN:8, KEY_EXIT:27,
    KEY_PLAY:80, KEY_PAUSE:19, KEY_STOP:83, KEY_FF:70, KEY_RW:82, KEY_RED:49, KEY_GREEN:50, KEY_YELLOW:51, KEY_BLUE:52, KEY_INFO:73 };
}

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function trimSlash(u) { return u.replace(/\/manifest\.json$/, '').replace(/\/+$/, ''); }
function viaBridge(u, path, extra, base) {
  return (base || CFG.relay) + (path || '/proxy') + '?u=' + encodeURIComponent(u) + (CFG.key ? '&k=' + encodeURIComponent(CFG.key) : '') + (extra || '');
}
function fmt(ms) {
  var s = Math.floor((ms || 0) / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); s = s % 60;
  return (h ? h + ':' : '') + (m < 10 && h ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

/* Torrentio and similar scrapers refuse cloud servers (the Cloudflare relay gets 429), so stream
   lookups and link resolving try the phone relay first (home internet) and fall back to CFG.relay.
   phoneOk remembers the last result for a minute so a closed phone app costs one short wait. */
var Net = {
  phoneOk: null, phoneAt: 0,
  usePhone: function () {
    if (!CFG.phoneRelay || CFG.phoneRelay === CFG.relay) return false;
    return Net.phoneOk !== false || new Date().getTime() - Net.phoneAt > 60000;
  },
  get: function (full, ms, ok, fail) {
    var x = new XMLHttpRequest(), done = false;
    var t = setTimeout(function () { if (!done) { done = true; try { x.abort(); } catch (e) {} if (fail) fail('timeout', 0); } }, ms);
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || done) return;
      done = true; clearTimeout(t);
      if (x.status >= 200 && x.status < 300) {
        var j = null;
        try { j = JSON.parse(x.responseText); } catch (e) { if (fail) fail('bad json', x.status); return; }
        ok(j);
      } else if (fail) fail('HTTP ' + x.status, x.status);
    };
    x.open('GET', full, true);
    x.send(null);
  },
  getJSON: function (url, ok, fail, phoneFirst) {
    if (phoneFirst && Net.usePhone()) {
      Net.get(viaBridge(url, '/proxy', '', CFG.phoneRelay), 6000, function (j) {
        Net.phoneOk = true; Net.phoneAt = new Date().getTime(); ok(j);
      }, function (err, status) {
        if (status) { Net.phoneOk = true; Net.phoneAt = new Date().getTime(); if (fail) fail(err + ' (via phone)'); return; }
        Net.phoneOk = false; Net.phoneAt = new Date().getTime();
        Net.get(viaBridge(url), 20000, ok, fail);
      });
      return;
    }
    Net.get(viaBridge(url), 20000, ok, fail);
  }
};

var UI = {
  toastTimer: null,
  toast: function (msg) {
    var t = $('toast'); t.innerHTML = esc(msg); t.className = '';
    clearTimeout(UI.toastTimer); UI.toastTimer = setTimeout(function () { t.className = 'hidden'; }, 3500);
  },
  busy: function (on) { $('spinner').className = on ? '' : 'hidden'; },
  show: function (id) {
    var s = ['home', 'detail', 'search'];
    for (var i = 0; i < s.length; i++) $(s[i]).className = 'screen' + (s[i] === id ? '' : ' hidden');
  },
  crumb: function (t) { $('crumb').innerHTML = esc(t || ''); }
};

/* ---------------- Home: Netflix-style rows ---------------- */
var Home = {
  rows: [], r: 0, c: [], ROW_H: 296, CARD_W: 176,
  load: function () {
    Home.rows = []; Home.c = [];
    var cats = CFG.catalogs, pending = cats.length;
    if (!pending) { UI.toast('No home rows set in TV Setup'); return; }
    UI.busy(true);
    var results = [];
    for (var i = 0; i < cats.length; i++) (function (i) {
      var c = cats[i];
      Net.getJSON(trimSlash(c.addon) + '/catalog/' + c.type + '/' + c.id + '.json', function (j) {
        results[i] = { title: c.name, items: (j.metas || []).slice(0, 40) };
        if (--pending === 0) Home.render(results);
      }, function (err) {
        results[i] = null;
        if (--pending === 0) Home.render(results);
      });
    })(i);
  },
  setRows: function (list) {
    Home.rows = []; Home.c = [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].items.length) { Home.rows.push(list[i]); Home.c.push(0); }
    Home.r = 0;
  },
  render: function (list) {
    UI.busy(false);
    if (list) Home.setRows(list);
    if (!Home.rows.length) { $('home').innerHTML = '<div class="row" style="top:40px">Nothing loaded. Check the relay at ' + esc(CFG.relay) + ' (TV Setup open on the phone, or the Cloudflare relay)</div>'; return; }
    var h = '';
    for (var r = 0; r < Home.rows.length; r++) {
      h += '<div class="row" id="row' + r + '"><div class="rowTitle">' + esc(Home.rows[r].title) + '</div><div class="rowTrack" id="track' + r + '">';
      var items = Home.rows[r].items;
      for (var k = 0; k < items.length; k++) {
        var p = items[k].poster ? '<img src="' + viaBridge(items[k].poster, '/img') + '">' : '<div class="ct">' + esc(items[k].name) + '</div>';
        h += '<div class="card" id="card' + r + '_' + k + '" style="left:' + (k * Home.CARD_W) + 'px">' + p + '</div>';
      }
      h += '</div></div>';
    }
    $('home').innerHTML = h;
    Home.paint();
  },
  paint: function () {
    var top = Math.max(0, Home.r - 0) * Home.ROW_H;
    for (var r = 0; r < Home.rows.length; r++) {
      var row = $('row' + r); row.style.top = (r * Home.ROW_H - top) + 'px';
      row.className = 'row' + (r === Home.r ? '' : ' dim');
      var off = Math.max(0, Home.c[r] - 2) * Home.CARD_W;
      $('track' + r).style.left = (-off) + 'px';
      for (var k = 0; k < Home.rows[r].items.length; k++) $('card' + r + '_' + k).className = 'card' + (r === Home.r && k === Home.c[r] ? ' focus' : '');
    }
    var it = Home.cur(); UI.crumb(it ? it.name : '');
  },
  cur: function () { var row = Home.rows[Home.r]; return row ? row.items[Home.c[Home.r]] : null; },
  key: function (k) {
    if (!Home.rows.length) { if (k === tvKey.KEY_ENTER) Home.load(); return; }
    var n = Home.rows[Home.r].items.length;
    if (k === tvKey.KEY_LEFT && Home.c[Home.r] > 0) Home.c[Home.r]--;
    else if (k === tvKey.KEY_RIGHT && Home.c[Home.r] < n - 1) Home.c[Home.r]++;
    else if (k === tvKey.KEY_UP && Home.r > 0) Home.r--;
    else if (k === tvKey.KEY_DOWN && Home.r < Home.rows.length - 1) Home.r++;
    else if (k === tvKey.KEY_ENTER) { var it = Home.cur(); if (it) Detail.open(it); return; }
    else return;
    Home.paint();
  }
};

/* ---------------- Detail: info + seasons/episodes + streams ---------------- */
var Detail = {
  meta: null, list: [], f: 0, mode: 'eps', season: null, epTitle: '',
  open: function (item) {
    App.push('detail');
    Detail.meta = item; Detail.list = []; Detail.f = 0;
    Detail.header(item);
    $('dList').innerHTML = '';
    UI.busy(true);
    Net.getJSON(trimSlash(CFG.metaAddon) + '/meta/' + item.type + '/' + item.id + '.json', function (j) {
      UI.busy(false);
      Detail.meta = j.meta || item; Detail.header(Detail.meta);
      if (Detail.meta.type === 'series' && Detail.meta.videos && Detail.meta.videos.length) Detail.seasons();
      else Detail.streams(Detail.meta.id, Detail.meta.name);
    }, function (e) {
      UI.busy(false);
      if (item.type === 'movie') Detail.streams(item.id, item.name); else UI.toast('Could not load details (' + e + ')');
    });
  },
  header: function (m) {
    $('dTitle').innerHTML = esc(m.name);
    var bits = []; if (m.releaseInfo || m.year) bits.push(m.releaseInfo || m.year); if (m.imdbRating) bits.push('IMDb ' + m.imdbRating); if (m.runtime) bits.push(m.runtime);
    if (m.genres && m.genres.length) bits.push(m.genres.slice(0, 3).join(', '));
    $('dMeta').innerHTML = esc(bits.join('  |  '));
    $('dDesc').innerHTML = esc(m.description || '');
    $('dBackdrop').style.backgroundImage = m.background ? 'url(' + viaBridge(m.background, '/img') + ')' : 'none';
    UI.crumb('');
  },
  seasons: function () {
    var seen = {}, out = [], v = Detail.meta.videos;
    for (var i = 0; i < v.length; i++) { var s = v[i].season; if (s != null && !seen[s]) { seen[s] = 1; out.push(s); } }
    out.sort(function (a, b) { if (a === 0) return 1; if (b === 0) return -1; return a - b; });
    Detail.mode = 'seasons';
    Detail.list = [];
    for (var k = 0; k < out.length; k++) Detail.list.push({ label: out[k] === 0 ? 'Specials' : 'Season ' + out[k], season: out[k] });
    Detail.f = 0; Detail.paint();
  },
  episodes: function (season) {
    var v = Detail.meta.videos, eps = [];
    for (var i = 0; i < v.length; i++) if (v[i].season === season) eps.push(v[i]);
    eps.sort(function (a, b) { return (a.episode || a.number || 0) - (b.episode || b.number || 0); });
    Detail.mode = 'eps'; Detail.season = season; Detail.list = [];
    for (var k = 0; k < eps.length; k++) {
      var e = eps[k], n = e.episode || e.number;
      Detail.list.push({ label: 'E' + n + '  ' + (e.name || e.title || ''), id: e.id || (Detail.meta.id + ':' + season + ':' + n), ep: 'S' + season + 'E' + n });
    }
    Detail.f = 0; Detail.paint();
  },
  streams: function (id, title) {
    Detail.mode = 'streams'; Detail.epTitle = title; Detail.list = [{ label: 'Searching ' + CFG.streamAddons.length + ' source(s)...', head: true }]; Detail.f = 0; Detail.paint();
    var type = Detail.meta.type === 'series' ? 'series' : 'movie', pending = CFG.streamAddons.length, all = [];
    Detail.errs = []; Detail.raw = 0;
    if (!pending) { Detail.list = [{ label: 'No stream addons set in TV Setup', head: true }]; Detail.paint(); return; }
    for (var i = 0; i < CFG.streamAddons.length; i++) (function (base) {
      Net.getJSON(trimSlash(base) + '/stream/' + type + '/' + id + '.json', function (j) {
        var s = j.streams || [];
        Detail.raw += s.length;
        for (var k = 0; k < s.length; k++) if (s[k].url) all.push(s[k]);
        if (--pending === 0) Detail.gotStreams(all);
      }, function (err) {
        var host = (base.match(/^https?:\/\/([^\/]+)/) || [])[1] || 'addon';
        Detail.errs.push(host + ': ' + err);
        if (--pending === 0) Detail.gotStreams(all);
      }, true);
    })(CFG.streamAddons[i]);
  },
  score: function (s) {
    var t = ((s.name || '') + ' ' + (s.title || s.description || '')).toLowerCase(), sc = 0;
    /* 2014 H-series: 1080p H.264 plays best. HEVC/4K/HDR/Atmos usually fail or stutter. */
    if (/1080p/.test(t)) sc += 50; else if (/720p/.test(t)) sc += 35; else if (/2160p|4k/.test(t)) sc -= 40;
    if (/hevc|x265|h\.?265/.test(t)) sc -= 60;
    if (/\bhdr|dolby ?vision|\bdv\b/.test(t)) sc -= 40;
    if (/x264|h\.?264|avc/.test(t)) sc += 20;
    if (/\.mp4|web-?dl|webrip/.test(t)) sc += 10;
    if (/remux/.test(t)) sc -= 30;
    if (/cached|\[(rd|tb|ad|pm)\+\]|⚡/i.test(t)) sc += 25;
    return sc;
  },
  gotStreams: function (all) {
    if (!all.length) {
      var why = (CFG.phoneRelay && Net.phoneOk === false) ? 'No streams. Open TV Setup on your phone (Older Samsung, Start sync) so it can look them up, then try again.' : 'No playable streams found';
      Detail.list = [{ label: why, head: true }];
      for (var e = 0; e < Detail.errs.length; e++) Detail.list.push({ label: Detail.errs[e], head: true });
      if (Detail.raw) Detail.list.push({ label: Detail.raw + ' result(s) had no direct link: set up debrid in the addon', head: true });
      if (!Detail.errs.length && !Detail.raw) Detail.list.push({ label: 'The addon returned an empty list (via ' + (Net.phoneOk ? 'phone' : 'Cloudflare') + ')', head: true });
      Detail.paint(); return;
    }
    for (var i = 0; i < all.length; i++) all[i]._sc = Detail.score(all[i]);
    all.sort(function (a, b) { return b._sc - a._sc; });
    Detail.list = [{ label: all.length + ' streams, best match for this TV first', head: true }];
    for (var k = 0; k < all.length && k < 60; k++) {
      var s = all[k], lbl = ((s.name || '').replace(/\n/g, ' ') + '  ' + (s.title || s.description || '').replace(/\n/g, ' ')).substring(0, 110);
      Detail.list.push({ label: lbl, stream: s });
    }
    Detail.f = 1; Detail.paint();
  },
  paint: function () {
    var h = '', first = Math.max(0, Detail.f - 6);
    for (var i = first; i < Detail.list.length && i < first + 9; i++) {
      var it = Detail.list[i];
      h += '<div class="item' + (it.head ? ' head' : '') + (i === Detail.f && !it.head ? ' focus' : '') + '">' + esc(it.label) + '</div>';
    }
    $('dList').innerHTML = h;
  },
  back: function () {
    if (Detail.mode === 'streams' && Detail.meta.type === 'series' && Detail.season != null) { Detail.episodes(Detail.season); return true; }
    if (Detail.mode === 'eps' && Detail.meta.type === 'series') { Detail.season = null; Detail.seasons(); return true; }
    return false;
  },
  key: function (k) {
    var n = Detail.list.length;
    if (k === tvKey.KEY_UP) {
      var f = Detail.f - 1;
      while (f >= 0 && Detail.list[f].head) f--;
      if (f >= 0) Detail.f = f;
      Detail.paint();
    }
    else if (k === tvKey.KEY_DOWN) { if (Detail.f < n - 1) Detail.f++; Detail.paint(); }
    else if (k === tvKey.KEY_ENTER) {
      var it = Detail.list[Detail.f]; if (!it || it.head) return;
      if (Detail.mode === 'seasons') Detail.episodes(it.season);
      else if (Detail.mode === 'eps') Detail.streams(it.id, Detail.meta.name + ' ' + it.ep);
      else if (it.stream) Player.play(it.stream.url, Detail.epTitle || Detail.meta.name);
    }
  }
};

/* ---------------- Search with on-screen keyboard ---------------- */
var Search = {
  keys: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').concat(['SPACE']), f: 0, q: '', COLS: 13,
  open: function () { App.push('search'); Search.paint(); },
  paint: function () {
    $('sQuery').innerHTML = esc(Search.q) + '_';
    var h = '';
    for (var i = 0; i < Search.keys.length; i++) h += '<span class="key' + (i === Search.f ? ' focus' : '') + '"' + (Search.keys[i] === 'SPACE' ? ' style="width:240px"' : '') + '>' + Search.keys[i] + '</span>' + ((i + 1) % Search.COLS === 0 ? '<br>' : '');
    $('sKeys').innerHTML = h;
  },
  run: function (type) {
    if (!Search.q) { UI.toast('Type something first'); return; }
    UI.busy(true);
    Net.getJSON(trimSlash(CFG.metaAddon) + '/catalog/' + type + '/top/search=' + encodeURIComponent(Search.q) + '.json', function (j) {
      App.stack = ['home']; UI.show('home');
      Home.render([{ title: 'Results for "' + Search.q + '"', items: j.metas || [] }]);
    }, function (e) { UI.busy(false); UI.toast('Search failed (' + e + ')'); });
  },
  key: function (k) {
    var n = Search.keys.length, C = Search.COLS;
    if (k === tvKey.KEY_LEFT && Search.f > 0) Search.f--;
    else if (k === tvKey.KEY_RIGHT && Search.f < n - 1) Search.f++;
    else if (k === tvKey.KEY_UP && Search.f >= C) Search.f -= C;
    else if (k === tvKey.KEY_DOWN) Search.f = Math.min(n - 1, Search.f + C);
    else if (k === tvKey.KEY_ENTER) Search.q += Search.keys[Search.f] === 'SPACE' ? ' ' : Search.keys[Search.f];
    else if (k === tvKey.KEY_RED) Search.q = Search.q.substring(0, Search.q.length - 1);
    else if (k === tvKey.KEY_GREEN) { Search.run('movie'); return; }
    else if (k === tvKey.KEY_YELLOW) { Search.run('series'); return; }
    else return;
    Search.paint();
  }
};

/* ---------------- Player: Samsung INFOLINK player plugin ---------------- */
var Player = {
  obj: null, active: false, paused: false, dur: 0, pos: 0, osdTimer: null,
  init: function () {
    Player.obj = $('pluginPlayer');
    if (!Player.obj || !Player.obj.Play) return;
    Player.obj.OnCurrentPlayTime = 'Player.onTime';
    Player.obj.OnStreamInfoReady = 'Player.onInfo';
    Player.obj.OnBufferingStart = 'Player.onBufStart';
    Player.obj.OnBufferingComplete = 'Player.onBufEnd';
    Player.obj.OnRenderingComplete = 'Player.onEnd';
    Player.obj.OnConnectionFailed = 'Player.onFail';
    Player.obj.OnNetworkDisconnected = 'Player.onFail';
    Player.obj.OnRenderError = 'Player.onRenderErr';
    Player.obj.OnStreamNotFound = 'Player.onFail';
  },
  /* streamMode: proxy = relay carries the video; http = relay follows the addon's redirects and
     sends the TV to the plain-http debrid link; resolve = same but keeps https; direct = no relay. */
  url: function (u) {
    var hls = /\.m3u8(\?|$)/i.test(u);
    if (CFG.streamMode && CFG.streamMode !== 'direct') {
      /* Resolve through the phone when it answered recently: the addon's resolve link needs a home IP. */
      if (Net.usePhone() && Net.phoneOk) u = viaBridge(u, '/stream', '&mode=' + CFG.streamMode, CFG.phoneRelay);
      else u = viaBridge(u, '/stream', '&mode=' + CFG.streamMode);
    }
    if (hls) u += '|COMPONENT=HLS';
    return u;
  },
  play: function (u, title) {
    if (!Player.obj || !Player.obj.Play) { UI.toast('Player plugin not available (not running on TV?)'); return; }
    Player.active = true; Player.paused = false; Player.dur = 0; Player.pos = 0;
    document.body.className = 'playing'; $('ui').className = 'hidden';
    $('osdTitle').innerHTML = esc(title);
    try { pluginAPI.setOffScreenSaver(); } catch (e) {}
    try { Player.obj.SetDisplayArea(0, 0, 960, 540); } catch (e) {}
    Player.osd();
    Player.obj.Play(Player.url(u));
  },
  stop: function () {
    try { Player.obj.Stop(); } catch (e) {}
    Player.active = false; document.body.className = ''; $('ui').className = ''; $('osd').className = 'hidden';
    try { pluginAPI.setOnScreenSaver(); } catch (e) {}
  },
  osd: function () {
    $('osd').className = ''; clearTimeout(Player.osdTimer);
    Player.osdTimer = setTimeout(function () { if (!Player.paused) $('osd').className = 'hidden'; }, 4000);
  },
  onTime: function (ms) {
    Player.pos = ms;
    if (!Player.dur) { try { Player.dur = Player.obj.GetDuration(); } catch (e) {} }
    $('osdTime').innerHTML = fmt(ms) + (Player.dur ? ' / ' + fmt(Player.dur) : '');
    $('osdFill').style.width = Player.dur ? Math.min(100, ms / Player.dur * 100) + '%' : '0';
  },
  onInfo: function () { try { Player.dur = Player.obj.GetDuration(); } catch (e) {} },
  onBufStart: function () { $('osdTime').innerHTML = 'Buffering...'; $('osd').className = ''; },
  onBufEnd: function () { Player.osd(); },
  onEnd: function () { Player.stop(); UI.toast('Finished'); },
  onFail: function () {
    Player.stop();
    UI.toast(CFG.streamMode === 'proxy' ? 'Stream failed. Try another source (prefer 1080p x264).' : 'Stream failed. In TV Setup set Video to "Through the relay" and sync again.');
  },
  onRenderErr: function (code) { Player.stop(); UI.toast('TV cannot decode this file (code ' + code + '). Pick a 1080p x264 source.'); },
  key: function (k) {
    var o = Player.obj;
    if (k === tvKey.KEY_RETURN || k === tvKey.KEY_STOP) { Player.stop(); return; }
    if (k === tvKey.KEY_PAUSE || k === tvKey.KEY_PLAY || k === tvKey.KEY_ENTER) {
      if (Player.paused) { o.Resume(); Player.paused = false; } else { o.Pause(); Player.paused = true; }
    }
    else if (k === tvKey.KEY_FF) o.JumpForward(30);
    else if (k === tvKey.KEY_RW) o.JumpBackward(30);
    else if (k === tvKey.KEY_RIGHT) o.JumpForward(10);
    else if (k === tvKey.KEY_LEFT) o.JumpBackward(10);
    Player.osd();
  }
};

/* ---------------- App shell ---------------- */
var App = {
  stack: ['home'],
  push: function (id) { App.stack.push(id); UI.show(id); },
  pop: function () {
    if (App.stack.length <= 1) return false;
    App.stack.pop(); var id = App.stack[App.stack.length - 1]; UI.show(id);
    if (id === 'home') Home.paint();
    return true;
  },
  init: function () {
    try {
      pluginAPI.unregistKey(tvKey.KEY_VOL_UP); pluginAPI.unregistKey(tvKey.KEY_VOL_DOWN); pluginAPI.unregistKey(tvKey.KEY_MUTE);
      pluginAPI.registKey(tvKey.KEY_RED); pluginAPI.registKey(tvKey.KEY_GREEN); pluginAPI.registKey(tvKey.KEY_YELLOW); pluginAPI.registKey(tvKey.KEY_BLUE);
    } catch (e) {}
    Player.init();
    $('anchor').focus();
    if (widgetAPI) widgetAPI.sendReadyEvent();
    Home.load();
  },
  keyDown: function () {
    var k = event.keyCode;
    if (k === tvKey.KEY_EXIT) { if (Player.active) Player.stop(); return; }
    if (k === tvKey.KEY_RETURN && widgetAPI) widgetAPI.blockNavigation(event);
    if (Player.active) { Player.key(k); return; }
    var top = App.stack[App.stack.length - 1];
    if (k === tvKey.KEY_RETURN) {
      if (top === 'detail' && Detail.back()) return;
      if (!App.pop() && widgetAPI) widgetAPI.sendReturnEvent();
      return;
    }
    if (k === tvKey.KEY_BLUE && top !== 'search') { Search.open(); return; }
    if (top === 'home') Home.key(k);
    else if (top === 'detail') Detail.key(k);
    else if (top === 'search') Search.key(k);
  }
};
