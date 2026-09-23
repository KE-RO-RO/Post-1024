/* ============================================================
   pip.js — 置頂小視窗（Document Picture-in-Picture）
   ------------------------------------------------------------
   把一張卡片彈成浮在所有視窗最上層的小視窗，其他視窗擋在前面也看得到、
   點得到。這是瀏覽器版唯一能做出「常駐最上層」的辦法。

   幾個必須知道的限制：

   1. 瀏覽器同時只允許存在一個 PiP 視窗。所以是「換一張卡片」，
      不是「再開一個」。
   2. 只有 Chromium 系（Chrome、Edge）有這個 API。不支援時彈出鈕不常駐，
      改由卡片的 ⋯ 選單顯示停用項目並說明原因。
   3. 視窗位置由瀏覽器決定，程式碰不到；大小可以指定，所以我們把它記起來。
   4. 小視窗是**另一份文件**，有自己的 body、樣式表與焦點狀態。
      - 樣式不會自動繼承，要自己把 <link> 與自訂配色的 <style> 搬過去
      - 剪貼簿與提示都必須發生在這份文件上（見 clipboard.js 的註解）
      - 主視窗的 keydown 收不到小視窗的按鍵，複製鍵要另外掛一份

   小視窗刻意是**唯讀**的：只看、複製、勾待辦。編輯、刪除、拖曳、選色都
   不進去——空間小、誤觸代價高，而且編輯彈窗要跨到另一份文件很麻煩。
   實作方式是 tabs.js 的 RO 旗標加上這裡的「預設拒絕」樣式：所有 .icon-btn
   與 .row-add 一律隱藏，只有明確標了 pip-ok 的才顯示。這個方向是刻意的——
   日後新增卡片類型時，忘了標記只會少一顆按鈕，不會在唯讀視窗裡冒出一顆刪除鍵。
   ============================================================ */

