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

   2. 純前端拿不到 refresh token（Google 不發給沒有後端的應用），所以權杖
      只有一小時，而且**只放在記憶體**（寫進儲存就是把鑰匙留在那台電腦上）。
      為了不要一直跳授權視窗，做了四件事：
        A 使用者按登入時**先試靜默**，失敗才退回強制授權（原本一律強制，
          等於每次都自己叫出「選擇帳戶」畫面）
        B 這個分頁記得上次登入過，開頁面時**自動靜默取一次權杖**，不跳視窗；
          拿不到才顯示登入鈕（不跳授權視窗這條原則沒有變）
        C 到期前五分鐘先換一張，不要等同步時才發現過期（沒登入時不排計時器）
        D 失敗原因分開講：授權過期、瀏覽器擋第三方 cookie、離線
      Google 自己的登入狀態不在了（cookie 被清、在 Google 登出）時仍然要
      重新授權一次，那一條擋不掉。

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

  /* 同步狀態（最後同步時間、信箱、檔案 id）跟資料一樣放**分頁暫存**，
     不進資料檔也不進 localStorage：
       - 不進資料檔：它是「這台跟雲端對過帳沒有」，每台各自不同，跟著匯出檔
         跑會讓另一台誤判
       - 不進 localStorage：裡面有信箱，留在公用電腦上就是痕跡
     放分頁暫存的附帶好處是重新整理還在（B 的自動靜默登入靠它判斷）。 */
  var LOCAL_KEY = 'stickyNotes.drive.v1';

  var AUTO_DELAY = 10000;   // 停止操作 10 秒才上傳（分頁暫存那邊是 1 秒）
  var RENEW_LEAD = 5 * 60 * 1000;   // 到期前五分鐘先換一張（C）

  /* ---------- 狀態 ---------- */

  var st = {
    state: 'out',      // out 未登入 / ok 已同步 / syncing 同步中 / error 失敗 / offline 離線
    msg: '',
    email: '',
    /* 兩個時間分開（v4.30）：
       at      = 最後一次對過帳時「資料本身」的版本時間（跟雲端那份的 updatedAt 比，決策表用）
       syncedAt = 最後一次同步成功的「當下」時間（畫面上顯示「已同步 · N 分鐘前」用）
       以前畫面顯示的是 at，按「立刻同步」時沒有東西要傳，就一直顯示資料最後被改的時間，
       看起來像「同步完成了，時間卻是 30 分鐘前」。 */
    at: '',
    syncedAt: '',
    fileId: '',
    dirty: false
  };

  var token = '';
  var tokenExp = 0;
  var tokenClient = null;
  var ui = {
    onStatus: function () {}, onConflict: function () {}, onResumeFail: function () {},
    // 沒掛的話（測試）一律同意換帳號
    onAccountSwitch: function () { return Promise.resolve(true); }
  };
  var autoTimer = null;
  var renewTimer = null;
  var started = false;

  /* 這個分頁先前登入過沒有。用來決定要不要自動靜默取權杖（B）。 */
  var seenLogin = false;

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
    return { state: st.state, msg: st.msg, email: st.email, at: st.at, syncedAt: st.syncedAt, dirty: st.dirty };
  }

  /* ---------- 這台機器記住的東西 ---------- */

  /* 資料與狀態放同一種儲存（分頁暫存），只有這兩個函式碰它。 */
  function box() {
    try {
      if (window.sessionStorage) {
        window.sessionStorage.setItem('stickyNotes.probe2', '1');
        window.sessionStorage.removeItem('stickyNotes.probe2');
        return window.sessionStorage;
      }
    } catch (e) { /* 不能用就當作沒有狀態可記 */ }
    return null;
  }

  function loadLocal() {
    try {
      var b = box();
      var raw = b && b.getItem(LOCAL_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && typeof o === 'object') {
        st.at = typeof o.at === 'string' ? o.at : '';
        st.syncedAt = typeof o.syncedAt === 'string' ? o.syncedAt : '';
        st.email = typeof o.email === 'string' ? o.email : '';
        st.fileId = typeof o.fileId === 'string' ? o.fileId : '';
        st.dirty = !!o.dirty;
        /* 上次是不是正常離開。正常關閉分頁時會寫成 true；沒寫到就代表
           當掉或直接斷電，那些「沒上傳的變更」要當成可疑的（見 decide）。 */
        seenLogin = !!o.seenLogin;
        if (o.clean === false) st.dirty = true;
      }
    } catch (e) { /* 壞了就當作沒同步過，下次登入重新比對 */ }
  }

  function saveLocal(clean) {
    try {
      var b = box();
      if (!b) return;
      b.setItem(LOCAL_KEY, JSON.stringify({
        at: st.at, syncedAt: st.syncedAt, email: st.email, fileId: st.fileId,
        dirty: st.dirty, seenLogin: seenLogin,
        clean: clean === true ? true : !st.dirty
      }));
    } catch (e) { /* 存不進去只是下次要重新比對，不影響資料 */ }
  }

  function clearLocal() {
    try {
      var b = box();
      if (b) b.removeItem(LOCAL_KEY);
    } catch (e) { /* 清不掉也要繼續登出 */ }
    try { localStorage.removeItem(LOCAL_KEY); } catch (e) { /* 舊版殘留保險再刪 */ }
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
   * 向 Google 要一張權杖。
   * @param {string} prompt ''＝靜默（能不跳就不跳）；'select_account'＝一定跳選擇帳戶
   * @param {string} hint   靜默時指定帳號（login_hint）。瀏覽器裡同時登入好幾個 Google
   *                        帳號時，不指定的話 Google 會用它自己的預設帳號，
   *                        可能不是使用者選的那個（v4.34）
   */
  function askToken(prompt, hint) {
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
            scheduleRenew();
            resolve(token);
          } else {
            reject(new Error(resp && resp.error ? String(resp.error) : '沒有拿到授權'));
          }
        };
        tokenClient.error_callback = function (err) {
          reject(new Error(err && err.type ? String(err.type) : '授權被取消'));
        };
        try {
          var req = { prompt: prompt };
          if (hint) req.login_hint = hint;
          tokenClient.requestAccessToken(req);
        } catch (e) { reject(e); }
      });
    });
  }

  /**
   * 取得存取權杖。
   * @param {boolean} interactive 使用者主動按「登入 Google」時是 true：
   *        **一律跳「選擇帳戶」**（v4.34，使用者 9/27 要的：要自己選或自己輸入帳號）。
   *        以前是「先試靜默、失敗才強制授權」，跳不跳畫面由 Google 決定，
   *        瀏覽器裡已登入的帳號會被直接拿來用，他在無痕視窗實測時就被自動登進 A。
   *        第一次授權的帳號，Google 會在選完帳號後接著跳同意畫面。
   *        false 是背景續期，只試靜默，而且**指定上次選的帳號**（login_hint），
   *        續不到就讓呼叫端顯示需要重新登入。
   */
  function getToken(interactive) {
    if (interactive) return askToken('select_account');
    if (token && now() < tokenExp - 60000) return Promise.resolve(token);
    return askToken('', st.email);
  }

  /* C：到期前五分鐘先換一張。沒登入時一個計時器都不排（11.28）。 */
  function scheduleRenew() {
    if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
    if (st.state === 'out' || !tokenExp) return;
    var wait = tokenExp - RENEW_LEAD - now();
    if (wait < 1000) wait = 1000;
    renewTimer = setTimeout(function () {
      renewTimer = null;
      if (st.state === 'out') return;
      askToken('', st.email).then(function () {
        if (st.state === 'error') setState('ok');
      }, function () {
        /* 續不到就留著現在這張用到過期為止，不在這裡跳提示——
           真的要用時 api() 會回報，訊息也才對得上使用者當下的動作 */
      });
    }, wait);
  }

  /* D：把失敗原因講清楚。原本一律「需要重新登入」，使用者不知道該做什麼。 */
  function explain(e) {
    var m = String(e && e.message ? e.message : e || '');
    if (/popup_closed|access_denied|授權被取消/.test(m)) {
      return { state: 'out', msg: '授權視窗被關掉了，沒有登入' };
    }
    if (/popup_failed_to_open/.test(m)) {
      return { state: 'out', msg: '授權視窗被瀏覽器擋住了，允許彈出式視窗之後再試' };
    }
    if (/idpiframe|third-party|cookie/i.test(m)) {
      return { state: 'error', msg: '瀏覽器擋掉第三方 cookie，沒辦法自動續期，請再按一次登入' };
    }
    if (/需要重新登入|invalid_token|401|unauthorized/i.test(m)) {
      return { state: 'error', msg: '授權過期了，請再按一次登入' };
    }
    if (/Failed to fetch|NetworkError|連不到|離線/i.test(m)) {
      return { state: 'offline', msg: '連不上 Google，本機照常可用，恢復連線會自動補傳' };
    }
    return { state: 'offline', msg: m || '同步失敗' };
  }

  /* 伺服器時間與本機時鐘的差（毫秒，正數＝本機慢）。驗證碼卡用它提醒「時鐘不準」。
     讀的是回應的 Date 標頭——它不在 CORS 預設公開的名單裡，Google 有沒有額外
     公開要看實機；讀不到就一直是 null，驗證碼卡就不提醒（不會亂報）。
     用請求送出與收到的中點當本機時間，扣掉來回的延遲。 */
  var skewMs = null;

  function noteServerTime(r, sentAt) {
    try {
      var d = r.headers.get('Date');
      if (!d) return;
      var server = Date.parse(d);
      if (!isFinite(server)) return;
      var mid = (sentAt + Date.now()) / 2;
      // Date 標頭只到秒，所以誤差本來就有 1 秒上下
      skewMs = server + 500 - mid;
    } catch (e) { /* 讀不到就算了 */ }
  }

  function clockSkew() { return skewMs; }

  function api(url, opt) {
    opt = opt || {};
    return getToken(false).then(function (tk) {
      if (!tk) throw new Error('需要重新登入');
      var headers = opt.headers || {};
      headers.Authorization = 'Bearer ' + tk;
      var sentAt = Date.now();
      return fetch(url, {
        method: opt.method || 'GET',
        headers: headers,
        body: opt.body,
        keepalive: !!opt.keepalive
      }).then(function (r) {
        noteServerTime(r, sentAt);
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

  /**
   * @param {string} localAt  本機資料的 updatedAt
   * @param {string} cloudAt  雲端那份的 updatedAt
   * @param {string} lastAt   這個分頁最後一次同步成功的時間
   * @param {boolean} dirty   本機有沒有還沒上傳的變更
   * @param {boolean} empty   本機是不是空的（剛登入、登出清過、新分頁）
   *
   * **以雲端為主**（使用者選的）：本機沒有未上傳的變更時，雲端不一樣就直接
   * 下載覆蓋，不問、不留快照、不提示。只有本機真的有「還沒上去的東西」才問，
   * 因為那時候安靜覆蓋會吃掉他剛打的字。
   */
  function decide(localAt, cloudAt, lastAt, dirty, empty) {
    if (!cloudAt) return dirty || !empty ? 'up' : 'none';   // 雲端還沒有檔案
    if (empty || !localAt) return 'down';                   // 本機空的：拉下來
    if (localAt === cloudAt) return 'none';

    if (!dirty) {
      /* 本機沒有未上傳的變更，兩邊卻不一樣 → 另一台改過（或這台載入的
         是更早的版本）。以雲端為主，直接下載。 */
      return 'down';
    }

    // 本機有未上傳的變更
    if (!lastAt) return 'conflict';          // 沒對過帳，無從判斷誰新
    if (cloudAt > lastAt) return 'conflict'; // 雲端也動過 → 問一次
    return 'up';                             // 只有這台動過 → 傳上去
  }

  /* ---------- 同步 ---------- */

  /* 上傳途中又改了東西（261003a 修正，10/03 回報「第二張 QR 要匯入兩次」）：
     以前上傳完一律記成「本機版本＝現在的時間、沒有沒上傳的」，但途中改的那一筆
     不在這次送出去的內容裡——下一輪同步看到兩邊時間不同、本機又「沒改過」，
     就拿雲端舊版蓋掉，剛加的帳號消失。網路慢（剛登入時）最容易踩到。
     現在記的是「送出去那一刻」的版本時間，途中有改就保留「還沒上傳」，下一輪照常上傳。 */
  function upload(keepalive) {
    var text = DB.exportJson();
    var sentAt = DB.raw().updatedAt;
    var p = st.fileId
      ? backend.update(st.fileId, text, keepalive)
      : backend.create(text);
    return p.then(function (id) {
      if (id) st.fileId = id;
      st.at = sentAt;
      st.dirty = DB.raw().updatedAt !== sentAt;
      saveLocal();
    });
  }

  /**
   * 雲端那份蓋進來之前，把記憶體裡解開的明文丟掉（v4.30 修正）。
   *
   * 私人卡片與驗證碼卡解鎖後，畫面讀的是記憶體裡的明文（Vault.getPlain），
   * 不是資料檔裡的密文。以前下載覆蓋只換掉密文、明文留著——畫面上照樣看得到
   * 剛加的帳號，其實存檔裡已經是雲端的舊版，重新整理才發現不見了。
   *
   * 同一張卡片（加密設定沒變）：只丟明文，畫面重畫時用同一把金鑰重新解一次。
   * 加密設定變了（另一台重建過）或卡片不見了：整張鎖回去，要重新輸入主密碼。
   */
  function dropStalePlain(text) {
    if (typeof Vault === 'undefined' || !Vault.getPlain) return;
    var incoming = {};
    try {
      ((JSON.parse(text) || {}).tabs || []).forEach(function (t) {
        if (t && t.id) incoming[t.id] = JSON.stringify(t.vault || null);
      });
    } catch (e) { /* 解析失敗的話 importJson 自己會丟錯，這裡不用管 */ }
    (DB.raw().tabs || []).forEach(function (t) {
      if (!t || !Vault.isCardUnlocked(t.id)) return;
      var same = incoming.hasOwnProperty(t.id) &&
                 incoming[t.id] === JSON.stringify(t.vault || null);
      if (same) Vault.setPlain(t.id, null);
      else Vault.lockCard(t.id);
    });
  }

  function applyCloud(text) {
    dropStalePlain(text);
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

        var act = decide(DB.raw().updatedAt, cloudAt, st.at, st.dirty, DB.isEmpty());
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
      if (r !== 'conflict') {
        st.syncedAt = new Date().toISOString();
        saveLocal();
        setState('ok');
      }
      return r;
    }).catch(function (e) {
      var r = explain(e);          // D：把原因講清楚，不要一律「需要重新登入」
      setState(r.state, r.msg);
      return 'error';
    });
  }

  function scheduleAuto() {
    if (DB.isRefreshing && DB.isRefreshing()) return;   // 只是重畫，資料沒變
    st.dirty = true;
    saveLocal(false);    // 記下「有東西還沒上去」，重新整理後還判斷得出來
    /* 未登入時也要記下 dirty（v4.30 修正）。重新整理後自動續登失敗時，
       畫面上的資料還在、照樣能改；以前這段修改不算 dirty，重新登入時決策表
       以為本機沒動過，直接拿雲端的舊版蓋掉，剛改的東西就不見了。
       現在重新登入會照決策表走：雲端沒被別台動過就上傳，動過就問一次。
       未登入時只記、不排上傳。 */
    if (st.state === 'out') { emit(); return; }
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(function () { syncNow(); }, AUTO_DELAY);
    emit();
  }

  /* ---------- 對外 ---------- */

  /**
   * 換帳號（v4.34）。這個分頁原本是 A 的資料、這次選了 B 時，不能直接同步——
   * B 的雲端是空的就會把 A 的資料傳進 B，共用電腦上等於把一個人的東西送進別人帳號。
   * 先問（app.js 的 onAccountSwitch），同意才把 A 的資料從這個分頁清掉、再載入 B 的。
   * A 雲端那份不受影響。
   */
  function switchAccount(prev, email) {
    return ui.onAccountSwitch({ from: prev, to: email, dirty: st.dirty }).then(function (ok) {
      if (!ok) {
        // 不換：丟掉剛拿到的 B 權杖，回到未登入，A 的資料原封不動留在分頁裡
        token = ''; tokenExp = 0;
        if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
        setState('out', '沒有切換帳號，這個分頁的資料還是 ' + prev + ' 的');
        return false;
      }
      if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
      Vault.lockAll();
      DB.wipeLocal();
      // wipeLocal 會發 onChange → scheduleAuto 立起 dirty，這裡要在它之後才歸零
      st.at = ''; st.syncedAt = ''; st.fileId = ''; st.dirty = false;
      return true;
    });
  }

  function signIn() {
    setState('syncing');
    var prev = st.email;
    return backend.signIn().then(function (email) {
      if (prev && email && prev !== email && !DB.isEmpty()) {
        return switchAccount(prev, email).then(function (ok) {
          return ok ? finishSignIn(email) : 'out';
        });
      }
      return finishSignIn(email);
    }).catch(function (e) {
      var r = explain(e);
      st.state = r.state === 'out' ? 'out' : r.state;
      setState(st.state, r.msg);
      return 'error';
    });
  }

  function finishSignIn(email) {
    return Promise.resolve().then(function () {
      if (email && email !== st.email) st.fileId = '';   // 另一個帳號的檔案 id 不能沿用
      st.email = email || st.email;
      st.state = 'ok';
      seenLogin = true;      // 這個分頁登入過，重新整理時可以自動靜默取權杖（B）
      saveLocal();
      scheduleRenew();
      emit();
      return syncNow();
    });
  }

  /**
   * B：開頁面時自動靜默取權杖。
   * 只在「這個分頁先前登入過」時做，而且**不跳任何視窗**——原本那條
   * 「登入一律由使用者按」的決定是為了不要開頁面就被 Google 的視窗擋住，
   * 靜默取權杖沒有這個問題。拿不到就安靜回到未登入，顯示登入鈕。
   */
  function resume() {
    if (!seenLogin || st.state !== 'out') return Promise.resolve('out');
    setState('syncing');
    return askToken('', st.email).then(function () {
      st.state = 'ok';
      scheduleRenew();
      emit();
      return syncNow();
    }, function () {
      setState('out', '尚未登入雲端同步');
      /* 畫面上還有資料時要講出來（v4.30）：使用者看得到東西、以為還在同步，
         其實已經掉回未登入，改的東西要等重新登入才上得去 */
      if (!DB.isEmpty()) ui.onResumeFail();
      return 'out';
    });
  }

  /**
   * 登出＝**資料也跟著消失**。公用電腦上不能只斷開雲端、把內容留在瀏覽器裡。
   *
   * 順序是刻意的：**先把沒上傳的變更傳完，才清掉本機的東西**。
   * 傳不上去（離線、失敗）時不自己決定——回報給呼叫端（app.js）去問使用者，
   * 那裡才有彈窗與「先匯出留底」。
   *
   * @param {Object} opt { force: true } 使用者已經在彈窗裡確認「還是要登出」
   * @returns {Promise<string>} 'done'｜'pending'（有沒上傳的變更，沒清）
   */
  function signOut(opt) {
    opt = opt || {};
    var pending = st.dirty && st.state !== 'out';

    function finish() {
      try {
        if (token && window.google && window.google.accounts && window.google.accounts.oauth2) {
          window.google.accounts.oauth2.revoke(token, function () {});
        }
      } catch (e) { /* 撤銷失敗不影響本機登出 */ }
      token = ''; tokenExp = 0;
      if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
      if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
      st.state = 'out'; st.email = ''; st.fileId = ''; st.at = ''; st.syncedAt = ''; st.dirty = false;
      seenLogin = false;
      /* 最後同步時間也清掉。資料都不留了，留著它沒有意義，而且下次登入
         本機是空的，決策表會直接下載，不會跳衝突。 */
      Vault.lockAll();          // 記憶體裡的金鑰與明文
      DB.wipeLocal();           // 分頁暫存裡的資料 → 回到空白工具
      /* wipeLocal 會發 onChange → scheduleAuto 又立起 dirty、又把同步狀態寫回分頁暫存，
         所以清同步狀態要排在它後面（v4.35 修正；以前 clearLocal 在前面，登出後分頁暫存裡
         留著一筆「有變更還沒上傳」的狀態。switchAccount 早就是這個順序） */
      st.dirty = false;
      clearLocal();
      emit();
      return 'done';
    }

    if (!pending || opt.force) {
      if (!pending) return Promise.resolve(finish());
      // 使用者確認過了：盡力補傳一次，傳不成也照樣清
      return upload().then(finish, finish);
    }

    // 有沒上傳的變更：先試著傳完
    return upload().then(finish, function () {
      setState('offline', '有變更還沒上傳到雲端');
      return 'pending';
    });
  }

  function init(opt) {
    if (opt && opt.onStatus) ui.onStatus = opt.onStatus;
    if (opt && opt.onConflict) ui.onConflict = opt.onConflict;
    if (opt && opt.onResumeFail) ui.onResumeFail = opt.onResumeFail;
    if (opt && opt.onAccountSwitch) ui.onAccountSwitch = opt.onAccountSwitch;
    if (started) { emit(); return; }
    started = true;
    loadLocal();

    // 未登入也要記 dirty（見 scheduleAuto），所以這裡不再擋 out
    DB.onChange(scheduleAuto);
    /* 不重畫的變更（就地編輯文字、改標題、記住高度、連結勾選）不會發 onChange，
       要另外聽 onDirty，否則那些修改不會排上傳（v4.24 修正）。
       一般變更兩個都會發，scheduleAuto 只是把計時器重設一次，沒有副作用。 */
    if (DB.onDirty) {
      DB.onDirty(scheduleAuto);
    }

    window.addEventListener('online', function () {
      if (st.state === 'offline') syncNow();
    });

    /* 關掉分頁前補傳。keepalive 讓請求在頁面消失後仍然送得出去，
       但它有大小限制，所以只在真的有沒傳的變更時才做。
       順手寫一個「正常離開」的記號：下次（工作階段被瀏覽器復原時）才分得出
       上次是正常關閉還是當掉，決定要不要為沒上傳的變更問一次。 */
    window.addEventListener('beforeunload', function () {
      if (st.state !== 'out' && st.dirty && st.fileId) {
        try { upload(true); } catch (e) { /* 來不及就算了，下次開啟會補 */ }
      }
      saveLocal();
    });

    /* B：這個分頁先前登入過就自動靜默取權杖。放在最後面，
       前面的接線都完成了才開始動作。 */
    resume();

    emit();
  }

  window.Drive = {
    CLIENT_ID: CLIENT_ID,
    init: init,
    clockSkew: clockSkew,
    status: status,
    signIn: signIn,
    signOut: signOut,
    resume: resume,
    syncNow: syncNow,
    isSignedIn: function () { return st.state !== 'out'; },
    /* 測試接縫：整組換掉後端就能在沒有網路的環境跑完整流程 */
    _decide: decide,
    _setBackend: function (b) { backend = b; },
    _setState: function (s) { st.state = s; emit(); }
  };
})();
