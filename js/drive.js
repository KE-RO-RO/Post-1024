/* drive.js — Google Drive 同步
   ============================================================
   整份資料存成 appDataFolder 裡的一個 JSON 檔。appDataFolder 是
   每個應用程式專屬的隱藏資料夾：Drive 介面看不到、別的應用程式讀不到，
   而且權限範圍 drive.appdata 被 Google 分類為非敏感，不必送驗證。

   幾個刻意的決定：

   1. 用戶端 ID 寫在程式碼裡。網頁應用程式的用戶端 ID 本來就是公開資訊，
      把關的是 Cloud Console 裡的「已授權的 JavaScript 來源」。設定若存在
      localStorage，系統還原會清掉，等於每天早上要先貼一次才登得進來。
      用戶端密鑰是另一回事，純前端流程用不到，絕對不要寫進來。

   2. 純前端拿不到 refresh token（Google 不發給沒有後端的應用），所以每天
      第一次要重新授權一次。這不是少做，是它的安全設計。

   3. 永遠不自動合併。兩邊都動過就把選擇權交回使用者（見 decide()）。
      自動合併聽起來聰明，但合錯的時候使用者沒辦法還原。

   4. 不做背景輪詢。另一台電腦改了，這台不會自己跳出來——要最新的就重新
      整理或按「立刻同步」。為了很少發生的事讓程式永遠醒著不划算（11.28）。

   測試接縫：backend 物件（getToken / fetchJson / fetchText）可以整組換掉，
   所以資料層與決策邏輯在 Node 與無頭瀏覽器裡都測得到，不必真的連 Google。
   ============================================================ */