(function () {
  'use strict';

  var win = null;        // 小視窗的 window，沒開時是 null
  var curId = null;      // 目前顯示的卡片 id
  var mode = 'pip';      // 'pip' = 置頂（Document PiP）、'win' = 不置頂（一般彈出視窗）
  var hotkeys = {};      // 小視窗自己的複製鍵對照表
  var ui = {};           // 由 app.js 注入的東西
  var sizeTimer = null;

  /* 只有 Document PiP 有「浮在最上層」。這是規範強制的，
     requestWindow() 只有 width、height、disallowReturnToOpener、
     preferInitialWindowPlacement 四個選項，沒有開關可以關掉置頂。
     所以「不置頂」走的是另一種視窗：一般的 window.open。 */
  function supported() {
    return !!window.documentPictureInPicture;
  }

  /** 不置頂視窗任何瀏覽器都開得出來，所以這一種永遠可用。 */
  function windowedSupported() {
    return true;
  }

  function currentMode() {
    return win && !win.closed ? mode : null;
  }

  function isOpen(tab) {
    return !!win && !win.closed && !!tab && tab.id === curId;
  }

  function setUI(obj) { ui = obj || {}; }

  /* ---------- 小視窗自己的樣式 ---------- */

  /** 把主視窗的樣式搬過來。每次重繪都重跑一次，主題或自訂配色改了才跟得上。 */
  function syncTheme() {
    var d = win.document;
    var th = DB.theme();
    // 小視窗專屬的版面規則寫在 style.css 的 :root[data-pip] 區塊裡，
    // 不另外拉一份 CSS 出來（樣式集中在一個檔案，比較不會改了這邊忘了那邊）
    d.documentElement.setAttribute('data-pip', '1');
    // 從資料層讀，不從主視窗的 DOM 讀——資料層才是準的，不必擔心誰先重繪
    d.documentElement.setAttribute('data-theme', th.mode === 'light' ? 'light' : 'dark');
    d.documentElement.setAttribute('data-card-style', th.cardStyle === 'full' ? 'full' : 'line');
    // 顯示大小跟主視窗一致
    var z = DB.uiZoom();
    d.body.style.zoom = z === 1 ? '' : String(z);
    d.documentElement.lang = 'zh-Hant';

    // 主樣式表：用絕對網址，小視窗的相對路徑基準跟主視窗不一定相同
    if (!d.getElementById('pipSheet')) {
      var link = d.createElement('link');
      link.id = 'pipSheet';
      link.rel = 'stylesheet';
      var main = document.querySelector('link[rel="stylesheet"]');
      link.href = main ? main.href : 'css/style.css';
      d.head.appendChild(link);
    }

    // 自訂配色：內容會變，每次都同步
    var srcCustom = document.getElementById('customTheme');
    var dstCustom = d.getElementById('customTheme');
    if (!dstCustom) {
      dstCustom = d.createElement('style');
      dstCustom.id = 'customTheme';
      // 放在自己的樣式後面，權重規則跟主視窗一致
      d.head.appendChild(dstCustom);
    }
    dstCustom.textContent = srcCustom ? srcCustom.textContent : '';
  }

  /* ---------- 小視窗裡的密碼輸入 ---------- */

  /**
   * 加密卡片在小視窗裡也能解鎖。
   * 不能直接呼叫主視窗的解鎖彈窗——主視窗這時多半被其他視窗蓋住，
   * 密碼框會跳在使用者看不到的地方，看起來就像按了沒反應。
   */
  function askPassword(tab) {
    var d = win.document;
    if (d.querySelector('.pip-ask')) return;

    var wrap = d.createElement('div');
    wrap.className = 'pip-ask';

    var box = d.createElement('div');
    box.className = 'pip-ask-box';
    wrap.appendChild(box);

    var h = d.createElement('h3');
    h.textContent = '輸入主密碼';
    box.appendChild(h);

    var input = d.createElement('input');
    input.type = 'password';
    box.appendChild(input);

    var err = d.createElement('div');
    err.className = 'key-err';
    err.hidden = true;
    box.appendChild(err);

    var row = d.createElement('div');
    row.className = 'pip-ask-row';
    box.appendChild(row);

    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }

    var cancel = d.createElement('button');
    cancel.className = 'btn-plain';
    cancel.textContent = '取消';
    cancel.addEventListener('click', close);
    row.appendChild(cancel);

    var ok = d.createElement('button');
    ok.className = 'btn-primary';
    ok.textContent = '解鎖';
    row.appendChild(ok);

    function go() {
      err.hidden = true;
      Vault.unlockCard(tab.id, tab.vault, input.value, ui.autoLockMinutes || 10).then(
        function () {
          close();
          Clip.toast('已解鎖，' + (ui.autoLockMinutes || 10) + ' 分鐘後自動隱藏', false, d);
          DB.touch();
        },
        function () {
          err.textContent = '主密碼不正確';
          err.hidden = false;
          input.select();
        }
      );
    }

    ok.addEventListener('click', go);
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();   // 別讓密碼的每一個字母觸發常用語的複製鍵
      if (e.key === 'Enter') go();
      if (e.key === 'Escape') close();
    });

    d.body.appendChild(wrap);
    input.focus();
  }

  /* ---------- 唯讀的 ctx ---------- */

  function noop() {}

  /* tabs.js 的渲染函式全部透過 ctx 拿外部能力。小視窗給的是一份閹割版：
     會改資料或需要彈窗的一律接成 noop，實際上那些按鈕也不會被畫出來。
     兩層保護是刻意的——樣式漏掉一個選擇器時，點下去也還是沒事。 */
  var pipCtx = {
    readOnly: true,
    // 小視窗是唯讀的，管理選項要回主視窗做；留一個不做事的版本免得漏接
    manageGen: function () {},
    editFormTemplate: function () {},
    manageModes: function () {},
    // 小視窗裡不會有搜尋，也不套用收合（彈出來就是要看內容）
    searching: false,
    // 小視窗裡不會有搜尋，不做高亮
    highlight: null,
    matchRow: function () { return true; },
    registerHotkey: function (key, row, el) {
      if (Object.prototype.hasOwnProperty.call(hotkeys, key)) {
        hotkeys[key] = null;
        return;
      }
      hotkeys[key] = { row: row, el: el };
    },
    confirmDelete: noop,
    confirmDeletePrivate: noop,
    privateEntries: function (tab) { return ui.privateEntries(tab); },
    setPrivateEntries: noop,
    convertPrivate: noop,
    pickTabColor: noop,
    askMoveTab: noop,
    openCardMenu: noop,
    togglePin: noop,
    attachDrag: noop,
    attachRowDrag: noop,
    attachNoteDrag: noop,
    attachItemDrag: noop,
    movePrivate: noop,
    // 便籤的新增與「管理欄位」都在主視窗做；小視窗只能填值與複製
    editNoteItem: noop,
    attachLinkDrag: noop,
    editPhrase: noop,
    editDueItem: noop,
    editLink: noop,
    openLinks: function (list, pick) { ui.openLinks(list, pick); },
    showPopupHelp: noop,
    openCard: function (tab) { askPassword(tab); },
    lockCard: function (tab) { ui.lockCard(tab); },
    savePrivate: noop,
    editPrivate: noop,
    pipSupported: supported,
    isPipped: isOpen,
    pipMode: currentMode,
    togglePip: noop,
    togglePipWindow: noop
  };

  /* ---------- 開關與重繪 ---------- */

  /* 圖釘自繪 SVG（同 11.5）。釘著＝置頂，劃掉＝不置頂。 */
  var PIN_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9.2 3.4h5.6l-1 5.2 2.8 2.8v1.8H7.4v-1.8l2.8-2.8-1-5.2Z"/>' +
    '<path d="M12 13.2V21"/></svg>';

  var PIN_OFF_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9.2 3.4h5.6l-1 5.2 2.8 2.8v1.8H7.4v-1.8l2.8-2.8-1-5.2Z"/>' +
    '<path d="M12 13.2V21"/>' +
    '<path d="M3.6 3.6l16.8 16.8"/></svg>';

  function render() {
    if (!win || win.closed) return;
    var tab = DB.findTab(curId);
    if (!tab) { close(); return; }

    syncTheme();
    var root = win.document.getElementById('pipRoot');
    if (!root) return;
    root.innerHTML = '';
    hotkeys = {};
    var card = Tabs.renderCard(tab, pipCtx);
    root.appendChild(card);

    /* 當場切換置頂／不置頂。做在小視窗自己的標題列上，而不是疊在
       主視窗那顆彈出鈕上——那顆按下去是「彈出」，再承載一種語意就是 11.1。
       填進去的值只在記憶體，換視窗不會掉。 */
    var head = card.querySelector('.card-head');
    if (head) {
      var b = document.createElement('button');
      b.className = 'icon-btn pip-ok pip-mode-btn';
      b.innerHTML = mode === 'pip' ? PIN_SVG : PIN_OFF_SVG;
      b.title = mode === 'pip'
        ? '目前置頂，點一下改成不置頂（會被其他視窗蓋住）'
        : '目前不置頂，點一下改成浮在最上層';
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        switchMode();
      });
      head.appendChild(b);
    }

    win.document.title = tab.title || '未命名';
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey) return;
    var t = e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    var ch = String(e.key || '').toUpperCase();
    if (!/^[0-9A-Z]$/.test(ch)) return;
    if (typing && !e.altKey) return;

    var entry = hotkeys[(e.altKey ? 'ALT+' : '') + ch];
    if (entry) {
      e.preventDefault();
      Clip.copy(entry.row.content, entry.el, entry.row.label, win.document);
    }
  }

  /* 小視窗浮在所有視窗最上層，切去其他視窗打字時它還在那裡。
     失去焦點就把展開的私人項目收回去，只留名稱清單。
     卡片本身的鎖定狀態不動，回來點一下就展開，不必重打密碼。 */
  function onBlur() {
    if (!curId) return;
    var tab = DB.findTab(curId);
    if (!tab || tab.type !== 'private') return;
    Tabs.collapsePrivate(curId);
    render();
  }

  function rememberSize() {
    if (!win || win.closed) return;
    if (sizeTimer) clearTimeout(sizeTimer);
    sizeTimer = setTimeout(function () {
      if (!win || win.closed) return;
      DB.setPipSize(win.innerWidth, win.innerHeight);
    }, 400);
  }

  /* 兩種視窗共用的準備工作：建骨架、掛事件。
     一般彈出視窗可能是重複用同一個視窗（window.open 的名字一樣），
     所以這裡要能重複呼叫而不出事。 */
  function prepareDoc(w) {
    // about:blank 通常已經有 body；沒有的話自己寫一份骨架
    if (!w.document.body) {
      w.document.write('<!doctype html><html><head><meta charset="utf-8">' +
                       '</head><body></body></html>');
      w.document.close();
    }

    if (!w.document.getElementById('pipRoot')) {
      var root = w.document.createElement('div');
      root.id = 'pipRoot';
      w.document.body.appendChild(root);
    }

    // 這份文件要有自己的提示層，不然複製成功的訊息會跑到看不見的主視窗
    if (!w.document.getElementById('toast')) {
      var toastEl = w.document.createElement('div');
      toastEl.id = 'toast';
      toastEl.hidden = true;
      w.document.body.appendChild(toastEl);
    }

    if (!w.__snWired) {
      w.__snWired = true;
      w.addEventListener('pagehide', onWinGone);
      w.addEventListener('resize', rememberSize);
      w.addEventListener('blur', onBlur);
      w.document.addEventListener('keydown', onKeyDown);
    }
  }

  function onWinGone() {
    win = null;
    curId = null;
    hotkeys = {};
    if (ui.onChange) ui.onChange();
  }

  /**
   * 置頂：Document PiP。
   * @param {Function} onFail 開不起來時的退路。從不置頂視窗裡按圖釘切過來時
   *        會用到——那個點擊發生在子視窗上，瀏覽器可能不認為主視窗有使用者
   *        動作，requestWindow 就會被拒。這時候要把原本那個視窗開回來，
   *        不然使用者會落到「兩個都沒有」的狀態。
   */
  function openPip(tab, onFail) {
    if (!supported()) { if (onFail) onFail(); return; }
    var size = DB.pipSize();
    window.documentPictureInPicture.requestWindow({
      width: size.w,
      height: size.h
    }).then(function (w) {
      win = w;
      mode = 'pip';
      curId = tab.id;
      prepareDoc(w);
      render();
      if (ui.onChange) ui.onChange();
    }, function (e) {
      if (onFail) { onFail(e); return; }
      Clip.toast('沒辦法開啟小視窗：' + (e && e.message ? e.message : '未知原因'), true);
    });
  }

  /**
   * 不置頂：一般的彈出視窗。
   * 會被彈出視窗攔截擋掉（跟連結卡一次開多個分頁是同一件事），
   * 擋掉時 window.open 回傳 null——這裡沒有用 noopener，回傳值才判斷得準（11.7）。
   */
  function openWindowed(tab) {
    var size = DB.pipSize();
    var w = null;
    try {
      w = window.open('', 'stickyNotesMini',
        'popup=yes,width=' + size.w + ',height=' + size.h);
    } catch (e) { w = null; }

    if (!w) {
      Clip.toast('不置頂視窗被瀏覽器擋下了，允許彈出式視窗之後再試一次', true);
      return;
    }
    try { w.opener = null; } catch (e) { /* 跨來源時會被拒，忽略 */ }

    win = w;
    mode = 'win';
    curId = tab.id;
    prepareDoc(w);
    render();
    w.focus();
    if (ui.onChange) ui.onChange();
  }

  function open(tab, wantMode) {
    var want = wantMode === 'win' ? 'win' : 'pip';
    if (want === 'pip' && !supported()) return;

    // 已經開著而且是同一種視窗：直接換內容。
    // PiP 同時只准存在一個，重新 requestWindow 會關掉舊的再開，畫面會閃
    if (win && !win.closed && mode === want) {
      curId = tab.id;
      render();
      win.focus();
      if (ui.onChange) ui.onChange();
      return;
    }

    // 換另一種視窗：先收掉舊的（同時只留一個小視窗，不論哪一種）
    if (win && !win.closed) close();

    if (want === 'win') openWindowed(tab);
    else openPip(tab);
  }

  function close() {
    if (win && !win.closed) {
      try { win.removeEventListener('pagehide', onWinGone); } catch (e) { /* 忽略 */ }
      win.close();
    }
    win = null;
    curId = null;
    hotkeys = {};
  }

  function toggle(tab) {
    if (isOpen(tab) && mode === 'pip') { close(); if (ui.onChange) ui.onChange(); return; }
    open(tab, 'pip');
  }

  function toggleWindowed(tab) {
    if (isOpen(tab) && mode === 'win') { close(); if (ui.onChange) ui.onChange(); return; }
    open(tab, 'win');
  }

  /** 小視窗裡的圖釘：當場換另一種視窗，顯示的卡片不變。 */
  function switchMode() {
    var tab = DB.findTab(curId);
    if (!tab) return;

    if (mode === 'pip') { open(tab, 'win'); return; }

    if (!supported()) {
      Clip.toast('這個瀏覽器不支援置頂小視窗', true);
      return;
    }
    // 切成置頂：失敗就把不置頂那個視窗開回來，不要讓兩個都沒有
    if (win && !win.closed) close();
    openPip(tab, function () {
      Clip.toast('這個瀏覽器不讓小視窗自己切成置頂，請用卡片上的彈出鈕', true);
      openWindowed(tab);
    });
  }

  /* 一般彈出視窗不會跟著開啟它的分頁一起消失（PiP 會）。
     主視窗關掉或重新整理時把它收掉，不然它會變成一個沒有人在更新的死畫面。 */
  window.addEventListener('pagehide', function () {
    if (win && !win.closed && mode === 'win') {
      try { win.close(); } catch (e) { /* 忽略 */ }
    }
  });

  /* 刻意不自己訂閱 DB.onChange：主視窗的 render() 會在套好主題與自訂配色
     之後呼叫 PiP.render()。自己訂閱的話會排在主視窗前面跑，抄到的是還沒更新
     的顏色，切換主題時小視窗會慢一拍。 */

  window.PiP = {
    supported: supported,
    windowedSupported: windowedSupported,
    mode: currentMode,
    isOpen: isOpen,
    open: open,
    close: close,
    toggle: toggle,
    toggleWindowed: toggleWindowed,
    switchMode: switchMode,
    render: render,
    setUI: setUI
  };
})();
