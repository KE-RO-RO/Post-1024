/* ============================================================
   pip.js — 小視窗（置頂：Document Picture-in-Picture／不置頂：一般彈出視窗）
   ------------------------------------------------------------
   把卡片彈成另一個小視窗。置頂的那種浮在所有視窗最上層，其他視窗擋在前面
   也看得到、點得到——這是瀏覽器版唯一能做出「常駐最上層」的辦法。

   幾個必須知道的限制：

   1. 瀏覽器同時只允許存在一個 PiP 視窗，所以**置頂小視窗最多一個**，
      裡面可以放好幾張（v4.35 A1：上面一排卡片名稱切換，✕ 移出）。
   2. 三種小視窗（v4.44，使用者 10/11：「整合成三個」）：
      - 置頂小視窗：一個，放好幾張（上面一排分頁）
      - 不置頂小視窗：一個，放好幾張（上面一排分頁）
      - 獨立小視窗：一張卡片一個、可以開好幾個、沒有分頁列；一定是不置頂（置頂只准一個）
      分頁名稱旁的 ⇱ 把那張拉出成獨立小視窗；獨立小視窗標題列的 ⇲ 把它加回置頂／不置頂小視窗。
      一張卡片同時只在一個視窗裡：開去別的視窗就從原本那個搬過去。
   3. 只有 Chromium 系（Chrome、Edge）有 PiP。不支援時 ⋯ 選單的置頂那項停用並說明原因。
   4. 視窗位置由瀏覽器決定（不置頂視窗開第二個以後會往右下錯開）；大小記起來。
   5. 小視窗是**另一份文件**，有自己的 body、樣式表與焦點狀態。
      - 樣式不會自動繼承，要自己把 <link> 與自訂配色的 <style> 搬過去
      - 剪貼簿與提示都必須發生在這份文件上（見 clipboard.js 的註解）
      - 主視窗的 keydown 收不到小視窗的按鍵，複製鍵要另外掛一份

   結構（v4.43）：makeBox() 是「一個視窗」——以前整個檔案只有一份的狀態
   （win、ids、curId、捲動位置、組字中…）現在每個視窗各一份；
   外面那層管所有開著的視窗（boxes）與「卡片在哪個視窗」。

   小視窗刻意是**唯讀**的：只看、複製、勾待辦。編輯、刪除、拖曳、選色都
   不進去——空間小、誤觸代價高，而且編輯彈窗要跨到另一份文件很麻煩。
   實作方式是 tabs.js 的 RO 旗標加上這裡的「預設拒絕」樣式：所有 .icon-btn
   與 .row-add 一律隱藏，只有明確標了 pip-ok 的才顯示。這個方向是刻意的——
   日後新增卡片類型時，忘了標記只會少一顆按鈕，不會在唯讀視窗裡冒出一顆刪除鍵。
   ============================================================ */

