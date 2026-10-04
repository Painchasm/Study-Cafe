/* =====================================================================
   supabase.js  —  login + cloud sync for Coffee Can Cure Me
   ---------------------------------------------------------------------
   1) The two values below are the ONLY things you ever need to edit.
   2) Only the PUBLIC (publishable / anon) key goes here. NEVER put a
      "service_role" or "secret" key in this file.
   ===================================================================== */

const SUPABASE_URL = "https://somsqiopyyxidwlwcbun.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_GIoam1XN5SnH6UdqtzwDpg_guvqWz5M";

/* ---------------------------------------------------------------------
   Everything below is the plumbing. You don't need to change it.
   --------------------------------------------------------------------- */
(function () {
  'use strict';

  var AUTH_KEY = 'ccm-auth';          // where Supabase keeps the login session
  var BUCKET = 'user-files';          // private Storage bucket (made by the SQL script)
  var CONFIGURED = !/YOUR_SUPABASE/.test(SUPABASE_URL + SUPABASE_ANON_KEY);
  var REDIRECT = location.origin + location.pathname;   // where email links send people back

  var CC = window.CC = { uid: null, email: '', name: '', recovering: false };

  /* ---------- tiny helpers ---------- */
  var ls = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- 1. who is logged in? (answered instantly, before the app starts) ---------- */
  try {
    var saved = JSON.parse(ls.get(AUTH_KEY) || 'null');
    if (saved && saved.user && saved.user.id) {
      CC.uid = saved.user.id;
      CC.email = saved.user.email || '';
      CC.name = (saved.user.user_metadata && saved.user.user_metadata.name) || '';
    }
  } catch (e) {}
  CC.dbName = CC.uid ? 'ccm-files:' + CC.uid : 'ccm-files:anon';   // each user gets their own file database
  if (!CC.uid) document.documentElement.classList.add('cc-out');    // hides the app until login

  var K = CC.uid ? 'pb-v4:' + CC.uid : null;            // this user's saved study data (local copy)
  var K_SYNC = 'cc-synced:' + CC.uid;                   // cloud version our local copy is based on
  var K_DIRTY = 'cc-dirty:' + CC.uid;                   // "there are changes not yet uploaded"
  var K_PEND = 'cc-pend:' + CC.uid;                     // files waiting to be uploaded

  /* ---------- 2. the Supabase connection ---------- */
  var sb = null;
  if (CONFIGURED && window.supabase && window.supabase.createClient) {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { storageKey: AUTH_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
    });
  }
  CC.client = sb;

  /* ---------- status pill (only shown when something is wrong) ---------- */
  var statusText = 'Not synced yet';
  function setStatus(text, isErr) {
    statusText = text;
    var el = $('cc-st'); if (el) el.textContent = text;
    var p = $('cc-pill');
    if (p) { p.textContent = text; p.style.display = isErr ? 'block' : 'none'; }
  }

  /* ---------- 3. syncing the main study data (the big JSON) ---------- */
  var saveTimer = null, pushing = false, retryTimer = null;

  CC.dirty = function () {                               // the app calls this after every save()
    if (!CC.uid) return;
    ls.set(K_DIRTY, '1');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(push, 1500);
  };

  async function fetchMeta() {
    var r = await sb.from('app_state').select('updated_at').eq('user_id', CC.uid).maybeSingle();
    return { row: r.data, error: r.error };
  }

  async function push() {
    if (!CC.uid || !sb || pushing) return;
    pushing = true;
    try {
      // Safety net: a device that has never synced must NOT overwrite an existing cloud copy.
      if (!ls.get(K_SYNC)) {
        var m = await fetchMeta();
        if (m.error) throw m.error;
        if (m.row) { offerLoad(); return; }
      }
      var raw = ls.get(K);
      if (!raw) return;
      var r = await sb.from('app_state').upsert({ user_id: CC.uid, data: JSON.parse(raw) }, { onConflict: 'user_id' }).select('updated_at').single();
      if (r.error) throw r.error;
      ls.set(K_SYNC, r.data.updated_at);
      if (ls.get(K) === raw) ls.del(K_DIRTY); else { clearTimeout(saveTimer); saveTimer = setTimeout(push, 800); }
      setStatus('☁ All changes saved', false);
    } catch (e) {
      console.warn('Cloud save failed:', e);
      setStatus('⚠ Could not save to the cloud — will retry', true);
      clearTimeout(retryTimer); retryTimer = setTimeout(push, 20000);
    } finally { pushing = false; }
  }
  CC.syncNow = async function () { clearTimeout(saveTimer); await push(); await processFiles(); };

  function offerLoad() {
    if ($('cc-newer')) return;
    var d = document.createElement('div');
    d.id = 'cc-newer';
    d.innerHTML = '☁ Newer data from another device is available. <button class="pri" data-cc="loadcloud">Load it</button> <button data-cc="hidenewer">Not now</button>';
    document.body.appendChild(d);
  }
  async function loadFromCloud() {
    var r = await sb.from('app_state').select('data,updated_at').eq('user_id', CC.uid).maybeSingle();
    if (r.error || !r.data) { alert('Could not load the cloud copy right now.'); return; }
    ls.set(K, JSON.stringify(r.data.data));
    ls.set(K_SYNC, r.data.updated_at);
    ls.del(K_DIRTY);
    if (!pend().length) { try { indexedDB.deleteDatabase(CC.dbName); } catch (e) {} }   // re-fetch files fresh from the cloud
    location.reload();
  }

  /* ---------- 4. syncing files (attachments, notebooks, drawings, songs) ---------- */
  var b64 = function (s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  var pathOf = function (k, t) { return CC.uid + '/' + b64(String(k)) + '.' + t; };
  var pend = function () { try { return JSON.parse(ls.get(K_PEND) || '[]'); } catch (e) { return []; } };
  var setPend = function (a) { ls.set(K_PEND, JSON.stringify(a)); };
  var addPend = function (k) { var a = pend(); if (a.indexOf(k) < 0) { a.push(k); setPend(a); } };
  var delPend = function (k) { setPend(pend().filter(function (x) { return x !== k; })); };

  function openDb(name) {
    return new Promise(function (res, rej) {
      var q = indexedDB.open(name, 1);
      q.onupgradeneeded = function () { if (!q.result.objectStoreNames.contains('f')) q.result.createObjectStore('f'); };
      q.onsuccess = function () { res(q.result); };
      q.onerror = function () { rej(q.error); };
    });
  }
  function dbGet(db, k) { return new Promise(function (res, rej) { var q = db.transaction('f').objectStore('f').get(k); q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); }; }); }
  function dbPut(db, k, v) { return new Promise(function (res, rej) { var x = db.transaction('f', 'readwrite'); x.objectStore('f').put(v, k); x.oncomplete = res; x.onerror = function () { rej(x.error); }; }); }
  async function rawGet(k) { var db = await openDb(CC.dbName); try { return await dbGet(db, k); } finally { db.close(); } }
  async function rawPut(k, v) { var db = await openDb(CC.dbName); try { await dbPut(db, k, v); } finally { db.close(); } }

  var fileTimer = null, fbusy = false, missing = {};

  CC.fileUp = function (key) {                           // the app calls this after saving a file locally
    if (!CC.uid || !sb) return;
    delete missing[String(key)];
    addPend(key);
    clearTimeout(fileTimer);
    fileTimer = setTimeout(processFiles, 3000);
  };

  async function processFiles() {
    if (fbusy || !sb || !CC.uid) return;
    fbusy = true;
    try {
      var list = pend();
      for (var i = 0; i < list.length; i++) {
        var key = list[i], v = await rawGet(key);
        if (v === undefined) { delPend(key); continue; }
        var isBlob = v instanceof Blob;
        var body = isBlob ? v : new Blob([JSON.stringify(v)], { type: 'application/json' });
        var up = await sb.storage.from(BUCKET).upload(pathOf(key, isBlob ? 'b' : 'j'), body, { upsert: true, contentType: isBlob ? (v.type || 'application/octet-stream') : 'application/json' });
        if (up.error) throw up.error;
        delPend(key);
      }
    } catch (e) {
      console.warn('File upload failed:', e);
      setStatus('⚠ Some files could not be uploaded — will retry', true);
      clearTimeout(fileTimer); fileTimer = setTimeout(processFiles, 30000);
    } finally { fbusy = false; }
  }

  CC.fileDown = async function (key) {                   // the app calls this when a file is not on this device
    if (!CC.uid || !sb || missing[String(key)]) return undefined;
    var order = /^cvd:|^cvcur$/.test(String(key)) ? ['j', 'b'] : ['b', 'j'];
    for (var i = 0; i < order.length; i++) {
      var r = await sb.storage.from(BUCKET).download(pathOf(key, order[i]));
      if (r.data) {
        var v = r.data;
        if (order[i] === 'j') v = JSON.parse(await r.data.text());
        await rawPut(key, v);
        return v;
      }
    }
    missing[String(key)] = 1;
    return undefined;
  };

  async function legacyFiles() {                         // one-time: move pre-login files into this account
    var flag = 'cc-legacy-files:' + CC.uid;
    if (ls.get(flag) !== 'todo') return;
    try {
      var src = await openDb('ccm-files');
      var keys = await new Promise(function (r, j) { var q = src.transaction('f').objectStore('f').getAllKeys(); q.onsuccess = function () { r(q.result); }; q.onerror = function () { j(q.error); }; });
      for (var i = 0; i < keys.length; i++) {
        var v = await dbGet(src, keys[i]);
        if (v !== undefined) { await rawPut(keys[i], v); addPend(keys[i]); }
        setStatus('Moving your files into your account… ' + (i + 1) + '/' + keys.length, false);
      }
      src.close();
      ls.set(flag, 'done');
      processFiles();
    } catch (e) { console.warn('Legacy file move failed:', e); }
  }

  /* ---------- 5. finishing a login ---------- */
  var completing = false;
  async function completeLogin(user) {
    if (completing) return; completing = true;
    try {
      var uid = user.id, key = 'pb-v4:' + uid;
      var r = await sb.from('app_state').select('data,updated_at').eq('user_id', uid).maybeSingle();
      if (r.error) {
        msg('Logged in, but cloud storage is not ready (' + r.error.message + '). Did you run the SQL script in Supabase?', true);
        await sleep(2500);
      } else if (r.data) {
        if (!(ls.get('cc-dirty:' + uid) && ls.get(key))) {          // keep unsent local changes, otherwise take the cloud copy
          ls.set(key, JSON.stringify(r.data.data));
          ls.set('cc-synced:' + uid, r.data.updated_at);
          ls.del('cc-dirty:' + uid);
        }
      } else {
        // brand-new account: offer to move the data this browser had before accounts existed
        var legacy = ls.get('pb-v4');
        if (legacy && !ls.get('ccm-legacy-owner') && !ls.get(key)) {
          if (confirm('We found study data saved in this browser from before accounts.\n\nMove it into this account?')) {
            ls.set(key, legacy);
            ls.set('ccm-legacy-owner', uid);
            ls.set('cc-legacy-files:' + uid, 'todo');
            ls.set('cc-dirty:' + uid, '1');
          }
        }
      }
    } catch (e) { console.warn(e); }
    location.reload();
  }

  /* ---------- 6. the login screen ---------- */
  var mode = 'in';
  var CSS = '' +
    'html.cc-out .wrap,html.cc-out #fx{display:none!important}' +
    '#cc-auth{position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;padding:20px;background:var(--bg,#e7ecee);overflow:auto}' +
    '#cc-auth.on{display:flex}' +
    '#cc-auth .cb{background:var(--pan,#f4f7f7);color:var(--tx,#4a5560);border-radius:16px;padding:22px;width:100%;max-width:380px;display:flex;flex-direction:column;gap:10px;box-shadow:0 5px 0 var(--sf,#dfe7ea),0 18px 40px #0003}' +
    '#cc-auth h1{font:12px/1.7 "Press Start 2P",monospace;margin:0 0 4px;text-align:center}' +
    '#cc-auth .sub{text-align:center;opacity:.75;font-size:14px;margin:0 0 4px}' +
    '#cc-auth input{width:100%;flex:none;background:var(--bg,#e7ecee);padding:10px 12px}' +
    '#cc-auth button.big{width:100%;padding:10px 12px}' +
    '#cc-auth .lk{background:none;box-shadow:none;text-decoration:underline;padding:2px;font-size:14px;opacity:.85}' +
    '#cc-auth .tabs{display:flex;gap:6px}#cc-auth .tabs button{flex:1}' +
    '#cc-auth .cm{min-height:20px;font-size:14px;text-align:center}#cc-auth .cm.err{color:#c0392b}' +
    '#cc-pill{position:fixed;left:12px;bottom:12px;z-index:2147482000;display:none;background:var(--pan,#fff);color:var(--tx,#333);padding:8px 12px;border-radius:12px;font-size:13px;box-shadow:0 4px 18px #0004}' +
    '#cc-newer{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:2147482000;background:var(--pan,#fff);color:var(--tx,#333);padding:10px 14px;border-radius:14px;font-size:14px;box-shadow:0 4px 18px #0005;display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:center;max-width:94vw}';

  function msg(t, err) { var m = $('cc-msg'); if (m) { m.textContent = t || ''; m.className = 'cm' + (err ? ' err' : ''); } }
  function friendly(e) {
    var t = (e && e.message) || 'Something went wrong.';
    if (/invalid login/i.test(t)) return 'Wrong email or password.';
    if (/not confirmed/i.test(t)) return 'Please confirm your email first — check your inbox.';
    if (/already registered/i.test(t)) return 'That email already has an account. Try logging in.';
    if (/rate limit|too many/i.test(t)) return 'Too many tries. Please wait a minute and try again.';
    if (/fetch|network/i.test(t)) return 'Could not reach Supabase. Check your internet connection.';
    return t;
  }

  function view(m) {
    mode = m;
    var box = $('cc-box'); if (!box) return;
    var h = '';
    if (m === 'in' || m === 'up') {
      h += '<h1>☕ ' + (m === 'in' ? 'Welcome back' : 'Create account') + '</h1><p class="sub">Your study space, saved to your account.</p>';
      h += '<div class="tabs"><button data-cc="tab-in" class="tab ' + (m === 'in' ? 'on' : '') + '">Log in</button><button data-cc="tab-up" class="tab ' + (m === 'up' ? 'on' : '') + '">Sign up</button></div>';
      if (m === 'up') h += '<input id="cc-name" placeholder="Your name (optional)" autocomplete="name" maxlength="40">';
      h += '<input id="cc-email" type="email" placeholder="Email" autocomplete="email">';
      h += '<input id="cc-pw" type="password" placeholder="Password' + (m === 'up' ? ' (at least 8 characters)' : '') + '" autocomplete="' + (m === 'up' ? 'new-password' : 'current-password') + '">';
      h += '<button class="pri big" id="cc-go" data-cc="' + (m === 'in' ? 'login' : 'signup') + '">' + (m === 'in' ? 'Log in' : 'Create account') + '</button>';
      if (m === 'in') h += '<button class="lk" data-cc="tab-forgot">Forgot password?</button>';
    } else if (m === 'forgot') {
      h += '<h1>Reset password</h1><p class="sub">We will email you a reset link.</p><input id="cc-email" type="email" placeholder="Email" autocomplete="email"><button class="pri big" id="cc-go" data-cc="forgot">Send reset link</button><button class="lk" data-cc="tab-in">← Back to log in</button>';
    } else if (m === 'newpw') {
      h += '<h1>New password</h1><p class="sub">Choose a new password for your account.</p><input id="cc-pw" type="password" placeholder="New password (at least 8 characters)" autocomplete="new-password"><button class="pri big" id="cc-go" data-cc="newpw">Save new password</button>' + (CC.uid && !CC.recovering ? '<button class="lk" data-cc="close">Cancel</button>' : '');
    }
    box.innerHTML = h + '<div class="cm" id="cc-msg" role="status"></div>';
    var f = $('cc-email') || $('cc-pw'); if (f) setTimeout(function () { try { f.focus(); } catch (e) {} }, 50);
  }
  function openAuth(m) { var a = $('cc-auth'); if (!a) return; a.classList.add('on'); view(m); }
  function closeAuth() { var a = $('cc-auth'); if (a) a.classList.remove('on'); }

  function busy(on) { var b = $('cc-go'); if (b) b.disabled = !!on; }
  var val = function (id) { var e = $(id); return e ? e.value.trim() : ''; };

  var ACT = {
    'tab-in': function () { view('in'); },
    'tab-up': function () { view('up'); },
    'tab-forgot': function () { view('forgot'); },
    close: closeAuth,
    login: async function () {
      var email = val('cc-email'), pw = $('cc-pw') ? $('cc-pw').value : '';
      if (!email || !pw) return msg('Please enter your email and password.', true);
      busy(1); msg('Logging in…');
      var r = await sb.auth.signInWithPassword({ email: email, password: pw });
      if (r.error) { busy(0); return msg(friendly(r.error), true); }
      completeLogin(r.data.user);
    },
    signup: async function () {
      var email = val('cc-email'), pw = $('cc-pw') ? $('cc-pw').value : '', name = val('cc-name');
      if (!email || !pw) return msg('Please enter an email and a password.', true);
      if (pw.length < 8) return msg('Password must be at least 8 characters.', true);
      busy(1); msg('Creating your account…');
      var r = await sb.auth.signUp({ email: email, password: pw, options: { data: { name: name }, emailRedirectTo: REDIRECT } });
      if (r.error) { busy(0); return msg(friendly(r.error), true); }
      if (r.data.session) return completeLogin(r.data.user);
      busy(0);
      if (r.data.user && r.data.user.identities && r.data.user.identities.length === 0) return msg('That email already has an account. Try logging in.', true);
      msg('Almost done! Check your email and click the confirmation link, then log in.');
    },
    forgot: async function () {
      var email = val('cc-email');
      if (!email) return msg('Please enter your email.', true);
      busy(1); msg('Sending…');
      var r = await sb.auth.resetPasswordForEmail(email, { redirectTo: REDIRECT });
      busy(0);
      if (r.error) return msg(friendly(r.error), true);
      msg('If that email has an account, a reset link is on its way. Open it in this same browser.');
    },
    newpw: async function () {
      var pw = $('cc-pw') ? $('cc-pw').value : '';
      if (pw.length < 8) return msg('Password must be at least 8 characters.', true);
      busy(1); msg('Saving…');
      var r = await sb.auth.updateUser({ password: pw });
      if (r.error) { busy(0); return msg(friendly(r.error), true); }
      msg('Password changed ✓');
      if (CC.uid && !CC.recovering) return setTimeout(closeAuth, 900);
      CC.recovering = false;
      completeLogin(r.data.user);
    },
    changepw: function () { openAuth('newpw'); },
    syncnow: async function () { setStatus('Syncing…', false); await CC.syncNow(); },
    loadcloud: loadFromCloud,
    hidenewer: function () { var n = $('cc-newer'); if (n) n.remove(); },
    logout: async function () {
      try {
        if (ls.get(K_DIRTY)) await Promise.race([push(), sleep(4000)]);
        if (pend().length) await Promise.race([processFiles(), sleep(6000)]);
      } catch (e) {}
      var clean = !ls.get(K_DIRTY) && !pend().length;
      CC.leaving = true;
      try { if (sb) await sb.auth.signOut({ scope: 'local' }); } catch (e) {}
      ls.del(AUTH_KEY);
      if (clean) {                                       // leave nothing behind on a shared device
        ls.del(K); ls.del(K_SYNC); ls.del(K_PEND); ls.del(K_DIRTY);
        try { indexedDB.deleteDatabase(CC.dbName); } catch (e) {}
      }
      location.reload();
    }
  };

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-cc]');
    if (!b) return;
    var f = ACT[b.dataset.cc];
    if (f) { e.preventDefault(); Promise.resolve(f()).catch(function (err) { msg(friendly(err), true); busy(0); }); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.closest && e.target.closest('#cc-auth')) { var g = $('cc-go'); if (g && !g.disabled) g.click(); }
  });

  /* pieces the app uses */
  CC.accountHTML = function () {
    return '<div class="row"><span>Signed in as <b>' + esc(CC.name || CC.email) + '</b></span></div>' +
      (CC.name ? '<small>' + esc(CC.email) + '</small>' : '') +
      '<div class="row"><button data-cc="syncnow">☁ Sync now</button><button data-cc="changepw">Change password</button><button data-cc="logout">🚪 Log out</button></div>' +
      '<small id="cc-st">' + esc(statusText) + '</small>';
  };
  CC.wipe = async function () {                          // used by "Erase everything & start fresh"
    try {
      if (sb && CC.uid) {
        await sb.from('app_state').delete().eq('user_id', CC.uid);
        var l = await sb.storage.from(BUCKET).list(CC.uid, { limit: 1000 });
        if (l.data && l.data.length) await sb.storage.from(BUCKET).remove(l.data.map(function (f) { return CC.uid + '/' + f.name; }));
      }
    } catch (e) { console.warn(e); }
    ls.del(K_SYNC); ls.del(K_DIRTY); ls.del(K_PEND);
    try { indexedDB.deleteDatabase(CC.dbName); } catch (e) {}
  };

  /* ---------- 7. start-up ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var a = document.createElement('div'); a.id = 'cc-auth'; a.innerHTML = '<div class="cb" id="cc-box"></div>'; document.body.appendChild(a);
    var p = document.createElement('div'); p.id = 'cc-pill'; document.body.appendChild(p);

    if (!CONFIGURED) { a.classList.add('on'); $('cc-box').innerHTML = '<h1>Setup needed</h1><p class="sub">Open <b>supabase.js</b> and paste your Supabase URL and public key at the top.</p>'; return; }
    if (!sb) { a.classList.add('on'); $('cc-box').innerHTML = '<h1>Can’t reach Supabase</h1><p class="sub">The login library did not load. Check your internet connection and refresh.</p>'; return; }

    sb.auth.onAuthStateChange(function (ev, session) {
      if (ev === 'PASSWORD_RECOVERY') { CC.recovering = true; openAuth('newpw'); return; }
      if (ev === 'SIGNED_OUT') { if (CC.uid && !CC.leaving) { CC.leaving = true; location.reload(); } return; }
      if ((ev === 'SIGNED_IN' || ev === 'INITIAL_SESSION') && session && session.user) {
        if (!CC.uid) setTimeout(function () { if (!CC.recovering) completeLogin(session.user); }, 400);
        else if (session.user.id !== CC.uid) location.reload();
      }
    });

    if (!CC.uid) { openAuth('in'); return; }

    // already logged in on this device: confirm the session, then sync quietly in the background
    (async function () {
      try {
        var s = await sb.auth.getSession();
        if (!s.data.session) {
          if (navigator.onLine) { ls.del(AUTH_KEY); location.reload(); }
          return;
        }
        CC.email = s.data.session.user.email || CC.email;
        CC.name = (s.data.session.user.user_metadata && s.data.session.user.user_metadata.name) || CC.name;
        var m = await fetchMeta();
        if (m.error) throw m.error;
        if (m.row) {
          if (ls.get(K_DIRTY)) await push();
          else if (m.row.updated_at !== ls.get(K_SYNC)) offerLoad();
          else setStatus('☁ All changes saved', false);
        } else if (ls.get(K)) await push();
        await legacyFiles();
        processFiles();
      } catch (e) {
        console.warn('Background sync failed:', e);
        setStatus('⚠ Could not reach the cloud — your changes are kept on this device and will upload later', true);
      }
    })();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && CC.uid) { if (ls.get(K_DIRTY)) push(); if (pend().length) processFiles(); }
  });
})();