(function () {
  'use strict';

  var CLIENT_ID = '480798032696-97d9pql8863j9l7hvsm4djr6b6n6cqbo.apps.googleusercontent.com';

  /* drive.appdata：只能碰自己的隱藏資料夾，碰不到使用者其他檔案。
     email：只為了在面板上顯示登入的是哪個帳號；拿不到也不影響同步。 */
  var SCOPE = 'https://www.googleapis.com/auth/drive.appdata email';

  var FILE_NAME = 'sticky-notes.json';
  var GIS_SRC = 'https://accounts.google.com/gsi/client';

  /* 最後同步時間記在這台機器上，不進資料檔——它是「這台跟雲端對過帳沒有」，
     每台各自不同，跟著匯出檔跑會讓另一台誤判。 */
  var LOCAL_KEY = 'stickyNotes.drive.v1';

  var AUTO_DELAY = 10000;   // 停止操作 10 秒才上傳（localStorage 那邊是 1 秒）

  /* ---------- 狀態 ---------- */

  var st = {
    state: 'out',      // out 未登入 / ok 已同步 / syncing 同步中 / error 失敗 / offline 離線
    msg: '',
    email: '',
    at: '',            // 最後同步成功的時間（ISO）
    fileId: '',
    dirty: false
  };

  var token = '';
  var tokenExp = 0;
  var tokenClient = null;
  var ui = { onStatus: function () {}, onConflict: function () {} };
  var autoTimer = null;
  var started = false;

  function now() { return Date.now(); }

  function emit() {
    try { ui.onStatus(status()); } catch (e) { console.error(e); }
  }

  function setState(s, msg) {
    st.state = s;
    st.msg = msg || '';
    emit();
  }

  function status() {
    return { state: st.state, msg: st.msg, email: st.email, at: st.at, dirty: st.dirty };
  }

  /* ---------- 這台機器記住的東西 ---------- */

  function loadLocal() {
    try {
      var raw = localStorage.getItem(LOCAL_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && typeof o === 'object') {
        st.at = typeof o.at === 'string' ? o.at : '';
        st.email = typeof o.email === 'string' ? o.email : '';
        st.fileId = typeof o.fileId === 'string' ? o.fileId : '';
      }
    } catch (e) { /* 壞了就當作沒同步過，下次登入重新比對 */ }
  }

  function saveLocal() {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify({
        at: st.at, email: st.email, fileId: st.fileId
      }));
    } catch (e) { /* 存不進去只是下次要重新比對，不影響資料 */ }
  }

  /* ---------- 後端（可替換，測試用 stub 換掉整組） ---------- */

  function loadGis() {
    return new Promise(function (resolve, reject) {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        resolve(); return;
      }
      var s = document.createElement('script');
      s.src = GIS_SRC;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('連不到 Google 登入服務')); };
      document.head.appendChild(s);
    });
  }

  /**
   * 取得存取權杖。
   * interactive=true 時允許跳出授權視窗（使用者主動按登入才會是 true）；
   * false 是背景續期，續不到就回 null 讓呼叫端顯示「請重新登入」。
   */
  function getToken(interactive) {
    if (token && now() < tokenExp - 60000) return Promise.resolve(token);
    return loadGis().then(function () {
      return new Promise(function (resolve, reject) {
        if (!tokenClient) {
          tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPE,
            callback: function () {}   // 每次要求前才換掉，見下
          });
        }
        tokenClient.callback = function (resp) {
          if (resp && resp.access_token) {
            token = resp.access_token;
            // expires_in 是秒；沒給就保守算 50 分鐘
            tokenExp = now() + ((resp.expires_in ? resp.expires_in : 3000) * 1000);
            resolve(token);
          } else {
            reject(new Error(resp && resp.error ? String(resp.error) : '沒有拿到授權'));
          }
        };
        tokenClient.error_callback = function (err) {
          reject(new Error(err && err.type ? String(err.type) : '授權被取消'));
        };
        try {
          tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
        } catch (e) { reject(e); }
      });
    });
  }

  function api(url, opt) {
    opt = opt || {};
    return getToken(false).then(function (tk) {
      if (!tk) throw new Error('需要重新登入');
      var headers = opt.headers || {};
      headers.Authorization = 'Bearer ' + tk;
      return fetch(url, {
        method: opt.method || 'GET',
        headers: headers,
        body: opt.body,
        keepalive: !!opt.keepalive
      }).then(function (r) {
        if (r.status === 401) { token = ''; tokenExp = 0; throw new Error('授權過期，請重新登入'); }
        if (!r.ok) throw new Error('Drive 回應 ' + r.status);
        return opt.text ? r.text() : r.json();
      });
    });
  }

  var backend = {
    signIn: function () {
      return getToken(true).then(function () {
        return fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: 'Bearer ' + token }
        }).then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; });
      }).then(function (info) {
        return (info && info.email) ? info.email : '';
      });
    },
    findFile: function () {
      var u = 'https://www.googleapis.com/drive/v3/files' +
              '?spaces=appDataFolder&fields=files(id,modifiedTime)' +
              '&q=' + encodeURIComponent("name='" + FILE_NAME + "'");
      return api(u).then(function (j) {
        return (j && j.files && j.files.length) ? j.files[0].id : '';
      });
    },
    download: function (id) {
      return api('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media', { text: true });
    },
    create: function (text) {
      var boundary = 'sn' + Math.random().toString(36).slice(2);
      var meta = { name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' };
      var body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
                 JSON.stringify(meta) + '\r\n--' + boundary +
                 '\r\nContent-Type: application/json\r\n\r\n' + text + '\r\n--' + boundary + '--';
      return api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
        body: body
      }).then(function (j) { return j && j.id ? j.id : ''; });
    },
    update: function (id, text, keepalive) {
      return api('https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: text,
        keepalive: !!keepalive
      }).then(function () { return id; });
    }
  };

  /* ---------- 決定要做什麼 ----------
     純函式，沒有副作用，所以測得到每一種組合。
     回傳 'none' | 'up' | 'down' | 'conflict'。 */

  function decide(localAt, cloudAt, lastAt) {
    if (!cloudAt) return 'up';                 // 雲端還沒有檔案
    if (!localAt) return 'down';
    if (localAt === cloudAt) return 'none';
    if (!lastAt) return 'conflict';            // 沒對過帳，兩邊又不一樣
    var localChanged = localAt > lastAt;
    var cloudChanged = cloudAt > lastAt;
    if (localChanged && cloudChanged) return 'conflict';
    if (localChanged) return 'up';
    if (cloudChanged) return 'down';
    /* 兩邊都「沒有比上次同步新」，時間戳卻不一樣——代表有一邊倒退了
       （最常見的情況：匯入了一份舊的匯出檔）。這時候自動挑一邊都會
       靜靜吃掉使用者剛剛做的事，所以一律問。 */
    return 'conflict';
  }

  /* ---------- 同步 ---------- */

  function upload(keepalive) {
    var text = DB.exportJson();
    var p = st.fileId
      ? backend.update(st.fileId, text, keepalive)
      : backend.create(text);
    return p.then(function (id) {
      if (id) st.fileId = id;
      st.at = DB.raw().updatedAt;
      st.dirty = false;
      saveLocal();
    });
  }

  function applyCloud(text) {
    DB.importJson(text);                 // 裡面會做完整驗證，壞資料一律丟掉
    st.at = DB.raw().updatedAt;
    st.dirty = false;
    saveLocal();
  }

  /**
   * @param {Object} opt { force: 'up'|'down' }  使用者在衝突彈窗選過之後帶進來
   */
  function syncNow(opt) {
    opt = opt || {};
    if (st.state === 'out') return Promise.resolve('out');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setState('offline', '離線中，恢復連線後會自動補傳');
      return Promise.resolve('offline');
    }
    setState('syncing');

    return backend.findFile().then(function (id) {
      st.fileId = id || st.fileId;
      if (opt.force === 'up') return upload().then(function () { return 'up'; });
      if (!id) return upload().then(function () { return 'up'; });

      return backend.download(id).then(function (text) {
        var cloudAt = '';
        try { cloudAt = (JSON.parse(text) || {}).updatedAt || ''; } catch (e) { cloudAt = ''; }
        if (opt.force === 'down') { applyCloud(text); return 'down'; }
        if (!cloudAt) return upload().then(function () { return 'up'; });  // 雲端那份壞了

        var act = decide(DB.raw().updatedAt, cloudAt, st.at);
        if (act === 'up') return upload().then(function () { return 'up'; });
        if (act === 'down') { applyCloud(text); return 'down'; }
        if (act === 'conflict') {
          setState('error', '兩邊都改過，要選一邊');
          ui.onConflict({ localAt: DB.raw().updatedAt, cloudAt: cloudAt, cloudText: text });
          return 'conflict';
        }
        st.at = cloudAt; st.dirty = false; saveLocal();
        return 'none';
      });
    }).then(function (r) {
      if (r !== 'conflict') setState('ok');
      return r;
    }).catch(function (e) {
      var m = String(e && e.message ? e.message : e);
      setState(/重新登入|授權/.test(m) ? 'error' : 'offline', m);
      return 'error';
    });
  }

  function scheduleAuto() {
    if (st.state === 'out') return;
    st.dirty = true;
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(function () { syncNow(); }, AUTO_DELAY);
    emit();
  }

  /* ---------- 對外 ---------- */

  function signIn() {
    setState('syncing');
    return backend.signIn().then(function (email) {
      st.email = email || st.email;
      st.state = 'ok';
      saveLocal();
      emit();
      return syncNow();
    }).catch(function (e) {
      st.state = 'out';
      setState('out', String(e && e.message ? e.message : e));
      return 'error';
    });
  }

  function signOut() {
    try {
      if (token && window.google && window.google.accounts && window.google.accounts.oauth2) {
        window.google.accounts.oauth2.revoke(token, function () {});
      }
    } catch (e) { /* 撤銷失敗不影響本機登出 */ }
    token = ''; tokenExp = 0;
    st.state = 'out'; st.email = ''; st.fileId = ''; st.dirty = false;
    // 最後同步時間留著：下次登入同一個帳號還用得上，不留會白白多跳一次衝突
    saveLocal();
    emit();
  }

  function init(opt) {
    if (opt && opt.onStatus) ui.onStatus = opt.onStatus;
    if (opt && opt.onConflict) ui.onConflict = opt.onConflict;
    if (started) { emit(); return; }
    started = true;
    loadLocal();

    DB.onChange(function () {
      if (st.state !== 'out') scheduleAuto();
    });

    window.addEventListener('online', function () {
      if (st.state === 'offline') syncNow();
    });

    /* 關掉分頁前補傳。keepalive 讓請求在頁面消失後仍然送得出去，
       但它有大小限制，所以只在真的有沒傳的變更時才做。 */
    window.addEventListener('beforeunload', function () {
      if (st.state !== 'out' && st.dirty && st.fileId) {
        try { upload(true); } catch (e) { /* 來不及就算了，下次開啟會補 */ }
      }
    });

    emit();
  }

  window.Drive = {
    CLIENT_ID: CLIENT_ID,
    init: init,
    status: status,
    signIn: signIn,
    signOut: signOut,
    syncNow: syncNow,
    isSignedIn: function () { return st.state !== 'out'; },
    /* 測試接縫：整組換掉後端就能在沒有網路的環境跑完整流程 */
    _decide: decide,
    _setBackend: function (b) { backend = b; },
    _setState: function (s) { st.state = s; emit(); }
  };
})();