(function () {
  'use strict';

  var ui = {};           // 由 app.js 注入的東西
  var boxes = [];        // 開著的小視窗（makeBox 的結果），置頂的最多一個
  var recent = null;     // 最近操作的那個視窗（舊介面 ids()／mode()／_window() 看它）
  var winSeq = 0;        // 一般彈出視窗的名字要每個不同，同名的 window.open 會重複用同一個視窗

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

  function setUI(obj) { ui = obj || {}; }

  /* ---------- 好幾個視窗的管理（v4.43） ---------- */

  function live() {
    boxes = boxes.filter(function (b) { return b.alive(); });
    return boxes;
  }

  function pipBox() {
    return live().filter(function (b) { return b.kind === 'pip'; })[0] || null;
  }

  /** 不置頂小視窗（可以放好幾張的那個），最多一個（v4.44） */
  function winBox() {
    return live().filter(function (b) { return b.kind === 'win'; })[0] || null;
  }

  /** 一般彈出視窗（不置頂小視窗＋獨立小視窗），新開的要往右下錯開 */
  function popupBoxes() {
    return live().filter(function (b) { return b.kind !== 'pip'; });
  }

  /** 這張卡片在哪個視窗裡（一張只會在一個裡面） */
  function boxOf(id) {
    return live().filter(function (b) { return b.has(id); })[0] || null;
  }

  function current() {
    if (recent && recent.alive()) return recent;
    var l = live();
    return l.length ? l[l.length - 1] : null;
  }

  function touchBox(b) {
    recent = b;
  }

  function notify() { if (ui.onChange) ui.onChange(); }

  /** 這張卡片在不在小視窗裡（不一定是正在顯示的那一張），不論哪一種、哪一個 */
  function isOpen(tab) {
    return !!tab && !!boxOf(tab.id);
  }

  /** 這張是不是它所在那個視窗正在顯示的那一張 */
  function isActive(tab) {
    var b = tab && boxOf(tab.id);
    return !!b && b.cur() === tab.id;
  }

  /** 帶卡片：那張在哪一種視窗裡（'pip'／'win'／'solo'／null）。
      不帶：最近操作那個視窗是哪一種，沒開任何視窗是 null（舊介面，app.js 拿來判斷「有沒有開著」） */
  function modeOf(tab) {
    if (tab) { var b = boxOf(tab.id); return b ? b.kind : null; }
    var c = current();
    return c ? c.kind : null;
  }

  function hasPip() { return !!pipBox(); }

  /** 把 id 加到清單最後（已經在裡面就不動），回傳新的清單 */
  function withTab(list, id) {
    var out = (list || []).filter(function (x) { return x !== id && !!DB.findTab(x); });
    var at = (list || []).indexOf(id);
    if (at >= 0) out.splice(Math.min(at, out.length), 0, id);
    else out.push(id);
    return out;
  }

  /* ---------- 一個視窗（v4.43 起每個視窗各一份） ---------- */

  /**
   * @param {string} kind 'pip' = 置頂小視窗（Document PiP）、'win' = 不置頂小視窗、
   *        'solo' = 獨立小視窗（後兩種都是一般彈出視窗；solo 只放一張、沒有分頁列）
   */
  function makeBox(kind) {
    var B = { kind: kind };
    var win = null;        // 這個小視窗的 window
    var ids = [];          // 放在這個視窗裡的卡片（v4.35，A1 名稱切換），順序就是名稱那一排的順序
    var curId = null;      // 目前顯示的那一張
    var hotkeys = {};      // 這個視窗自己的複製鍵對照表
    var sizeTimer = null;
    var dead = false;

    /* 捲動位置（261003a，使用者 10/03 回報「離開小視窗就跳回最上面」）。
       小視窗每次重畫都是整個清掉重建，捲動位置要自己記、自己接回去。
       每張卡片各記一份：切去別張再切回來，回到剛才看的地方。
       scrollShort：上一次重畫時內容暫時比較短（例如雲端下載後 TOTP 先顯示「讀取中…」），
       位置接不回去被瀏覽器壓到上面——這時不要把那個被壓過的位置當成新的記錄，
       下一次內容完整時再接；使用者自己捲動或點了，就以他的為準。 */
    var pipScroll = {};
    var shownId = null;
    var shownDoc = null;   // 上一次畫在哪一份文件：置頂／不置頂互換時是新視窗，不能把新視窗的 0 當成記錄
    var scrollShort = false;

    /* 中文輸入法組字中（拼音／注音打了還沒選字）不能重畫：
       重建搜尋框會把組到一半的字弄壞。先記下來，選完字再畫（261003a） */
    var composing = false;
    var renderPending = false;

    /* 重畫後要把游標放回哪個輸入框（data-keep 的值）。
       重建前游標在有 data-keep 的框裡就記下來；剛新增一筆便籤時也用它把游標放進去 */
    var focusKeep = null;
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
      d.documentElement.setAttribute('data-font', DB.uiFont());
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
        /* 261018a：第一次畫的時候樣式表還沒載好，便籤編輯框是用瀏覽器預設的字級、行高量的，
           量出來比實際內容矮一截（下面幾行被藏在框裡），打字時才突然重量、整頁跳動。
           樣式表、字型到了再量一次 */
        link.addEventListener('load', function () { refitEditors(); });
        d.head.appendChild(link);
        try { if (d.fonts && d.fonts.ready) d.fonts.ready.then(function () { refitEditors(); }); } catch (e) { /* 忽略 */ }
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

    /** 便籤編輯框重新量高度（樣式表載好、字型到了、視窗拉寬拉窄換行變了）。
        fitNoteEditor 自己會把捲動位置接回去，這裡不用重畫整個小視窗 */
    function refitEditors() {
      if (!win || win.closed) return;
      Array.prototype.forEach.call(win.document.querySelectorAll('.nt-pip-edit'), Tabs.fitNoteEditor);
    }

    /* ---------- 小視窗裡的密碼輸入 ---------- */

    /**
     * 加密卡片在小視窗裡也能解鎖。
     * 不能直接呼叫主視窗的解鎖彈窗——主視窗這時多半被其他視窗蓋住，
     * 密碼框會跳在使用者看不到的地方，看起來就像按了沒反應。
     */
    /** 小視窗自己的確認框（261003b：小視窗裡刪便籤一筆）。樣子跟輸入主密碼那個一樣 */
    function askConfirm(title, message, onOk) {
      var d = win.document;
      if (d.querySelector('.pip-ask')) return;
      var wrap = d.createElement('div');
      wrap.className = 'pip-ask';
      var box = d.createElement('div');
      box.className = 'pip-ask-box';
      wrap.appendChild(box);
      var h = d.createElement('h3');
      h.textContent = title;
      box.appendChild(h);
      var msg = d.createElement('div');
      msg.className = 'pip-ask-msg';
      msg.textContent = String(message || '').replace(/<br\s*\/?>/g, '') + '此動作無法復原。';
      box.appendChild(msg);
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
      ok.className = 'btn-danger';
      ok.textContent = '確定刪除';
      ok.addEventListener('click', function () { close(); onOk(); });
      row.appendChild(ok);
      wrap.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Escape') close();
      });
      d.body.appendChild(wrap);
      cancel.focus();      // 預設焦點放在「取消」：手滑按 Enter 不會刪掉
    }

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
        Vault.unlockCard(tab.id, tab.vault, input.value,
          ui.lockMinutesFor ? ui.lockMinutesFor(tab) : (ui.autoLockMinutes || 10)).then(
          function () {
            close();
            if (ui.unlockedToast) ui.unlockedToast(tab, d);
            else Clip.toast('已解鎖，' + (ui.autoLockMinutes || 10) + ' 分鐘後自動鎖定', false, d);
            DB.refresh();     // 解鎖不是修改資料，只重畫（v4.30，主視窗本來就只呼叫 render）
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
      // 便籤在小視窗裡可以刪一筆（261003b）：主視窗的彈窗在這裡看不到，確認框自己畫
      confirmDelete: function (title, message, onOk) { askConfirm(title, message, onOk); },
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
      /* 便籤（261003b，使用者 10/03）：小視窗裡可以直接新增一筆自由格式並開始打字；
         「管理欄位」與新增欄位型別還是在主視窗（小視窗跳不出選型別的彈窗） */
      editNoteItem: function (tab, item) {
        if (item) return;
        var it = { id: DB.uid(), kind: 'free', content: '', open: true, order: (tab.items || []).length };
        tab.items = tab.items || [];
        tab.items.push(it);
        tab.updatedAt = DB.nowIso();
        focusKeep = 'note:' + it.id;     // 畫好之後游標放進新的那一筆
        DB.touch();
      },
      // 小視窗裡打字：主視窗那張稍後跟上（不重畫小視窗本身）
      noteEdited: function (tab) { if (ui.notePipEdited) ui.notePipEdited(tab); },
      editTotp: noop,
      clockSkew: function () { return ui.clockSkew ? ui.clockSkew() : null; },
      // TOTP 卡的名稱搜尋：小視窗裡也要能打字（使用者 10/01 要的），比對規則跟主視窗同一套
      textMatch: function (s, q) { return ui.textMatch ? ui.textMatch(s, q) : true; },
      editPhrase: noop,
      editDueItem: noop,
      openLinks: function (list, pick) { ui.openLinks(list, pick); },
      showPopupHelp: noop,
      openCard: function (tab) { askPassword(tab); },
      lockCard: function (tab) { ui.lockCard(tab); },
      savePrivate: noop,
      editPrivate: noop,
      pipSupported: supported,
      isPipped: isOpen,
      isPipActive: isActive,
      pipMode: modeOf,
      togglePip: noop,
      togglePipWindow: noop,
      togglePipSolo: noop
    };

    /* ---------- 開關與重繪 ---------- */

    /* 圖釘自繪 SVG（同 11.5）。只出現在置頂視窗上（v4.25）。 */
    var PIN_SVG =
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M9.2 3.4h5.6l-1 5.2 2.8 2.8v1.8H7.4v-1.8l2.8-2.8-1-5.2Z"/>' +
      '<path d="M12 13.2V21"/></svg>';

    /** 名稱那一排（A1）：點名稱切換，✕ 把那張移出。兩張以上才出現——只有一張時就是整個視窗 */
    var ASK_MS = 3000;
    var askId = null;      // 按了一下 ✕、等第二下確認的那一張
    var askTimer = null;

    function paintX(x, ask) {
      x.className = 'pip-tab-x' + (ask ? ' ask' : '');
      x.textContent = ask ? '移出？' : '✕';
      x.title = ask ? '再按一次移出（卡片本身不會刪掉）' : '從小視窗移出（要按兩下；卡片本身不會刪掉）';
    }

    /** 收回「移出？」：只改那一顆按鈕，不重畫整個小視窗（不然正在打的字會被吃掉） */
    function clearAsk() {
      if (askTimer) { clearTimeout(askTimer); askTimer = null; }
      if (askId === null) return;
      askId = null;
      try {
        var b = win && !win.closed && win.document.querySelector('.pip-tab-x.ask');
        if (b) paintX(b, false);
      } catch (e) { /* 視窗關了就算了 */ }
    }

    /* 名稱那一排拖曳排序（261003b，使用者 10/03）。
       按住名稱左右拖，放開換位置；移動不到 TAB_DRAG_PX 還是當成「點一下切換」。
       ✕ 不能拖（它是按兩下移出，跟拖曳分開，11.1）。
       順序就是 ids 的順序，只記在記憶體——放哪幾張本來就只記到小視窗關掉為止。 */
    var TAB_DRAG_PX = 5;
    var tabDrag = null;          // { chip, x0, moved }
    var tabClickBlockUntil = 0;  // 剛拖完放開的那一下不要當成點名稱

    function renderTabsBar(root) {
      tabDrag = null;   // 重畫時正在拖的那一顆已經不在了
      if (ids.length < 2) return;
      var d = win.document;
      var bar = d.createElement('div');
      bar.className = 'pip-tabs';
      ids.forEach(function (id) {
        var t = DB.findTab(id);
        if (!t) return;
        var chip = d.createElement('div');
        chip.className = 'pip-tab' + (id === curId ? ' on' : '');
        chip.dataset.tabId = id;

        // 名稱與 ✕ 是兩顆按鈕：點名稱是切換、點 ✕ 是移出，不在同一塊區域（11.1）
        var nm = d.createElement('button');
        nm.className = 'pip-tab-name';
        nm.textContent = t.title || '未命名';
        nm.title = t.title || '未命名';
        nm.addEventListener('click', function () {
          if (Date.now() < tabClickBlockUntil) return;
          if (curId === id) return;
          curId = id;
          touchBox(B);
          render();
        });
        /* 移動與放開聽整份文件：把名稱搬到新位置時（insertBefore）瀏覽器會解除按鈕的
           setPointerCapture，之後的 pointermove 就收不到了 */
        nm.addEventListener('pointerdown', function (e) {
          if (e.button !== 0) return;
          tabDrag = { chip: chip, x0: e.clientX, moved: false };
          d.addEventListener('pointermove', onMove, true);
          d.addEventListener('pointerup', endDrag, true);
          d.addEventListener('pointercancel', endDrag, true);
        });
        var onMove = function (e) {
          var g = tabDrag;
          if (!g || g.chip !== chip) return;
          if (!g.moved) {
            if (Math.abs(e.clientX - g.x0) < TAB_DRAG_PX) return;
            g.moved = true;
            chip.classList.add('dragging');
            clearAsk();
          }
          // 插到第一個「中線在游標右邊」的名稱前面；都沒有就放最後
          var before = null;
          Array.prototype.some.call(bar.children, function (c) {
            if (c === chip) return false;
            var r = c.getBoundingClientRect();
            if (e.clientX < r.left + r.width / 2) { before = c; return true; }
            return false;
          });
          if (before) { if (chip.nextSibling !== before) bar.insertBefore(chip, before); }
          else if (bar.lastChild !== chip) bar.appendChild(chip);
          // 拖到這一排的兩端時，這一排自己往那邊捲
          var bb = bar.getBoundingClientRect();
          if (e.clientX < bb.left + 16) bar.scrollLeft -= 8;
          else if (e.clientX > bb.right - 16) bar.scrollLeft += 8;
        };
        var endDrag = function () {
          d.removeEventListener('pointermove', onMove, true);
          d.removeEventListener('pointerup', endDrag, true);
          d.removeEventListener('pointercancel', endDrag, true);
          var g = tabDrag;
          if (!g || g.chip !== chip) return;
          tabDrag = null;
          if (!g.moved) return;
          tabClickBlockUntil = Date.now() + 300;
          var order = Array.prototype.map.call(bar.children, function (c) { return c.dataset.tabId; });
          ids = order.map(function (k) {
            for (var i = 0; i < ids.length; i++) if (String(ids[i]) === k) return ids[i];
            return null;
          }).filter(function (k) { return k !== null; });
          render();     // 主視窗不用跟著重畫：它只關心「哪幾張在小視窗裡」，順序跟它無關
        };
        chip.appendChild(nm);

        /* ⇱ 拉出來變成獨立小視窗（v4.43，使用者 10/11），這裡的移走。
           一下就拉，不用按兩下：卡片沒有消失，只是換到另一個視窗，按錯了再加回來就好 */
        var out = d.createElement('button');
        out.className = 'pip-tab-out';
        out.textContent = '⇱';
        out.title = '拉出來，變成獨立小視窗';
        out.addEventListener('click', function (e) {
          e.stopPropagation();
          clearAsk();
          popOut(B, id);
        });
        chip.appendChild(out);

        /* 移出要按兩下（261002b）：小視窗很小、✕ 容易誤按。
           第一下變成「移出？」，ASK_MS 之內再按一次才移出；逾時或點別的地方就變回 ✕ */
        var x = d.createElement('button');
        paintX(x, askId === id);
        x.addEventListener('click', function (e) {
          e.stopPropagation();
          if (askId === id) { clearAsk(); remove(id); return; }
          clearAsk();
          askId = id;
          paintX(x, true);
          askTimer = setTimeout(clearAsk, ASK_MS);
        });
        chip.appendChild(x);
        bar.appendChild(chip);
      });
      root.appendChild(bar);
      /* 正在看的那一張捲進畫面（名稱多的時候這一排會橫向捲動）。
         只動這一排自己的橫向捲動：以前用 scrollIntoView，它會連整個小視窗一起往上捲，
         放兩張以上時每次重畫（例如離開小視窗）就跳回最上面（261003a） */
      var on = bar.querySelector('.pip-tab.on');
      if (on) {
        var a = on.getBoundingClientRect(), bb = bar.getBoundingClientRect();
        if (a.left < bb.left) bar.scrollLeft += a.left - bb.left;
        else if (a.right > bb.right) bar.scrollLeft += a.right - bb.right;
      }
    }

    /**
     * @param {object} opt { quiet }：quiet 是「主視窗有不重畫的修改」排過來的（v4.35）。
     *   這時候小視窗如果正有焦點、游標在輸入框裡（例如 TOTP 的搜尋框），就先不重畫——
     *   重建元素會把正在打的字與焦點吃掉（11.20）。下一次重畫時再跟上。
     */
    function render(opt) {
      if (!win || win.closed) return;
      if (opt && opt.quiet) {
        try {
          var ae = win.document.activeElement;
          if (win.document.hasFocus() && ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
        } catch (e) { /* 讀不到就照常重畫 */ }
      }
      // 被刪掉的卡片拿掉；一張都不剩就關視窗
      ids = ids.filter(function (id) { return !!DB.findTab(id); });
      if (!ids.length) { close(); notify(); return; }
      if (ids.indexOf(curId) < 0) curId = ids[0];
      var tab = DB.findTab(curId);
      if (composing) { renderPending = true; return; }
      renderPending = false;

      syncTheme();
      var d = win.document;
      var root = d.getElementById('pipRoot');
      if (!root) return;

      // 重建前：記下捲到哪裡、游標是不是在 TOTP 搜尋框（261003a）
      var sc = d.body;    // 小視窗是 body 在捲（style.css 的 :root[data-pip] body）
      if (shownId !== null && shownDoc === d && !scrollShort) pipScroll[shownId] = sc.scrollTop;
      /* 游標在可以接回的輸入框裡（TOTP 搜尋框、小視窗的便籤）：記下是哪一個、選取到哪裡 */
      var ae = d.activeElement, keep = null;
      if (focusKeep) {
        keep = { key: focusKeep, s: null, e: null };     // 剛新增的那一筆優先
      } else if (ae && ae.dataset && ae.dataset.keep) {
        keep = { key: ae.dataset.keep, s: ae.selectionStart, e: ae.selectionEnd };
      }
      focusKeep = null;

      root.innerHTML = '';
      hotkeys = {};
      renderTabsBar(root);
      var card = Tabs.renderCard(tab, pipCtx);
      root.appendChild(card);
      // 小視窗的便籤編輯框：接進來之後才量得到內容高度（261003b）
      Array.prototype.forEach.call(root.querySelectorAll('.nt-pip-edit'), Tabs.fitNoteEditor);

      /* 重建後：接回捲動位置。以前沒有這一步，內容一變短（「讀取中…」、名稱那一排的捲動）
         就停在最上面 */
      var want = pipScroll[curId] || 0;
      sc.scrollTop = want;
      scrollShort = sc.scrollTop < want - 1;
      shownId = curId;
      shownDoc = d;
      if (scrollShort) {
        // 內容還在長（數字、字型剛到）：下一個畫面再接一次
        var w0 = win, id0 = curId;
        w0.requestAnimationFrame(function () {
          if (win !== w0 || curId !== id0 || !scrollShort) return;
          sc.scrollTop = want;
          scrollShort = sc.scrollTop < want - 1;
        });
      }

      /* 游標放回搜尋框（問題 3：小視窗搜尋時主視窗剛好重畫——剛登入時的解密、下載——
         搜尋框被換成新的、游標掉了，接著按刪除鍵沒反應，畫面卡在搜尋結果）。
         新的搜尋框已經帶著原本打的字，這裡只把游標與選取範圍接回去 */
      if (keep) {
        var ns = Array.prototype.filter.call(root.querySelectorAll('[data-keep]'),
          function (x) { return x.dataset.keep === keep.key; })[0];
        if (ns) {
          try { ns.focus({ preventScroll: keep.s !== null }); } catch (e) { ns.focus(); }
          var at = keep.s === null ? ns.value.length : keep.s;
          try { ns.setSelectionRange(at, keep.e === null ? at : keep.e); } catch (e) { /* 舊瀏覽器不支援就算了 */ }
        }
      }

      /* 當場切換置頂／不置頂。做在小視窗自己的標題列上，而不是疊在
         主視窗那顆彈出鈕上——那顆按下去是「彈出」，再承載一種語意就是 11.1。
         填進去的值只在記憶體，換視窗不會掉。 */
      /* v4.25：只有置頂視窗有圖釘（置頂 → 不置頂）。
         不置頂 → 置頂在 Chrome 上做不到：置頂視窗只能由「剛被點的那個視窗」開，
         而且跟著開它的視窗走——不置頂視窗一關，它開出來的置頂視窗也跟著消失
         （實機確認過，11.57）。所以不置頂視窗不放圖釘，要置頂一律從主視窗的
         ⋯ 選單開（使用者看過三案截圖後選的 C 案；v4.43 起彈出都在 ⋯ 裡）。 */
      var head = card.querySelector('.card-head');
      if (head && kind === 'pip') {
        var b = document.createElement('button');
        b.className = 'icon-btn pip-ok pip-mode-btn';
        b.innerHTML = PIN_SVG;
        b.title = '目前置頂，點一下改成不置頂（會被其他視窗蓋住）';
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          switchMode(B);
        });
        head.appendChild(b);
      }

      /* 獨立小視窗的 ⇲（v4.44，使用者看過 A／B 示意圖選 A）：一顆鈕，點了跳兩個選項
         「加入置頂小視窗」「加入不置頂小視窗」。方向跟分頁上的 ⇱ 相反 */
      closeJoinPop();
      if (head && kind === 'solo') {
        var jb = document.createElement('button');
        jb.className = 'icon-btn pip-ok pip-join-btn';
        jb.textContent = '⇲';
        jb.title = '加入置頂或不置頂小視窗（變成那裡的一個分頁）';
        jb.addEventListener('click', function (e) {
          e.stopPropagation();
          if (win.document.querySelector('.pip-join-pop')) { closeJoinPop(); return; }
          openJoinPop(jb, tab.id);
        });
        head.appendChild(jb);
      }

      win.document.title = tab.title || '未命名';
    }

    /* ⇲ 跳出來的兩個選項。放在 body 底下（不在 #pipRoot 裡）：
       #pipRoot 每次重畫都整個清掉，而且裡面的按鈕是「預設隱藏」（4.12） */
    function closeJoinPop() {
      if (!win || win.closed) return;
      var old = win.document.querySelector('.pip-join-pop');
      if (old) old.parentNode.removeChild(old);
      var on = win.document.querySelector('.pip-join-btn.on');
      if (on) on.classList.remove('on');
    }

    function openJoinPop(btn, id) {
      var d = win.document;
      var pop = d.createElement('div');
      pop.className = 'pip-join-pop';
      var r = btn.getBoundingClientRect();
      pop.style.top = Math.round(r.bottom + 4) + 'px';
      pop.style.right = Math.max(6, Math.round(d.documentElement.clientWidth - r.right)) + 'px';

      /* 置頂小視窗沒開時不能從這裡開：Chrome 的置頂視窗跟著開它的視窗走，
         這個獨立小視窗搬完就關，置頂的會跟著消失（11.57）。所以只能加進已經開著的 */
      var canPip = supported() && !!pipBox();
      var a = d.createElement('button');
      a.textContent = '加入置頂小視窗';
      a.disabled = !canPip;
      a.addEventListener('click', function (e) {
        e.stopPropagation();
        closeJoinPop();
        joinFromSolo(B, id, 'pip');
      });
      pop.appendChild(a);
      if (!canPip) {
        var hint = d.createElement('small');
        hint.textContent = supported() ? '先從主視窗開置頂小視窗' : '這個瀏覽器不支援置頂小視窗';
        pop.appendChild(hint);
      }
      var w2 = d.createElement('button');
      w2.textContent = '加入不置頂小視窗';
      w2.addEventListener('click', function (e) {
        e.stopPropagation();
        closeJoinPop();
        joinFromSolo(B, id, 'win');
      });
      pop.appendChild(w2);
      d.body.appendChild(pop);
      btn.classList.add('on');
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') closeJoinPop();
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
      clearAsk();
      composing = false;     // 視窗失焦時組字一定結束了；保險起見，避免卡在「先不重畫」
      if (!ids.length) return;
      // TOTP 卡不在失焦時遮：使用者一直要在別的視窗輸入驗證碼（v4.26 改成按眼睛手動遮）。
      // 連結收藏（v4.35）展開的那幾筆收回去，放在小視窗裡的每一張都收
      var any = false;
      ids.forEach(function (id) {
        var t = DB.findTab(id);
        if (t && t.type === 'private') { Tabs.collapsePrivate(id); any = true; }
      });
      if (any) render();
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
        // 被點到、切到的視窗就是「最近操作」的那個：「加進不置頂視窗」加到這裡（v4.43）
        w.addEventListener('focus', function () { if (win === w) touchBox(B); });
        w.addEventListener('resize', rememberSize);
        // 視窗拉寬拉窄，便籤每一行換行的位置變了，高度要重量（261018a）
        w.addEventListener('resize', function () { if (win === w) refitEditors(); });
        w.addEventListener('blur', onBlur);
        w.document.addEventListener('keydown', onKeyDown);
        // 點到「移出？」以外的地方就收回（261002b）
        w.document.addEventListener('pointerdown', function (e) {
          var t = e.target;
          if (askId !== null && !(t && t.closest && t.closest('.pip-tab-x.ask'))) clearAsk();
          // ⇲ 的選項：點選項或 ⇲ 本身以外的地方就收起來（v4.44）
          if (!(t && t.closest && t.closest('.pip-join-pop, .pip-join-btn'))) closeJoinPop();
        }, true);
        // 使用者自己捲動、點了：以他現在的位置為準，不再等著接回舊位置（261003a）
        ['wheel', 'pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
          w.document.addEventListener(ev, function () { scrollShort = false; }, { capture: true, passive: true });
        });
        // 輸入法組字中先不重畫，選完字再補畫（261003a）
        w.document.addEventListener('compositionstart', function () { composing = true; }, true);
        w.document.addEventListener('compositionend', function () {
          composing = false;
          if (renderPending) setTimeout(function () { if (!composing) render(); }, 0);
        }, true);
      }
    }

    function onWinGone() {
      clearAsk();
      dead = true;
      win = null;
      ids = [];
      curId = null;
      hotkeys = {};
      pipScroll = {}; shownId = null; shownDoc = null; scrollShort = false;
      composing = false; renderPending = false;
      live();
      notify();
    }

    /** 從這個視窗移出一張（v4.35）。最後一張移出就關掉視窗 */
    function remove(id) {
      var at = ids.indexOf(id);
      if (at < 0) return;
      ids.splice(at, 1);
      if (!ids.length) { close(); notify(); return; }
      if (curId === id) curId = ids[Math.min(at, ids.length - 1)];
      render();
      notify();
    }

    function close() {
      clearAsk();
      dead = true;
      if (win && !win.closed) {
        try { win.removeEventListener('pagehide', onWinGone); } catch (e) { /* 忽略 */ }
        try { win.close(); } catch (e) { /* 忽略 */ }
      }
      win = null;
      ids = [];
      curId = null;
      hotkeys = {};
      live();
    }

    B.alive = function () { return !dead && !!win && !win.closed; };
    B.win = function () { return B.alive() ? win : null; };
    B.ids = function () { return ids.slice(); };
    B.cur = function () { return curId; };
    B.has = function (id) { return B.alive() && ids.indexOf(id) >= 0; };
    B.render = render;
    B.close = close;
    B.remove = remove;
    /** 接上剛開好的視窗 */
    B.attach = function (w, list, id) {
      win = w;
      ids = withTab(list, id);
      curId = id;
      prepareDoc(w);
      render();
    };
    /** 加進來並切到這張（已經在裡面就只是切過去） */
    B.add = function (id) {
      ids = withTab(ids, id);
      curId = id;
      render();
      try { win.focus(); } catch (e) { /* 忽略 */ }
    };
    B.show = function (id) {
      curId = id;
      render();
      try { win.focus(); } catch (e) { /* 忽略 */ }
    };
    /** 搬去別的視窗時從這裡拿掉：跟 remove 一樣，但不通知（由搬的那一方統一通知） */
    B.take = function (id) {
      var at = ids.indexOf(id);
      if (at < 0) return;
      ids.splice(at, 1);
      if (!ids.length) { close(); return; }
      if (curId === id) curId = ids[Math.min(at, ids.length - 1)];
      render();
    };
    return B;
  }

  /* ---------- 開視窗 ---------- */

  /**
   * 置頂：Document PiP。成功才建立視窗，onOk 在接好之後跑（用來把卡片從原本的視窗拿掉）。
   * @param {Function} onFail 開不起來時的退路。從不置頂視窗裡切過來時
   *        會用到——那個點擊發生在子視窗上，瀏覽器可能不認為主視窗有使用者
   *        動作，requestWindow 就會被拒（11.52）。
   */
  function openPipBox(list, id, onOk, onFail) {
    if (!supported()) { if (onFail) onFail(); return; }
    var size = DB.pipSize();
    window.documentPictureInPicture.requestWindow({
      width: size.w,
      height: size.h
    }).then(function (w) {
      var b = makeBox('pip');
      boxes.push(b);
      touchBox(b);
      b.attach(w, list, id);
      if (onOk) onOk();     // 新的接好之後才動舊的（11.72）
      notify();
    }, function (e) {
      if (onFail) { onFail(e); return; }
      Clip.toast('沒辦法開啟小視窗：' + (e && e.message ? e.message : '未知原因'), true);
    });
  }

  /**
   * 一般的彈出視窗（不置頂小視窗、獨立小視窗），每個用不同的名字。
   * 會被彈出視窗攔截擋掉（跟連結一次開多個分頁是同一件事），
   * 擋掉時 window.open 回傳 null——這裡沒有用 noopener，回傳值才判斷得準（11.7）。
   * @param from 點擊發生在哪個小視窗上（圖釘、⇱）：使用者動作是它的，先用它的
   *        window.open 開（11.52）；開不起來再退回主視窗。
   * @return 新的視窗（makeBox），被擋就是 null
   */
  function openWinBox(kind, list, id, from, onOk) {
    var size = DB.pipSize();
    var feat = 'popup=yes,width=' + size.w + ',height=' + size.h;
    /* 已經有一般彈出視窗時，新的往右下錯開，不要整個疊在上一個上面。
       第一個照舊讓瀏覽器決定位置 */
    var prev = popupBoxes();
    var ref = prev.length ? prev[prev.length - 1].win() : null;
    if (ref) {
      try {
        feat += ',left=' + Math.round((ref.screenX || 0) + 32) +
                ',top=' + Math.round((ref.screenY || 0) + 32);
      } catch (e) { /* 讀不到位置就讓瀏覽器決定 */ }
    }
    var name = 'stickyNotesMini' + (++winSeq);
    var w = null;
    if (from && !from.closed) {
      try { w = from.open('', name, feat); } catch (e) { w = null; }
    }
    if (!w) {
      try { w = window.open('', name, feat); } catch (e) { w = null; }
    }

    if (!w) {
      // 從小視窗按的，提示要出現在那個小視窗上，主視窗多半被蓋住（11.26）
      Clip.toast('小視窗被瀏覽器擋下了，允許彈出式視窗之後再試一次', true,
        from && !from.closed ? from.document : undefined);
      return null;
    }
    try { w.opener = null; } catch (e) { /* 跨來源時會被拒，忽略 */ }

    var b = makeBox(kind === 'solo' ? 'solo' : 'win');
    boxes.push(b);
    touchBox(b);
    /* 新的接好之後才動舊的（11.72）：圖釘那條路的 onOk 是關掉置頂視窗，
       而這個新視窗是由置頂視窗 open 出來的——先關置頂再接，這裡碰 w.document 就出錯 */
    b.attach(w, list, id);
    if (onOk) onOk();
    try { w.focus(); } catch (e) { /* 忽略 */ }
    notify();
    return b;
  }

  /* ---------- 主視窗 ⋯ 選單的三個動作 ---------- */

  /* 已經在同一種視窗裡：正在顯示的那張 → 移出；放在裡面但沒在顯示 → 切到它
     （不然要看它就得先到小視窗上面那一排找名稱） */
  function pressSame(b, tab) {
    touchBox(b);
    if (b.cur() === tab.id) { b.remove(tab.id); return; }
    b.show(tab.id);
    notify();
  }

  /** 把卡片搬進一個收納視窗（置頂或不置頂小視窗）：原本在別的視窗就從那裡拿掉 */
  function moveInto(target, id, from) {
    if (from && from !== target) from.take(id);
    touchBox(target);
    target.add(id);
    notify();
  }

  /** 置頂小視窗：不在裡面 → 加入（沒開就開）；在裡面 → 移出或切過去 */
  function toggle(tab) {
    var from = boxOf(tab.id);
    if (from && from.kind === 'pip') { pressSame(from, tab); return; }
    var p = pipBox();
    if (p) { moveInto(p, tab.id, from); return; }
    openPipBox([], tab.id, function () { if (from) from.take(tab.id); });
  }

  /** 不置頂小視窗（v4.44 起只有一個）：不在裡面 → 加入（沒開就開）；在裡面 → 移出或切過去 */
  function toggleWindowed(tab) {
    var from = boxOf(tab.id);
    if (from && from.kind === 'win') { pressSame(from, tab); return; }
    var w = winBox();
    if (w) { moveInto(w, tab.id, from); return; }
    openWinBox('win', [], tab.id, null, function () { if (from) from.take(tab.id); });
  }

  /** 獨立小視窗（v4.44）：還沒獨立開 → 開一個只放這張的（原本在分頁裡就移走）；已經獨立開了 → 關掉 */
  function toggleSolo(tab) {
    var from = boxOf(tab.id);
    if (from && from.kind === 'solo') { from.close(); notify(); return; }
    openWinBox('solo', [], tab.id, null, function () { if (from) from.take(tab.id); });
  }

  /** 分頁名稱旁的 ⇱：拉出成獨立小視窗。點擊在小視窗上，用它的 window.open（11.52）；
      先開新的、接好才從這裡拿掉（11.72） */
  function popOut(b, id) {
    if (!DB.findTab(id)) return;
    openWinBox('solo', [], id, b.win(), function () { b.take(id); });
  }

  /** 獨立小視窗的 ⇲（v4.44）：加入置頂或不置頂小視窗。
      置頂只能加進已經開著的（選單那邊已經擋了，這裡再擋一次）；
      不置頂沒開就由這個獨立小視窗開（一般彈出視窗不會跟著開它的視窗一起關） */
  function joinFromSolo(b, id, want) {
    if (!DB.findTab(id)) return;
    if (want === 'pip') {
      var p = pipBox();
      if (!p) return;
      moveInto(p, id, b);
      return;
    }
    var w = winBox();
    if (w) { moveInto(w, id, b); return; }
    openWinBox('win', [], id, b.win(), function () { b.take(id); });
  }

  /** 置頂小視窗的圖釘：整個換成不置頂。v4.44（使用者選的）：不置頂小視窗已經開著就**併進去**
      （加在後面），沒開就開一個；顯示的那張不變。先接好新的再關舊的（11.72） */
  function switchMode(b) {
    if (b.kind !== 'pip' || !b.alive()) return;
    var cur = b.cur();
    if (!DB.findTab(cur)) return;
    var list = b.ids();
    var w = winBox();
    if (w) {
      list.forEach(function (id) { if (id !== cur) w.add(id); });
      w.add(cur);
      touchBox(w);
      b.close();
      notify();
      return;
    }
    openWinBox('win', list, cur, b.win(), function () { b.close(); });
  }

  /** 舊介面（測試與相容用）：wantMode 'win' 等同「不置頂」那項、其他等同「置頂」那項，
      但已經在那一種視窗裡時只切過去、不移出 */
  function open(tab, wantMode) {
    var want = wantMode === 'win' ? 'win' : (wantMode === 'solo' ? 'solo' : 'pip');
    if (want === 'pip' && !supported()) return;
    var b = boxOf(tab.id);
    if (b && b.kind === want) { touchBox(b); b.show(tab.id); notify(); return; }
    if (wantMode === 'solo') { toggleSolo(tab); return; }
    if (want === 'win') toggleWindowed(tab);
    else toggle(tab);
  }

  /** 全部關掉 */
  function closeAll() {
    live().slice().forEach(function (b) { b.close(); });
    boxes = [];
    recent = null;
  }

  function renderAll(opt) {
    live().slice().forEach(function (b) { b.render(opt); });
  }

  /* 一般彈出視窗不會跟著開啟它的分頁一起消失（PiP 會）。
     主視窗關掉或重新整理時把它們全部收掉，不然會變成沒有人在更新的死畫面。 */
  window.addEventListener('pagehide', function () {
    popupBoxes().forEach(function (b) { b.close(); });
  });

  /* 刻意不自己訂閱 DB.onChange：主視窗的 render() 會在套好主題與自訂配色
     之後呼叫 PiP.render()。自己訂閱的話會排在主視窗前面跑，抄到的是還沒更新
     的顏色，切換主題時小視窗會慢一拍。 */

  window.PiP = {
    supported: supported,
    windowedSupported: windowedSupported,
    mode: modeOf,
    isOpen: isOpen,
    isActive: isActive,
    hasPip: hasPip,
    open: open,
    close: closeAll,
    toggle: toggle,
    toggleWindowed: toggleWindowed,
    toggleSolo: toggleSolo,
    render: renderAll,
    setUI: setUI,
    // 測試與相容用：最近操作那個視窗的卡片清單、window
    ids: function () { var c = current(); return c ? c.ids() : []; },
    _window: function () { var c = current(); return c ? c.win() : null; },
    // 測試用：所有開著的視窗
    _boxes: function () {
      return live().map(function (b) { return { kind: b.kind, ids: b.ids(), cur: b.cur(), win: b.win() }; });
    }
  };
})();
