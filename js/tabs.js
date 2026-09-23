/* ============================================================
   tabs.js — 各分頁類型的卡片渲染與編輯
   ------------------------------------------------------------
   常用語的互動規則（v2.1 修正）：
     整列任何位置點一下 = 複製
     編輯只能從右側的鉛筆進入，開彈窗改標籤與內容
   兩者完全分離、不共用同一塊可點區域，避免想複製卻點成編輯。

   其他分頁類型（便籤、待辦）沒有「點擊複製」行為，
   所以維持原本「點文字就能改」的就地編輯。
   ============================================================ */

(function () {
  'use strict';

  var TYPE_LABEL = {
    note: '便籤',
    quickphrase: '常用語',
    todo: '待辦',
    countdown: '倒數',
    link: '連結',
    codegen: '編碼',
    form: '表單',
    table: '表格',
    private: '私人'
  };

  /* ---------- 就地編輯（非常用語類型使用） ---------- */

  /* 置頂小視窗是唯讀的（只看、複製、勾選）。
     這個旗標在 renderCard 進入時設好，同一次渲染都是同步的，所以模組層級
     的變數就夠用，不必把它一路傳進每個渲染函式。
     編輯的入口幾乎都走 makeEditable，攔在這裡一次就涵蓋標題、便籤、待辦、
     連結名稱、私人小圓標——之後新增的欄位只要也用 makeEditable 就自動適用。 */
  var RO = false;

  /* 這張卡片是不是收合著。跟 RO 一樣在 renderCard 進入時設好。
     收合 = 這張卡片現在不用，所以裡面的複製鍵一併停用，按鍵不會去動
     看不到的內容。搜尋時一律當成展開，所以那時候鍵會回來。 */
  var COL = false;

  /* ============================================================
     搜尋命中高亮
     ------------------------------------------------------------
     由 renderCard 從 ctx 接進來：{ q, qFold, fold }。沒有搜尋時是 null。

     **不用 innerHTML。** 使用者的內容裡只要有 `<` 或 `&` 就會被當成 HTML
     解析，輕則畫面壞掉、重則內容遺失。一律切文字節點再建 <mark>。
     ============================================================ */

  var HL = null;

  function findHits(v) {
    if (!HL || !HL.q) return [];
    var low = v.toLowerCase();
    var out = [];
    var i = low.indexOf(HL.q);
    while (i >= 0) {
      out.push([i, i + HL.q.length]);
      i = low.indexOf(HL.q, i + HL.q.length);
    }
    if (out.length || !HL.fold || !HL.qFold) return out;

    /* 折疊命中（打簡體找到繁體）：原字裡找不到那幾個字，位置要對應回來。
       繁→簡絕大多數一個字對一個字，但有少數冷僻字轉出來的簡體字在
       JavaScript 裡佔兩格。長度只要變了就不標，寧可少標也不標錯位置。 */
    var folded = HL.fold(low);
    if (folded.length !== low.length || HL.qFold.length !== HL.q.length) return out;
    var j = folded.indexOf(HL.qFold);
    while (j >= 0) {
      out.push([j, j + HL.qFold.length]);
      j = folded.indexOf(HL.qFold, j + HL.qFold.length);
    }
    return out;
  }

  /**
   * 把文字填進元素，順便標出搜尋命中。
   * 所有「顯示使用者內容」的地方都走這裡，新增欄位時才不會漏掉高亮。
   */
  function setText(el, text, placeholder, noMark) {
    el.textContent = '';
    var v = text || '';
    if (!v) {
      el.textContent = placeholder || '';
      el.classList.add('placeholder');
      return;
    }
    el.classList.remove('placeholder');

    var hits = noMark ? [] : findHits(v);
    if (!hits.length) { el.textContent = v; return; }

    hits.sort(function (a, b) { return a[0] - b[0]; });
    var pos = 0;
    hits.forEach(function (r) {
      if (r[0] < pos) return;   // 重疊的跳過
      if (r[0] > pos) el.appendChild(document.createTextNode(v.slice(pos, r[0])));
      var m = document.createElement('mark');
      m.textContent = v.slice(r[0], r[1]);
      el.appendChild(m);
      pos = r[1];
    });
    if (pos < v.length) el.appendChild(document.createTextNode(v.slice(pos)));
  }

  function makeEditable(el, getValue, setValue, opt) {
    if (RO) {
      setText(el, getValue(), (opt && opt.placeholder) || '');
      return;
    }
    opt = opt || {};
    el.classList.add('editable');

    function paint() {
      setText(el, getValue(), opt.placeholder || '還沒有內容');
    }
    paint();

    el.addEventListener('click', function (e) {
      e.stopPropagation();
      if (el.dataset.editing === '1') return;
      el.dataset.editing = '1';

      var input = document.createElement(opt.multiline ? 'textarea' : 'input');
      input.className = 'inline-edit';
      input.value = getValue() || '';
      if (opt.multiline) {
        input.rows = Math.min(10, Math.max(2, input.value.split('\n').length + 1));
        /* 使用者手動拉過大小就照他拉的來。瀏覽器會把拖曳結果寫進
           inline style 的 height，所以只要在收工時把它存起來、
           下次開啟時套回去，框就不會每次縮回預設高度。 */
        var saved = opt.getHeight && opt.getHeight();
        if (saved) input.style.height = saved;
      }

      el.textContent = '';
      el.classList.remove('placeholder');
      el.appendChild(input);
      input.focus();
      /* 單行欄位進來多半是整個換掉，全選省一次 Ctrl+A。
         多行不行——便籤是接著往下打的，全選狀態下隨便按一個鍵就整段沒了。
         多行改成把游標放到最後面。 */
      if (opt.multiline) input.setSelectionRange(input.value.length, input.value.length);
      else input.select();

      var cancelled = false;

      function finish() {
        if (el.dataset.editing !== '1') return;
        el.dataset.editing = '0';
        // 高度不管有沒有取消都記下來——那是版面偏好，不是內容
        if (opt.setHeight && input.style.height) opt.setHeight(input.style.height);
        if (!cancelled) setValue(input.value);
        el.innerHTML = '';
        paint();
      }

      input.addEventListener('blur', finish);
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { cancelled = true; input.blur(); }
        if (ev.key === 'Enter' && (!opt.multiline || ev.ctrlKey)) {
          ev.preventDefault();
          input.blur();
        }
        ev.stopPropagation();
      });
    });

    return { refresh: paint };
  }

  function iconBtn(symbol, title, onClick, extraClass) {
    var b = document.createElement('button');
    b.className = 'icon-btn' + (extraClass ? ' ' + extraClass : '');
    b.textContent = symbol;
    b.title = title;
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      onClick(e);
    });
    return b;
  }

  /**
   * 清單列的拖曳把手（v4.24：待辦、倒數、私人卡片的每一筆）。
   * 跟卡片、常用語、便籤、連結同一套：平常隱藏、滑到那一列才浮現，
   * 按住把手才讓那一列變成可拖（7.1）。唯讀（小視窗）時不給。
   */
  function listGrip(rowEl) {
    var g = document.createElement('span');
    g.className = 'li-grip';
    g.textContent = '⠿';
    g.title = '按住拖曳可調整順序';
    g.addEventListener('mousedown', function (e) {
      e.stopPropagation();
      rowEl.draggable = true;
    });
    g.addEventListener('mouseup', function () { rowEl.draggable = false; });
    g.addEventListener('click', function (e) { e.stopPropagation(); });
    return g;
  }

  /* ---------- 卡片外框 ---------- */

  function renderCard(tab, ctx) {
    RO = !!ctx.readOnly;
    HL = ctx.highlight || null;

    var card = document.createElement('div');
    card.className = 'card';
    /* 常用語是主要工作區，橫跨整行，內容才有地方完整呈現。
       編碼卡不需要——它的內容是兩排選項加一個輸入欄，走一般網格反而能跟
       其他卡片咬合，不會像常用語那樣把畫面切成上下兩段（5.1）。 */
    if (tab.type === 'quickphrase') card.classList.add('card-wide');
    card.dataset.tabId = tab.id;
    /* 顏色只寫成 data-color，實際色值由 CSS 依主題與上色方式決定。
       釘選不再給左邊框：細線版的類型色邊也在左側，兩種意思擠在同一條線上
       會分不出來（規格書 11.1）。釘選改成只靠實心 ★ 與排在最前面。 */
    var color = DB.tabColor(tab);
    if (color) card.dataset.color = color;

    /* 搜尋時一律當成展開：畫面上是過濾後的結果，命中的卡片收著等於找到了
       卻看不到。小視窗也忽略收合——彈出來就是要看那張卡片的內容。 */
    var collapsed = !!tab.collapsed && !RO && !ctx.searching;
    COL = collapsed;
    if (collapsed) card.classList.add('is-collapsed');

    var head = document.createElement('div');
    head.className = 'card-head';

    if (!RO) {
      // 拖曳把手：只有這裡能起拖，不然卡片裡選字、點常用語都會誤觸拖曳
      var handle = document.createElement('span');
      handle.className = 'drag-handle';
      handle.textContent = '⠿';
      handle.title = '按住拖曳可調整卡片順序';
      handle.addEventListener('mousedown', function () { card.draggable = true; });
      head.appendChild(handle);
    }

    var type = document.createElement('span');
    type.className = 'card-type';
    if (tab.type === 'private') {
      // 這個標籤純粹是外觀，不是機密，所以鎖著也能改。
      // 讓使用者能換成不起眼的字，避免「私人」兩個字本身就引人注意
      type.classList.add('card-type-editable');
      type.title = '點擊可改字';
      makeEditable(type,
        function () { return tab.badge || '私人'; },
        function (v) { tab.badge = (v || '').trim() || '私人'; DB.touch(true); },
        { placeholder: '私人' });
    } else {
      type.textContent = TYPE_LABEL[tab.type] || tab.type;
    }
    head.appendChild(type);

    var title = document.createElement('div');
    title.className = 'card-title';
    head.appendChild(title);
    makeEditable(title,
      function () { return tab.title; },
      function (v) { tab.title = v || '未命名'; tab.updatedAt = DB.nowIso(); DB.touch(true); },
      { placeholder: '未命名' });

    /* 收合之後看不到裡面的日期，提醒不能跟著消失：還有今天到期或已過期的
       未完成任務就浮一顆小紅點，跟側欄那顆同一套判斷（DB.tabHasDue）。
       只說「這裡有事」，不說幾件。 */
    if (collapsed && DB.tabHasDue(tab)) {
      var dueDot = document.createElement('span');
      dueDot.className = 'card-due';
      dueDot.title = '這張卡片有今天到期或已過期的任務';
      head.appendChild(dueDot);
    }

    /* 「立即隱藏」留在標題列，不收進選單。那是安全動作，要一眼看到、
       一下按到，藏起來等於變慢（規格書 9.7 的低調原則不包含拖慢保護動作）。 */
    if (tab.type === 'private' && tab.encrypted && Vault.isCardUnlocked(tab.id)) {
      head.appendChild(iconBtn('⦿', '立即隱藏內容', function () {
        ctx.lockCard(tab);
      }, 'pip-ok'));
    }

    if (!RO) {
      // 彈出置頂小視窗。這個瀏覽器不支援時不常駐一顆停用的按鈕，
      // 改成在 ⋯ 選單裡標示原因（見 cardMenuItems）
      if (ctx.pipSupported()) {
        var pipMode = ctx.pipMode ? ctx.pipMode() : null;
        head.appendChild(svgIconBtn(PIP_SVG,
          !ctx.isPipped(tab) ? '彈出成置頂小視窗'
            : (pipMode === 'win' ? '這張卡片正顯示在不置頂小視窗，點一下改成置頂'
                                 : '這張卡片正顯示在置頂小視窗'),
          function () { ctx.togglePip(tab); },
          ctx.isPipped(tab) ? 'pip-on' : ''));
      }

      // 選色點：滑鼠移到標題列才浮現，點下去開色票
      var dot = document.createElement('button');
      dot.className = 'color-dot';
      dot.title = '卡片顏色';
      if (color) dot.dataset.color = color;
      dot.addEventListener('click', function (e) {
        e.stopPropagation();
        ctx.pickTabColor(tab, dot);
      });
      head.appendChild(dot);

      /* ★ 一定要留在標題列：釘選狀態就是靠實心 ★ 表示的（規格書 7.2），
         收進選單之後就看不出哪幾張被釘了 */
      head.appendChild(iconBtn(tab.pinned ? '★' : '☆',
        tab.pinned ? '取消釘選' : '釘選（固定在最上面）',
        function () { ctx.togglePin(tab); },
        tab.pinned ? 'pin-on' : ''));

      /* 收合鈕放在 ⋯ 的左邊（使用者從四案截圖裡選的位置）。
         刻意不做成「點標題列收合」：標題文字本身是就地編輯、私人卡片的
         小圓標點下去是改字，再掛一個收合語意就是規格書 11.1 那個坑。 */
      head.appendChild(iconBtn(collapsed ? '▸' : '▾',
        collapsed ? '展開這張卡片' : '收合成一條',
        function () { DB.toggleCollapse(tab.id); },
        'collapse-btn'));

      head.appendChild(iconBtn('⋯', '更多', function () {
        ctx.openCardMenu(tab, cardMenuItems(tab, ctx));
      }, 'more-btn'));
    }

    card.appendChild(head);

    ctx.attachDrag(card, tab);

    var body = document.createElement('div');
    body.className = 'card-body';
    card.appendChild(body);

    (RENDERERS[tab.type] || renderUnknown)(tab, body, ctx);

    return card;
  }

  /**
   * 卡片 ⋯ 選單的內容。哪些動作收進來、哪些留在標題列，見 renderCard 的註解。
   * 只回傳資料，實際的彈窗由 app.js 畫——這樣選單的樣子跟分類的 ⋯ 一致。
   */
  function cardMenuItems(tab, ctx) {
    var items = [];

    if (!ctx.pipSupported()) {
      items.push({
        text: '彈出成置頂小視窗',
        disabled: true,
        hint: '這個瀏覽器不支援置頂小視窗（目前只有 Chrome、Edge 這類 Chromium 瀏覽器有）。' +
              '下面那個「不置頂」的版本任何瀏覽器都能開'
      });
    }

    /* 不置頂的版本走一般彈出視窗。置頂是 Document PiP 規範強制的，
       沒有開關可以關掉，所以「不置頂」只能是另一種視窗。
       常駐的彈出鈕維持「置頂」不變，這裡是另一個入口（對照 11.1）。 */
    items.push({
      text: ctx.isPipped(tab) && ctx.pipMode && ctx.pipMode() === 'win'
        ? '關掉不置頂視窗'
        : '彈出成不置頂視窗',
      onClick: function () { ctx.togglePipWindow(tab); }
    });

    if (tab.type === 'note' && (tab.items || []).length > 1) {
      var anyOpen = tab.items.some(function (i) { return i.open !== false; });
      items.push({
        text: anyOpen ? '全部收合' : '全部展開',
        onClick: function () {
          tab.items.forEach(function (i) { i.open = !anyOpen; });
          tab.updatedAt = DB.nowIso();
          DB.touch();
        }
      });
    }

    if (tab.type === 'form') {
      items.push({
        text: '輸出格式',
        onClick: function () { ctx.editFormTemplate(tab); }
      });
    }

    items.push({
      text: '移到其他分類',
      onClick: function () { ctx.askMoveTab(tab); }
    });

    if (tab.type === 'link') {
      items.push({
        text: '一次開多個分頁被擋下時怎麼辦',
        onClick: function () { ctx.showPopupHelp(); }
      });
    }

    if (tab.type === 'private') {
      items.push({
        text: tab.encrypted ? '取消加密' : '加上密碼保護',
        onClick: function () { ctx.convertPrivate(tab); }
      });
    }

    items.push({
      text: '刪除這張卡片',
      danger: true,
      onClick: function () {
        var msg = '將刪除「' + (tab.title || '未命名') + '」這張卡片及其全部內容。';
        if (tab.type === 'private') {
          // 卡片會先進保留區，所以確認訊息講的是還原，不是無法復原
          ctx.confirmDeletePrivate(tab, '刪除卡片', msg,
            function () { DB.deleteTab(tab.id); }, true);
        } else {
          ctx.confirmDelete('刪除卡片', msg,
            function () { DB.deleteTab(tab.id); }, true);
        }
      }
    });

    return items;
  }

  /**
   * 「清除已完成」。待辦與倒數共用。
   * 只有真的存在已完成項目時才出現——平常不佔位置，也不會讓人按了沒事發生。
   * 刪除一律二次確認（4.6），訊息裡寫明會刪幾筆。
   */
  function clearDoneBtn(tab, body, ctx, label) {
    var done = (tab.items || []).filter(function (i) { return i.done; });
    if (!done.length) return;

    var btn = document.createElement('button');
    btn.className = 'row-add clear-done';
    btn.textContent = '清除已完成（' + done.length + '）';
    btn.addEventListener('click', function () {
      ctx.confirmDelete(
        '清除已完成',
        '將刪除這張卡片裡 ' + done.length + ' 筆已完成的' + label + '。',
        function () {
          tab.items = tab.items.filter(function (i) { return !i.done; });
          tab.items.forEach(function (i, n) { i.order = n; });
          tab.updatedAt = DB.nowIso();
          DB.touch();
        }
      );
    });
    body.appendChild(btn);
  }

  /* ---------- 便籤 ---------- */

  /** 摺疊時只露出內容的第一行。不做標題欄位——便籤是隨手記的，強迫取名很煩。 */
  function firstLine(text) {
    var t = String(text || '').split('\n').filter(function (x) { return x.trim(); })[0] || '';
    return t.length > 60 ? t.slice(0, 60) + '…' : t;
  }

  /* ============================================================
     便籤的「欄位」型別（v4.23）
     ------------------------------------------------------------
     每一筆各自是自由格式（free）或欄位（form）。欄位那種是
     「標題行＋一排『欄位名：值』」，冒號右邊隨意填、隨意清，
     填完整張（含標題與空欄位）一起複製。

     **填進去的值不存**（使用者定的，同編碼卡、表單卡）：只放在這個
     記憶體物件裡，重新整理回到預設值。小視窗與主視窗共用同一份
     （兩邊都是這個模組在畫），但畫面不會即時互相更新（4.12 的已知落差）。

     欄位名不能在卡片上點著改：右邊是填值，左邊再承載改名就是 11.1。
     改欄位一律走「管理欄位」的彈窗。
     ============================================================ */

  var noteVals = {};

  function noteVal(item, f) {
    var m = noteVals[item.id];
    return m && Object.prototype.hasOwnProperty.call(m, f.id) ? m[f.id] : (f.def || '');
  }

  function setNoteVal(item, f, v) {
    if (!noteVals[item.id]) noteVals[item.id] = {};
    noteVals[item.id][f.id] = v;
  }

  /** 摺疊時露出來的那一行：標題；標題留空就用第一個有填的欄位 */
  function noteFormSummary(item) {
    var t = (item.title || '').trim();
    if (t) return t;
    var fields = item.fields || [];
    for (var i = 0; i < fields.length; i++) {
      var v = String(noteVal(item, fields[i]) || '').trim();
      if (v) return fields[i].label + '：' + v;
    }
    return fields.length ? fields[0].label : '';
  }

  /** 刪除確認、提示訊息裡要稱呼這一筆時用的名字 */
  function noteItemName(item) {
    if (item.kind === 'form') {
      return (item.title || '').trim() || ((item.fields || [])[0] || {}).label || '';
    }
    return firstLine(item.content);
  }

  function renderNoteForm(tab, item, box, ctx) {
    var fb = document.createElement('div');
    fb.className = 'nf-body';

    if ((item.title || '').trim()) {
      var t = document.createElement('div');
      t.className = 'nf-title';
      setText(t, item.title.trim());
      fb.appendChild(t);
    }

    var fields = item.fields || [];
    var inputs = [];
    if (fields.length) {
      var rows = document.createElement('div');
      rows.className = 'nf-rows';
      fields.forEach(function (f, n) {
        var l = document.createElement('span');
        l.className = 'nf-label';
        l.title = f.label;   // 欄位名太長被截掉時，滑過去看得到全文
        setText(l, f.label);
        rows.appendChild(l);

        var inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'nf-input';
        inp.value = noteVal(item, f);
        inp.setAttribute('aria-label', f.label);
        inp.addEventListener('input', function () { setNoteVal(item, f, inp.value); });
        inp.addEventListener('keydown', function (e) {
          // 按鍵不能漏到外面去觸發複製鍵
          e.stopPropagation();
          // Enter 跳下一欄，一路往下填比較順手
          if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            if (inputs[n + 1]) inputs[n + 1].focus();
          }
        });
        inputs.push(inp);
        rows.appendChild(inp);
      });
      fb.appendChild(rows);
    } else {
      var hint = document.createElement('div');
      hint.className = 'row-hint';
      hint.textContent = RO ? '還沒有欄位' : '還沒有欄位，點「管理欄位」設定';
      fb.appendChild(hint);
    }

    var acts = document.createElement('div');
    acts.className = 'nf-actions';

    var copy = document.createElement('button');
    copy.className = 'nf-btn nf-main pip-ok';
    copy.textContent = '複製';
    copy.title = '複製所有欄位（不含標題），空的也會印出來';
    copy.addEventListener('click', function (e) {
      e.stopPropagation();
      Clip.copy(DB.noteFormText(item, function (f) { return noteVal(item, f); }),
        copy, noteItemName(item) || '欄位');
    });
    acts.appendChild(copy);

    var clear = document.createElement('button');
    clear.className = 'nf-btn pip-ok';
    clear.textContent = '一鍵清空';
    clear.title = '清掉所有欄位的值（全部變空白），欄位名不動';
    clear.addEventListener('click', function (e) {
      e.stopPropagation();
      /* v4.25：一律清成空白，預設值只在「還沒填過」時帶出來。
         以前是「回到預設值」——使用者把填好的單子整張貼進管理欄位時，
         冒號後面全部變成預設值，按清空看起來就是沒反應。 */
      var blank = {};
      fields.forEach(function (f) { blank[f.id] = ''; });
      noteVals[item.id] = blank;
      // 直接改輸入框就好，不重畫（11.20）
      inputs.forEach(function (inp) { inp.value = ''; });
      if (inputs[0]) inputs[0].focus();
    });
    acts.appendChild(clear);

    if (!RO) {
      var mg = document.createElement('button');
      mg.className = 'nf-btn';
      mg.textContent = '管理欄位';
      mg.title = '改標題行、欄位名、預設值與順序';
      mg.addEventListener('click', function (e) {
        e.stopPropagation();
        ctx.editNoteItem(tab, item);
      });
      acts.appendChild(mg);
    }

    var tip = document.createElement('span');
    tip.className = 'nf-hint';
    tip.textContent = '複製不含標題，空欄位也會印';
    acts.appendChild(tip);

    fb.appendChild(acts);
    box.appendChild(fb);
  }

  function renderNote(tab, body, ctx) {
    tab.items = tab.items || [];

    var list = tab.items.slice().sort(function (a, b) { return a.order - b.order; });

    list.forEach(function (item) {
      var open = item.open !== false;
      var isForm = item.kind === 'form';

      var wrap = document.createElement('div');
      wrap.className = 'nt-item' + (open ? ' open' : '') + (isForm ? ' nt-form' : '');

      var head = document.createElement('div');
      head.className = 'nt-head';

      if (!RO) {
        // 跟卡片、常用語列同一套：只有按住把手才讓這一筆變成可拖
        var grip = document.createElement('span');
        grip.className = 'nt-grip';
        grip.textContent = '⠿';
        grip.title = '按住拖曳可調整順序';
        grip.addEventListener('mousedown', function (e) {
          e.stopPropagation();
          wrap.draggable = true;
        });
        head.appendChild(grip);
        ctx.attachNoteDrag(wrap, tab, item);
      }

      // 展開時標題列不重複寫第一行，內容區底下已經有了
      var summary = document.createElement('div');
      summary.className = 'nt-summary';
      if (!open) {
        setText(summary, isForm ? noteFormSummary(item) : firstLine(item.content), '還沒有內容');
      }
      head.appendChild(summary);

      /* 展開鈕放右邊，跟刪除排在一起。
         自由格式刻意沒有複製鈕：便籤是拿來看跟改的，要複製就進編輯框自己選取，
         一筆一顆複製鈕會讓標題列擠成一排符號（第 12 章）。
         欄位型別的複製鈕在內容區底下，不在標題列上。 */
      head.appendChild(iconBtn(open ? '▾' : '▸', open ? '收合' : '展開', function () {
        item.open = !open;
        tab.updatedAt = DB.nowIso();
        DB.touch();
      }, 'nt-tri pip-ok'));

      head.appendChild(iconBtn('✕', '刪除這一筆', function () {
        ctx.confirmDelete(
          '刪除便籤',
          '將刪除「' + (noteItemName(item) || '未命名') + '」這一筆。',
          function () {
            tab.items = tab.items.filter(function (x) { return x.id !== item.id; });
            tab.items.forEach(function (x, n) { x.order = n; });
            delete noteVals[item.id];
            tab.updatedAt = DB.nowIso();
            DB.touch();
          }
        );
      }, 'danger-btn'));

      wrap.appendChild(head);

      if (open && isForm) {
        renderNoteForm(tab, item, wrap, ctx);
      } else if (open) {
        var p = document.createElement('div');
        p.className = 'nt-body';
        /* 記住的高度同時套在顯示與編輯兩種狀態上。只套編輯框的話，
           一段長內容在非編輯狀態會把整張卡片撐成一整頁。 */
        if (tab.editorHeight) p.style.maxHeight = tab.editorHeight;
        wrap.appendChild(p);
        makeEditable(p,
          function () { return item.content; },
          function (v) { item.content = v; tab.updatedAt = DB.nowIso(); DB.touch(true); },
          {
            multiline: true,
            placeholder: '還沒有內容',
            // 整張卡片共用一個高度，跟著資料檔走，匯出匯入與日後的同步都會帶著
            getHeight: function () { return tab.editorHeight; },
            setHeight: function (h) {
              if (tab.editorHeight === h) return;
              tab.editorHeight = h;
              /* 不重繪。這個回呼是在 blur 裡跑的，重建元素會把使用者正在進行的
                 點擊吃掉（11.20）。直接改每一筆的上限就好，效果一樣。 */
              Array.prototype.forEach.call(
                body.querySelectorAll('.nt-body'),
                function (x) { x.style.maxHeight = h; }
              );
              DB.touch(true);
            }
          });
      }

      body.appendChild(wrap);
    });

    if (!list.length) {
      var hint = document.createElement('div');
      hint.className = 'row-hint';
      hint.textContent = '還沒有內容';
      body.appendChild(hint);
    }

    /* 新增時先選型別（自由格式／欄位），比照私人卡片每一筆各自選（9.9）。
       彈窗由 app.js 畫，樣子才會跟其他編輯視窗一致。 */
    var add = document.createElement('button');
    add.className = 'row-add';
    add.textContent = '＋ 新增一筆';
    add.addEventListener('click', function () { ctx.editNoteItem(tab, null); });
    body.appendChild(add);
  }

  /* ---------- 常用語（核心） ---------- */

  function renderQuickPhrase(tab, body, ctx) {
    tab.rows = tab.rows || [];

    var rows = tab.rows.slice().sort(function (a, b) { return a.order - b.order; });
    var visible = rows.filter(function (r) { return ctx.matchRow(r); });

    // 欄位標題列，做出試算表的視覺
    if (visible.length) {
      var header = document.createElement('div');
      header.className = 'qp-head';
      header.innerHTML =
        '<span class="qp-grip"></span>' +
        '<span class="qp-index">複製鍵</span>' +
        '<span class="qp-label">標籤</span>' +
        '<span class="qp-content">內容</span>' +
        '<span class="qp-actions-space"></span>';
      body.appendChild(header);
    }

    visible.forEach(function (row) {
      var el = document.createElement('div');
      el.className = 'qp-row';
      el.dataset.rowId = row.id;
      el.title = '點一下複製內容';

      // 拖曳把手。跟卡片同一套做法：只有按住把手才讓這一列變成可拖，
      // 否則整列的點擊複製會被拖曳行為吃掉
      var grip = document.createElement('span');
      grip.className = 'qp-grip';
      grip.textContent = '⠿';
      grip.title = '按住拖曳可調整順序';
      grip.addEventListener('mousedown', function (e) {
        e.stopPropagation();
        el.draggable = true;
      });
      el.appendChild(grip);
      ctx.attachRowDrag(el, tab, row);

      // 序號欄改成顯示實際設定的複製鍵，沒設就留空
      var key = DB.normalizeHotkey(row.hotkey);
      var idx = document.createElement('span');
      idx.className = 'qp-index' + (key ? '' : ' unset');
      idx.textContent = key ? key.replace('ALT+', 'Alt+') : '';
      el.appendChild(idx);

      var label = document.createElement('div');
      label.className = 'qp-label';
      setText(label, row.label, '未命名');
      el.appendChild(label);

      var content = document.createElement('div');
      content.className = 'qp-content';
      setText(content, row.content, '還沒有內容');
      el.appendChild(content);

      var actions = document.createElement('div');
      actions.className = 'qp-actions';

      // 展開鈕預設藏著，等下面量到內容真的被截斷才顯示
      var expandBtn = iconBtn('▾', '展開完整內容', function () {
        var open = el.classList.toggle('expanded');
        expandBtn.textContent = open ? '▴' : '▾';
        expandBtn.title = open ? '收合' : '展開完整內容';
      }, 'pip-ok');
      expandBtn.hidden = true;
      actions.appendChild(expandBtn);

      actions.appendChild(iconBtn('✎', '編輯這一條的標籤與內容', function () {
        ctx.editPhrase(tab, row);
      }));

      actions.appendChild(iconBtn('✕', '刪除這一條', function () {
        ctx.confirmDelete(
          '刪除常用語',
          '將刪除「' + (row.label || '未命名') + '」這一條常用語。',
          function () {
            tab.rows = tab.rows.filter(function (r) { return r.id !== row.id; });
            tab.rows.forEach(function (r, n) { r.order = n; });
            tab.updatedAt = DB.nowIso();
            DB.touch();
          }
        );
      }, 'danger-btn'));

      el.appendChild(actions);

      // 整列點擊 = 複製。動作區的按鈕自己有 stopPropagation，不會誤觸
      el.addEventListener('click', function () {
        Clip.copy(row.content, el, row.label);
      });

      // 收合的卡片不註冊複製鍵：內容看不到，按了會複製到不知道哪一條
      if (key && !COL) ctx.registerHotkey(key, row, el);

      body.appendChild(el);

      // 插進畫面後才量得到高度：內容真的被截斷才給展開鈕
      requestAnimationFrame(function () {
        if (content.scrollHeight > content.clientHeight + 2) expandBtn.hidden = false;
      });
    });

    if (!visible.length) {
      var hint = document.createElement('div');
      hint.className = 'row-hint';
      hint.textContent = rows.length ? '沒有符合搜尋的項目' : '還沒有常用語';
      body.appendChild(hint);
    }

    var add = document.createElement('button');
    add.className = 'row-add';
    add.textContent = '＋ 新增一條常用語';
    add.addEventListener('click', function () {
      var row = { id: DB.uid(), label: '', content: '', order: tab.rows.length };
      tab.rows.push(row);
      tab.updatedAt = DB.nowIso();
      DB.touch();
      // 新增完直接開編輯彈窗，省一次點擊
      ctx.editPhrase(tab, row);
    });
    body.appendChild(add);
  }

  /* ---------- 待辦 ---------- */

  function renderTodo(tab, body, ctx) {
    tab.items = tab.items || [];
    tab.items.slice().sort(function (a, b) { return a.order - b.order; }).forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'todo-row' + (item.done ? ' done' : '');

      if (!RO) {
        row.appendChild(listGrip(row));
        ctx.attachItemDrag(row, tab, item.id, 'todo', function (from, to) {
          DB.moveItem(tab.id, from, to);
        });
      }

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!item.done;
      cb.addEventListener('change', function () {
        item.done = cb.checked;
        tab.updatedAt = DB.nowIso();
        DB.touch();
      });
      row.appendChild(cb);

      var text = document.createElement('div');
      row.appendChild(text);
      makeEditable(text,
        function () { return item.text; },
        function (v) { item.text = v; tab.updatedAt = DB.nowIso(); DB.touch(true); },
        { placeholder: '還沒有內容' });

      row.appendChild(iconBtn('✕', '刪除這項任務', function () {
        ctx.confirmDelete(
          '刪除任務',
          '將刪除「' + (item.text || '未命名') + '」這項任務。',
          function () {
            tab.items = tab.items.filter(function (x) { return x.id !== item.id; });
            DB.touch();
          }
        );
      }, 'danger-btn'));

      body.appendChild(row);
    });

    var add = document.createElement('button');
    add.className = 'row-add';
    add.textContent = '＋ 新增任務';
    add.addEventListener('click', function () {
      tab.items.push({ id: DB.uid(), text: '', done: false, order: tab.items.length });
      DB.touch();
    });
    body.appendChild(add);

    clearDoneBtn(tab, body, ctx, '任務');
  }

  /* ---------- 倒數 ---------- */

  /** 2026-09-30 → 2026年9月30日 */
  function formatDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '';
    return Number(m[1]) + '年' + Number(m[2]) + '月' + Number(m[3]) + '日';
  }

  var WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

  /* ---------- 倒數提醒 ---------- */

  /** 幾點幾分，或沒設時間時的提示字。 */
  function timeLabel(item) {
    return item.time || '時間';
  }

  /** 剩多久／過多久。小時級只有在當天才有意義，其他時候是雜訊。 */
  function dueText(item, d) {
    if (!d.has) return '未定日期';
    if (d.overdue) {
      var mins = Math.floor((Date.now() - d.at.getTime()) / 60000);
      if (item.time && mins < 1440) {
        var h = Math.floor(mins / 60);
        return h >= 1 ? '已過期 ' + h + ' 小時' : '已過期 ' + Math.max(mins, 1) + ' 分';
      }
      return Math.max(Math.abs(d.diffDays), 1) + ' 天前已過期';
    }
    if (d.today) {
      if (!item.time) return '就是今天';
      var left = Math.floor((d.at.getTime() - Date.now()) / 60000);
      var lh = Math.floor(left / 60);
      return lh >= 1 ? '今天 · 剩 ' + lh + ' 小時' : '今天 · 剩 ' + Math.max(left, 1) + ' 分';
    }
    return d.diffDays + ' 天後';
  }

  function dueTone(d) {
    if (!d.has) return '';
    if (d.overdue) return 'overdue';
    if (d.today || d.soon) return 'soon';
    return '';
  }

  /** 這一筆屬於哪一組。已完成的一律沉到最後，沒設日期的排在它前面。 */
  function groupKey(item) {
    if (item.done) return '\uFFFFdone';
    return item.due || '\uFFFEnone';
  }

  function renderCountdown(tab, body, ctx) {
    tab.items = tab.items || [];

    var sorted = tab.items.slice().sort(function (a, b) {
      var ka = groupKey(a), kb = groupKey(b);
      if (ka !== kb) return ka < kb ? -1 : 1;
      // 同一天內依時間排，沒設時間的排在最前面（那是「整天」的意思）
      var ta = a.time || '', tb = b.time || '';
      if (ta !== tb) { if (!ta) return -1; if (!tb) return 1; return ta < tb ? -1 : 1; }
      return a.order - b.order;
    });

    var lastKey = null;
    sorted.forEach(function (item) {
      var d = DB.dueInfo(item);
      var key = groupKey(item);

      if (key !== lastKey) {
        lastKey = key;
        var h = document.createElement('div');
        h.className = 'cd-group';
        if (item.done) {
          h.textContent = '已完成';
          h.classList.add('muted');
        } else if (!d.has) {
          h.textContent = '未定日期';
          h.classList.add('muted');
        } else {
          /* 日期後面一定要接「還剩幾天」。這張卡片的用途是倒數，
             只寫日期的話使用者得自己心算，等於把工作丟回去給他。
             這裡用的是「整天」的狀態（不含時間），時間的精細度留給每一列。 */
          var day = new Date(item.due + 'T00:00:00');
          var gd = DB.dueInfo({ due: item.due, time: '' });
          var suffix;
          if (gd.overdue) suffix = Math.max(Math.abs(gd.diffDays), 1) + ' 天前已過期';
          else if (gd.today) suffix = '就是今天';
          else suffix = gd.diffDays + ' 天後';

          h.textContent = formatDate(item.due) + '（週' + WEEKDAY[day.getDay()] +
                          '） · ' + suffix;
          var tone = dueTone(gd);
          if (tone) h.classList.add(tone);
        }
        body.appendChild(h);
      }

      var row = document.createElement('div');
      row.className = 'todo-row cd-row' + (item.done ? ' done' : '');

      /* 倒數仍然先依日期分組、同一天依時間排（使用者選的：同一天之內可以拖）。
         所以只准拖到「同一組、同一個時間」的那幾筆之間——拖到別組去，
         重畫後又會被日期排回原位，看起來像沒反應。 */
      if (!RO) {
        row.appendChild(listGrip(row));
        ctx.attachItemDrag(row, tab, item.id, groupKey(item) + '|' + (item.time || ''),
          function (from, to) { DB.moveItem(tab.id, from, to); });
      }

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!item.done;
      cb.addEventListener('change', function () {
        item.done = cb.checked;
        tab.updatedAt = DB.nowIso();
        DB.touch();
      });
      row.appendChild(cb);

      // 點文字＝改名稱，點右邊的標＝改日期時間。兩個動作在兩個區域，
      // 不會像常用語那次一樣互相搶（11.1）
      var text = document.createElement('div');
      row.appendChild(text);
      makeEditable(text,
        function () { return item.text; },
        function (v) { item.text = v; tab.updatedAt = DB.nowIso(); DB.touch(true); },
        { placeholder: '還沒有內容' });

      var chip = document.createElement('button');
      chip.className = 'cd-chip';
      if (!item.done) {
        var t2 = dueTone(d);
        if (t2) chip.classList.add(t2);
      }
      if (!item.time) chip.classList.add('unset');
      chip.textContent = timeLabel(item);
      chip.title = item.done ? '' : dueText(item, d);
      if (!RO) {
        chip.addEventListener('click', function (e) {
          e.stopPropagation();
          ctx.editDueItem(tab, item);
        });
      }
      row.appendChild(chip);

      row.appendChild(iconBtn('✕', '刪除這項任務', function () {
        ctx.confirmDelete(
          '刪除任務',
          '將刪除「' + (item.text || '未命名') + '」。',
          function () {
            tab.items = tab.items.filter(function (x) { return x.id !== item.id; });
            tab.updatedAt = DB.nowIso();
            DB.touch();
          }
        );
      }, 'danger-btn'));

      body.appendChild(row);
    });

    if (!tab.items.length) {
      var hint = document.createElement('div');
      hint.className = 'row-hint';
      hint.textContent = '還沒有任務';
      body.appendChild(hint);
    }

    var add = document.createElement('button');
    add.className = 'row-add';
    add.textContent = '＋ 新增任務';
    // 新增就直接開編輯彈窗，省掉「先生一列空白、再回頭去改」那一步（同 5.1）
    add.addEventListener('click', function () { ctx.editDueItem(tab, null); });
    body.appendChild(add);

    clearDoneBtn(tab, body, ctx, '任務');
  }

  /* ---------- 連結收藏 ---------- */

  /**
   * 勾選狀態寫進資料檔（v4.24，使用者要的：重新登入、換電腦都是上次勾的樣子）。
   * 只記「沒勾」的（link.off），預設全勾，舊資料畫面不變。
   * 勾選不重畫（touch(true)），不然正在連點下一個勾選框時元素會被換掉（11.20）；
   * 雲端同步靠 DB.onDirty 照樣排得上。
   */
  function isChecked(link) {
    return link.off !== true;
  }

  function setChecked(tab, link, on) {
    if (on) delete link.off;
    else link.off = true;
  }

  function commitChecks(tab) {
    tab.updatedAt = DB.nowIso();
    DB.touch(true);
  }

  /**
   * 開一個新分頁，回傳是否成功。
   *
   * 注意：不能用 window.open(url, '_blank', 'noopener')。
   * 規格明定只要指定 noopener 就一律回傳 null，不管分頁有沒有真的開起來，
   * 這樣就沒辦法用回傳值判斷是否被瀏覽器擋掉。
   * 改成拿到 window 之後自己把 opener 設成 null，效果一樣但回傳值可用。
   */
  function openTab(url) {
    var w = null;
    try { w = window.open(url, '_blank'); } catch (err) { w = null; }
    if (!w) return false;
    try { w.opener = null; } catch (err) { /* 跨來源時可能不給設，忽略 */ }
    return true;
  }

  /** 多條網址時隨機挑一條。被封鎖不自動換下一條，這是使用者確認過的行為。 */
  function pickUrl(link) {
    var urls = link.urls || [];
    if (!urls.length) return '';
    return urls[Math.floor(Math.random() * urls.length)];
  }

  function renderLink(tab, body, ctx) {
    tab.links = tab.links || [];
    var links = tab.links.slice().sort(function (a, b) { return a.order - b.order; });

    var countEl = null;

    function refreshCount() {
      if (!countEl) return;
      var n = links.filter(function (l) { return isChecked(l) && (l.urls || []).length; }).length;
      countEl.textContent = '開啟已勾選（' + n + '）';
      countEl.disabled = n === 0;
    }

    if (links.length) {
      var bar = document.createElement('div');
      bar.className = 'link-bar';

      var selAll = document.createElement('button');
      selAll.className = 'link-mini pip-ok';
      selAll.textContent = '全選';
      selAll.addEventListener('click', function () {
        links.forEach(function (l) { setChecked(tab, l, true); });
        body.querySelectorAll('.link-check').forEach(function (c) { c.checked = true; });
        refreshCount();
        commitChecks(tab);
      });

      var selNone = document.createElement('button');
      selNone.className = 'link-mini pip-ok';
      selNone.textContent = '取消全選';
      selNone.addEventListener('click', function () {
        links.forEach(function (l) { setChecked(tab, l, false); });
        body.querySelectorAll('.link-check').forEach(function (c) { c.checked = false; });
        refreshCount();
        commitChecks(tab);
      });

      countEl = document.createElement('button');
      countEl.className = 'btn-primary link-open';
      countEl.addEventListener('click', function () {
        ctx.openLinks(links.filter(function (l) { return isChecked(l); }), pickUrl);
      });

      bar.appendChild(selAll);
      bar.appendChild(selNone);
      bar.appendChild(document.createElement('span')).className = 'spacer';
      bar.appendChild(countEl);
      body.appendChild(bar);
    }

    links.forEach(function (link) {
      var row = document.createElement('div');
      row.className = 'link-row';

      /* 把手的格子一律留著（唯讀時是個空的 span）。這一列是 grid，
         少一個元素後面的欄位會整排遞補上來（11.24）。 */
      var grip = document.createElement('span');
      grip.className = 'link-grip';
      if (!RO) {
        grip.textContent = '⠿';
        grip.title = '按住拖曳可調整順序';
        grip.addEventListener('mousedown', function (e) {
          e.stopPropagation();
          row.draggable = true;
        });
        ctx.attachLinkDrag(row, tab, link);
      }
      row.appendChild(grip);

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'link-check';
      cb.checked = isChecked(link);
      cb.title = '勾選後可批次開啟（會記住）';
      cb.addEventListener('change', function () {
        setChecked(tab, link, cb.checked);
        refreshCount();
        commitChecks(tab);
      });
      row.appendChild(cb);

      var urls = link.urls || [];
      var a = document.createElement('a');
      a.href = urls[0] || '#';
      setText(a, link.name || urls[0], '未命名連結');
      a.title = urls.join('\n') || '尚未設定網址';
      a.addEventListener('click', function (e) {
        // 單獨點名稱：維持原本的行為，開一個分頁。
        // 但有多條時要隨機挑，所以不能讓 <a> 用固定的 href 去開
        e.preventDefault();
        var u = pickUrl(link);
        if (!u) { Clip.toast('這個項目還沒有設定網址', true); return; }
        if (!openTab(u)) Clip.toast('分頁被瀏覽器擋下了', true);
      });
      row.appendChild(a);

      if (urls.length > 1) {
        var badge = document.createElement('span');
        badge.className = 'link-badge';
        /* 標記只寫開啟的行為，不把複製也寫進來——那句話會長到把名稱那一欄
           擠掉。複製固定第一條這件事寫在複製鈕的提示與複製成功的訊息裡，
           剛好在使用者真的要用的那一刻才說。 */
        badge.textContent = urls.length + ' 條網址，隨機開 1 條';
        row.appendChild(badge);
      } else if (!urls.length) {
        var warn = document.createElement('span');
        warn.className = 'link-badge warn';
        warn.textContent = '未設定網址';
        row.appendChild(warn);
      } else {
        // 標記欄沒東西時也要佔著格子，理由同把手（11.24）
        row.appendChild(document.createElement('span')).className = 'link-badge-gap';
      }

      /* 複製網址。小視窗裡照樣能用（標了 pip-ok）——複製是唯讀動作，
         小視窗本來就允許看與複製。 */
      row.appendChild(svgIconBtn(COPY_SVG,
        urls.length > 1 ? '複製第 1 條網址' : '複製網址',
        function (e) {
          /* 開啟是隨機挑一條、複製固定第一條，兩個動作刻意不同。
             多條時把「第 1 條」寫進複製成功的訊息裡，才不會以為
             複製到的是剛剛開出來那一條。 */
          var label = (link.name || '網址') + (urls.length > 1 ? '（第 1 條）' : '');
          Clip.copy(urls[0] || '', e.currentTarget, label);
        }, 'pip-ok'));

      row.appendChild(iconBtn('✎', '編輯', function () {
        ctx.editLink(tab, link);
      }));

      row.appendChild(iconBtn('✕', '刪除這個連結', function () {
        ctx.confirmDelete(
          '刪除連結',
          '將刪除「' + (link.name || urls[0] || '未命名') + '」這個項目。',
          function () {
            tab.links = tab.links.filter(function (x) { return x.id !== link.id; });
            DB.touch();
          }
        );
      }, 'danger-btn'));

      body.appendChild(row);
    });

    refreshCount();

    var add = document.createElement('button');
    add.className = 'row-add';
    add.textContent = '＋ 新增連結';
    add.addEventListener('click', function () {
      var link = { id: DB.uid(), name: '', urls: [], order: tab.links.length };
      tab.links.push(link);
      DB.touch();
      ctx.editLink(tab, link);
    });
    body.appendChild(add);
  }

  /* ---------- 私人（加密） ---------- */

  function maskOf(pass) {
    return new Array(Math.min((pass || '').length, 12) + 1).join('•') || '••••••';
  }

  /* 哪幾筆是展開的。刻意只放在記憶體，不寫進資料檔也不跨鎖定保留——
     記住展開狀態的話，下次解鎖帳號就直接攤在畫面上，摺疊這層保護等於白做。
     每次鎖定（見下方 isUnlocked 分支）會整個清空。 */
  var pvOpen = {};

  /* 鎖定某張卡片時只忘掉它自己的展開狀態，別張不受影響。
     鍵是「tabId::itemId」，所以用前綴比對就能只清一張。 */
  function forgetOpen(tabId) {
    Object.keys(pvOpen).forEach(function (k) {
      if (k.indexOf(tabId + '::') === 0) delete pvOpen[k];
    });
  }

  /* 鏈條圖示自繪，不用 🔗 emoji：emoji 在不同系統會被換成各自的彩色圖案，
     大小與垂直位置都不受控，跟旁邊線條風格的 ✎ ✕ 擺一起會突兀。
     同第 15.3、17.2 節的原則。 */
  /* 自繪 SVG：emoji 在不同系統會被換成各自的彩色圖案，大小與顏色都不受控，
     跟旁邊的線條圖示並排會突兀（規格書 11.5）。一圈箭頭＝重新產生一組。 */
  var AGAIN_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'stroke-linejoin="round">' +
    '<path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8"/>' +
    '<path d="M13.6 2.8v3.3h-3.3"/></svg>';

  /* 複製：兩張疊起來的紙。自繪 SVG 的理由同上（11.5）——⧉ 這類字元在
     不同字型下大小與垂直位置差很多，而它要跟 ✎ ✕ 並排。
     使用者看過四款候選的實際截圖後選了這一款。 */
  var COPY_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="9" y="9" width="11" height="11" rx="1.8"/>' +
    '<path d="M15 6.6V5.6A1.6 1.6 0 0 0 13.4 4H5.6A1.6 1.6 0 0 0 4 5.6v7.8A1.6 1.6 0 0 0 5.6 15h1"/></svg>';

  var LINK_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/>' +
    '<path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';

  /* 自繪 SVG：⧉ 這類字元在不同字型下大小與垂直位置差很多（規格書 11.5）。
     外框代表原本的視窗，右下角的小框是彈出去、浮在最上層的那一個 */
  var PIP_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">' +
    '<path d="M20 11V5.5A1.5 1.5 0 0 0 18.5 4h-13A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H11"/>' +
    '<rect x="13" y="13" width="8" height="7" rx="1.2"/></svg>';

  function svgIconBtn(svg, title, onClick, extraClass) {
    var b = document.createElement('button');
    b.className = 'icon-btn' + (extraClass ? ' ' + extraClass : '');
    b.innerHTML = svg;
    b.title = title;
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      onClick(e);
    });
    return b;
  }

  function renderPrivate(tab, body, ctx) {
    if (tab.encrypted && !Vault.available()) {
      var warn = document.createElement('div');
      warn.className = 'row-hint';
      warn.innerHTML = '這個環境不支援加密，這張卡片無法使用。<br>' +
        '請改用較新的瀏覽器，或用 https 開頭的網址開啟。';
      body.appendChild(warn);
      return;
    }

    if (tab.encrypted && !Vault.isCardUnlocked(tab.id)) {
      // 鎖定就忘掉這張卡片的展開狀態，下次進來一律從全摺疊開始
      forgetOpen(tab.id);
      var locked = document.createElement('div');
      locked.className = 'locked-body';
      // 刻意不顯示筆數，也不用鎖頭圖示——那些跟「密碼」兩個字一樣顯眼
      locked.innerHTML =
        '<div class="locked-icon">' +
        '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" ' +
        'stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
        '<path d="M10.6 6.2A9 9 0 0 1 12 6c5 0 9 6 9 6a15 15 0 0 1-2.3 2.8"/>' +
        '<path d="M6.6 6.6A15 15 0 0 0 3 12s4 6 9 6a9 9 0 0 0 4.2-1"/>' +
        '<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>' +
        '<path d="M3 3l18 18"/></svg></div>' +
        '<p class="locked-text">內容已隱藏</p>';

      var btn = document.createElement('button');
      btn.className = 'btn-primary';
      btn.textContent = '輸入主密碼';
      btn.addEventListener('click', function () { ctx.openCard(tab); });
      locked.appendChild(btn);

      body.appendChild(locked);
      return;
    }

    var entries = ctx.privateEntries(tab);

    if (!entries) {
      var loading = document.createElement('div');
      loading.className = 'row-hint';
      loading.textContent = '讀取中…';
      body.appendChild(loading);
      // 解密是非同步的，拿到之後放進記憶體再重繪一次
      Vault.decryptFor(tab.id, tab.enc).then(function (list) {
        Vault.setPlain(tab.id, list || []);
        DB.touch();
      }, function () {
        Vault.setPlain(tab.id, []);
        Clip.toast('這張卡片的內容解不開', true);
        DB.touch();
      });
      return;
    }

    entries.forEach(function (item) {
      var isMemo = item.kind === 'memo';
      var okey = tab.id + '::' + item.id;
      var open = !!pvOpen[okey];

      var row = document.createElement('div');
      row.className = 'pv-row';

      var head = document.createElement('div');
      head.className = 'pv-head' + (open ? '' : ' collapsed');

      // 能走到這裡代表內容已經在手上（不加密，或已解鎖），排完照樣加密存回去
      if (!RO) {
        head.appendChild(listGrip(row));
        ctx.attachItemDrag(row, tab, item.id, 'pv', function (from, to) {
          ctx.movePrivate(tab, from, to);
        });
      }

      // 展開鈕。摺疊時整列只露出名稱，型別不標——標了等於幫人分類
      var tri = document.createElement('button');
      tri.className = 'icon-btn pv-tri pip-ok';
      tri.textContent = open ? '▾' : '▸';
      tri.title = open ? '收合' : '展開';
      tri.addEventListener('click', function (e) {
        e.stopPropagation();
        if (pvOpen[okey]) delete pvOpen[okey];
        else pvOpen[okey] = true;
        DB.touch();
      });
      head.appendChild(tri);

      var name = document.createElement('span');
      name.className = 'pv-name';
      setText(name, item.name, '未命名');
      head.appendChild(name);

      if (item.url) {
        head.appendChild(svgIconBtn(LINK_SVG, '開啟網址', function () {
          if (!Tabs.openTab(item.url)) Clip.toast('分頁被瀏覽器擋下了', true);
        }, 'pip-ok'));
      }

      head.appendChild(iconBtn('✎', '編輯這一筆', function () {
        ctx.editPrivate(tab, item);
      }));

      head.appendChild(iconBtn('✕', '刪除這一筆', function () {
        ctx.confirmDeletePrivate(tab, '刪除項目',
          '將刪除「' + (item.name || '未命名') + '」。', function () {
            var list = (ctx.privateEntries(tab) || []).filter(function (x) {
              return x.id !== item.id;
            });
            delete pvOpen[tab.id + '::' + item.id];
            ctx.setPrivateEntries(tab, list);
            ctx.savePrivate(tab);
          });
      }, 'danger-btn'));

      row.appendChild(head);

      if (!open) { body.appendChild(row); return; }

      function field(label, value, isSecret) {
        if (!value) return;
        var line = document.createElement('div');
        line.className = 'pv-field';

        var l = document.createElement('span');
        l.className = 'pv-label';
        l.textContent = label;
        line.appendChild(l);

        var v = document.createElement('span');
        v.className = 'pv-value' + (isSecret ? ' secret' : '');
        // 密碼欄永遠不標高亮。它本來就不參與搜尋，按了「暫時顯示」之後
        // 如果剛好含有搜尋字而被標起來，等於從側面洩漏（對照 9.5）
        if (isSecret) v.textContent = maskOf(value);
        else setText(v, value, '');
        line.appendChild(v);

        if (isSecret) {
          var shown = false;
          line.appendChild(iconBtn('◉', '暫時顯示', function () {
            shown = !shown;
            v.textContent = shown ? value : maskOf(value);
            v.classList.toggle('secret', !shown);
          }, 'pip-ok'));
        }

        line.appendChild(iconBtn('⧉', '複製' + label, function () {
          Clip.copy(value, line, label);
        }, 'pip-ok'));

        row.appendChild(line);
      }

      if (!isMemo) {
        field('帳號', item.user, false);
        field('密碼', item.pass, true);
      }

      if (item.note) {
        var note = document.createElement('div');
        note.className = 'pv-note';
        note.textContent = item.note;
        row.appendChild(note);

        // 備忘錄的內文就是這一筆的主體，給一顆複製鈕才好用
        if (isMemo) {
          var copyWrap = document.createElement('div');
          copyWrap.className = 'pv-memo-actions';
          copyWrap.appendChild(iconBtn('⧉', '複製內容', function () {
            Clip.copy(item.note, copyWrap, '內容');
          }, 'pip-ok'));
          row.appendChild(copyWrap);
        }
      }

      body.appendChild(row);
    });

    if (!entries.length) {
      var empty = document.createElement('div');
      empty.className = 'row-hint';
      empty.textContent = '還沒有內容';
      body.appendChild(empty);
    }

    var add = document.createElement('button');
    add.className = 'row-add';
    add.textContent = '＋ 新增一筆';
    add.addEventListener('click', function () {
      ctx.editPrivate(tab, null);
    });
    body.appendChild(add);
  }

  /* ---------- 尚未實作 ---------- */

  /* ============================================================
     編碼卡（codegen）
     ------------------------------------------------------------
     版面：兩個虛線框。上面「填寫」放兩組選項與來源字串，下面「產出」
     放結果與文案。順序照實際作業走：選 → 貼 → 出結果 → 最後複製文案。

     **選到的選項與貼上的字串都不寫進資料檔**，只放在這個模組的記憶體裡
     （genSel）。那是別人的資料，重新整理就該不見（對照 9.4 的原則）。
     存進資料檔的只有使用者的設定：選項、文案、欄位標籤。

     結果只有一格：需要來源字串時是「隨機碼＋字串尾段」，不需要時隨機碼
     本身就是完整結果。兩種情況同一格，不必為其中一種另外搬動按鈕。
     ============================================================ */

  /* 標籤清空就回到出廠的中性字，不是留著原本改過的字。
     那些預設字是「這一欄原本是幹嘛的」的提示，久沒用的時候要回得去。 */
  function labelDefault(tab, key) {
    return tab.type === 'form' ? DB.formLabelDefault(key) : DB.genLabelDefault(key);
  }

  var genSel = {};

  function genState(tab) {
    if (!genSel[tab.id]) genSel[tab.id] = { g1: null, g2: null, code: '', src: '' };
    return genSel[tab.id];
  }

  function genFind(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /** 重抽隨機碼。長度看選到的方式需不需要來源字串。 */
  function genNewCode(tab, st) {
    var way = genFind(tab.g2 || [], st.g2);
    st.code = DB.genRandomCode(!!(way && way.noSrc));
  }

  function genZone(tab, key) {
    var z = document.createElement('div');
    z.className = 'gen-zone';
    var h = document.createElement('div');
    h.className = 'gen-zone-title';
    z.appendChild(h);
    makeEditable(h,
      function () { return tab.labels[key]; },
      function (v) {
        tab.labels[key] = (v || '').trim() || labelDefault(tab, key);
        DB.touch(true);
      },
      { placeholder: labelDefault(tab, key) });
    return z;
  }

  function genChipRow(tab, which, ctx, ro, onPick) {
    var st = genState(tab);
    var list = (which === 'g1' ? tab.g1 : tab.g2) || [];

    var wrap = document.createElement('div');
    wrap.className = 'gen-block';

    var lab = document.createElement('div');
    lab.className = 'gen-label';
    wrap.appendChild(lab);
    makeEditable(lab,
      function () { return tab.labels[which]; },
      function (v) {
        tab.labels[which] = (v || '').trim() || labelDefault(tab, which);
        DB.touch(true);
      },
      { placeholder: labelDefault(tab, which) });

    var row = document.createElement('div');
    row.className = 'gen-chips';
    list.forEach(function (opt) {
      var b = document.createElement('button');
      b.className = 'gen-chip' + (st[which] === opt.id ? ' on' : '');
      b.textContent = opt.name;
      b.addEventListener('click', function () {
        st[which] = (st[which] === opt.id) ? null : opt.id;
        onPick();
      });
      row.appendChild(b);
    });

    if (!ro) {
      var mg = document.createElement('button');
      mg.className = 'gen-chip gen-manage';
      mg.textContent = '管理';
      mg.title = '新增、改名、刪除這一組的選項';
      mg.addEventListener('click', function () { ctx.manageGen(tab, which); });
      row.appendChild(mg);
    } else if (!list.length) {
      var none = document.createElement('span');
      none.className = 'row-hint';
      none.textContent = '還沒有選項';
      row.appendChild(none);
    }

    wrap.appendChild(row);
    return wrap;
  }

  function renderCodegen(tab, body, ctx) {
    /* RO 是模組層級的旗標，只在 renderCard 進入的那一刻正確。這張卡片會在
       使用者點選項時自己重畫，那時候旗標可能已經被別張卡片改掉了，所以
       這裡從 ctx 自己拿一份（11.27 的同一類問題：抄狀態要看來源對不對）。 */
    var ro = !!ctx.readOnly;
    var st = genState(tab);
    var g1 = genFind(tab.g1 || [], st.g1);
    var g2 = genFind(tab.g2 || [], st.g2);
    if (st.g1 && !g1) st.g1 = null;
    if (st.g2 && !g2) st.g2 = null;

    function redraw() {
      body.innerHTML = '';
      renderCodegen(tab, body, ctx);
    }

    /* ---- 填寫 ---- */
    var fill = genZone(tab, 'fill');
    fill.appendChild(genChipRow(tab, 'g1', ctx, ro, function () {
      genNewCode(tab, genState(tab));
      redraw();
    }));
    fill.appendChild(genChipRow(tab, 'g2', ctx, ro, function () {
      var s = genState(tab);
      // 換了方式就重抽：長短版的規則不同，沿用舊的會長度不對
      s.src = '';
      genNewCode(tab, s);
      redraw();
    }));

    var needSrc = !!(g2 && !g2.noSrc);
    if (needSrc) {
      var f = document.createElement('div');
      f.className = 'gen-field';

      var fl = document.createElement('span');
      fl.className = 'gen-field-label';
      f.appendChild(fl);
      // 標籤本身是樣板，顯示時把【方式】換成選到的那個
      makeEditable(fl,
        function () { return DB.genSrcLabel(tab.labels.src, g2.name); },
        function (v) {
          tab.labels.src = (v || '').trim() || labelDefault(tab, 'src');
          DB.touch(true);
        },
        { placeholder: labelDefault(tab, 'src') });

      var inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'gen-input';
      inp.value = st.src;
      // 淡字每次都從程式拿，不從資料檔（見 data.js 的 GEN_LABEL_KEYS）
      inp.placeholder = DB.genLabelDefault('srcHint');
      inp.addEventListener('input', function () {
        st.src = inp.value;
        genPaintResult(tab, body);
      });
      // 在這裡打字不要觸發常用語的複製鍵
      inp.addEventListener('keydown', function (e) { e.stopPropagation(); });
      f.appendChild(inp);
      fill.appendChild(f);
    }
    body.appendChild(fill);

    /* ---- 產出 ---- */
    var out = genZone(tab, 'out');

    var res = document.createElement('div');
    res.className = 'gen-result';
    var rl = document.createElement('span');
    rl.className = 'gen-field-label';
    res.appendChild(rl);
    makeEditable(rl,
      function () { return tab.labels.result; },
      function (v) {
        tab.labels.result = (v || '').trim() || labelDefault(tab, 'result');
        DB.touch(true);
      },
      { placeholder: labelDefault(tab, 'result') });

    var val = document.createElement('b');
    val.className = 'gen-value';
    res.appendChild(val);

    /* 換一個是填寫側的動作（只動記憶體裡的暫存值），小視窗也給，
       所以要標 pip-ok——小視窗的樣式是預設拒絕（4.12） */
    res.appendChild(svgIconBtn(AGAIN_SVG, '換一個', function () {
      genNewCode(tab, st);
      genPaintResult(tab, body);
    }, 'gen-again pip-ok'));
    var copyBtn = document.createElement('button');
    copyBtn.className = 'gen-copy pip-ok';
    copyBtn.textContent = '複製';
    copyBtn.addEventListener('click', function (e) {
      if (copyBtn.disabled) return;
      Clip.copy(val.textContent, copyBtn, tab.labels.result);
      e.stopPropagation();
    });
    res.appendChild(copyBtn);
    out.appendChild(res);

    var txt = document.createElement('div');
    txt.className = 'gen-text';
    txt.title = '點一下複製';
    txt.addEventListener('click', function () {
      if (txt.dataset.ready !== '1') return;
      Clip.copy(txt.textContent, txt);
    });
    out.appendChild(txt);

    // 文案是點一下就複製的，要講出來——沒有按鈕的東西不會自己說明自己
    var tip = document.createElement('div');
    tip.className = 'gen-tip';
    tip.textContent = '↑ 點一下就複製';
    out.appendChild(tip);

    body.appendChild(out);

    if (!st.code && g1 && g2) genNewCode(tab, st);
    genPaintResult(tab, body);
  }

  /**
   * 只重畫結果與文案，不動整張卡片。
   * 在輸入框的 input 事件裡重建元素會把使用者正在進行的操作吃掉（11.20）。
   */
  function genPaintResult(tab, body) {
    var st = genState(tab);
    var g1 = genFind(tab.g1 || [], st.g1);
    var g2 = genFind(tab.g2 || [], st.g2);
    var val = body.querySelector('.gen-value');
    var txt = body.querySelector('.gen-text');
    var copyBtn = body.querySelector('.gen-copy');
    if (!val || !txt) return;

    if (!g1 || !g2) {
      val.textContent = '';
      val.classList.add('gen-value-empty');
      txt.textContent = (tab.g1 || []).length && (tab.g2 || []).length
        ? '上面兩組各選一個就會出現內容'
        : '還沒有選項，點「管理」建立';
      txt.classList.add('gen-text-empty');
      txt.dataset.ready = '0';
      if (copyBtn) copyBtn.disabled = true;
      return;
    }

    var code = st.code;
    var full, ready;
    if (g2.noSrc) {
      full = code;
      ready = true;
    } else {
      var last8 = DB.genLast8(st.src);
      // 尾段全是英文字母時結果裡一個數字都沒有，把隨機碼最後一碼換成數字
      if (g2.needDigit && DB.genAllLetters(last8)) code = DB.genApplyDigit(code);
      ready = last8.length === 8;
      full = ready ? (code + last8) : code + '‧‧‧‧‧‧‧‧';
    }

    val.textContent = full;
    val.classList.toggle('gen-value-empty', !ready);
    if (copyBtn) copyBtn.disabled = !ready;

    var text = DB.genBuildText(g1.tpl, g2.name, code, !!g2.noSrc);
    if (text.trim()) {
      txt.textContent = text;
      txt.classList.remove('gen-text-empty');
      txt.dataset.ready = '1';
    } else {
      txt.textContent = '這個' + tab.labels.g1 + '還沒有文案，點「管理」填一段';
      txt.classList.add('gen-text-empty');
      txt.dataset.ready = '0';
    }
  }

  /* ============================================================
     表單卡（form）
     ------------------------------------------------------------
     版面跟編碼卡同一套：兩個虛線框，填寫在上、產出在下。
     輸入的值一樣只放在記憶體（formSel），不寫進資料檔。

     哪些欄位是必填的，由使用者自己的模板決定：模板裡有用到哪個記號，
     那一欄就必填。這樣程式不必知道任何一個欄位的實際用途。
     ============================================================ */

  var formSel = {};

  function formState(tab) {
    if (!formSel[tab.id]) {
      // 兩個模式的清單是分開的，所以選到的那一個也各記一份
      formSel[tab.id] = { two: true, catTwo: null, catOne: null, note: '',
                          src: '', a: '', b: '', one: '', amount: '' };
    }
    return formSel[tab.id];
  }

  function formInput(tab, st, key, label, onChange) {
    var f = document.createElement('div');
    f.className = 'gen-field';
    var l = document.createElement('span');
    l.className = 'gen-field-label';
    f.appendChild(l);
    makeEditable(l,
      function () { return tab.labels[label]; },
      function (v) {
        tab.labels[label] = (v || '').trim() || labelDefault(tab, label);
        DB.touch(true);
      },
      { placeholder: labelDefault(tab, label) });

    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'gen-input';
    inp.dataset.key = key;
    inp.value = st[key];
    inp.addEventListener('input', function () { st[key] = inp.value; onChange(); });
    inp.addEventListener('keydown', function (e) { e.stopPropagation(); });
    f.appendChild(inp);
    return f;
  }

  function renderForm(tab, body, ctx) {
    var ro = !!ctx.readOnly;
    var st = formState(tab);
    if (st.catTwo && !(tab.cats || []).some(function (c) { return c.id === st.catTwo; })) {
      st.catTwo = null;
    }
    if (st.catOne && !(tab.catsOne || []).some(function (c) { return c.id === st.catOne; })) {
      st.catOne = null;
    }

    function redraw() {
      body.innerHTML = '';
      renderForm(tab, body, ctx);
    }
    function paint() { formPaint(tab, body); }

    /* ---- 填寫 ---- */
    // 這一格標籤管的是整個填寫區。原本模式那一組另外還有一個組名，
    // 兩格疊在一起重複了，留上面這一格就好
    var fill = genZone(tab, 'fill');

    var mrow = document.createElement('div');
    mrow.className = 'gen-chips';
    [['mode1', true], ['mode2', false]].forEach(function (m) {
      var b = document.createElement('button');
      b.className = 'gen-chip' + (st.two === m[1] ? ' on' : '');
      b.textContent = tab.labels[m[0]];
      b.addEventListener('click', function () {
        if (st.two === m[1]) return;
        st.two = m[1];
        redraw();
      });
      mrow.appendChild(b);
    });
    if (!ro) {
      /* 名稱不能點著改：這兩顆按鈕按下去是切換模式，同一塊區域再承載
         「改名」就是 11.1 那個坑。改名收進彈窗。 */
      var mm = document.createElement('button');
      mm.className = 'gen-chip gen-manage';
      mm.textContent = '管理';
      mm.title = '改這兩個模式的名稱';
      mm.addEventListener('click', function () { ctx.manageModes(tab); });
      mrow.appendChild(mm);
    }
    fill.appendChild(mrow);

    fill.appendChild(formInput(tab, st, 'src', 'src', paint));
    if (st.two) {
      fill.appendChild(formInput(tab, st, 'a', 'a', paint));
      fill.appendChild(formInput(tab, st, 'b', 'b', paint));
    } else {
      fill.appendChild(formInput(tab, st, 'one', 'one', paint));
    }
    fill.appendChild(formInput(tab, st, 'amount', 'amount', paint));

    // 附註只有單向模式有：雙向那兩段的附註是固定標記
    if (!st.two) {
      var nb = document.createElement('div');
      nb.className = 'gen-block';
      var nl = document.createElement('div');
      nl.className = 'gen-label gen-label-row';

      /* 選項一多就把整排收掉。收合狀態跟著資料走。
         ▸ 是獨立的一顆按鈕，不做在標籤文字上——標籤點下去是改字，
         同一塊區域再承載第二種語意就是 11.1 那個坑。
         小視窗一律當成展開（跟卡片收合同一個道理：彈出來就是要用它）。 */
      var folded = !ro && !!tab.notesFold;
      if (!ro) {
        var tri = iconBtn(folded ? '▸' : '▾',
          folded ? '展開' : '收起來',
          function () { DB.toggleNotesFold(tab.id); }, 'gen-fold');
        nl.appendChild(tri);
      }

      var nlText = document.createElement('span');
      nl.appendChild(nlText);
      nb.appendChild(nl);
      makeEditable(nlText,
        function () { return tab.labels.notes; },
        function (v) {
          tab.labels.notes = (v || '').trim() || labelDefault(tab, 'notes');
          DB.touch(true);
        },
        { placeholder: labelDefault(tab, 'notes') });

      if (folded) {
        // 收起來時寫個數字，才知道裡面還有東西、有幾個
        var cnt = document.createElement('span');
        cnt.className = 'gen-fold-count';
        cnt.textContent = '（' + (tab.notes || []).length + '）';
        nl.appendChild(cnt);
      }

      var nrow = document.createElement('div');
      nrow.className = 'gen-chips';
      (tab.notes || []).forEach(function (n) {
        var b = document.createElement('button');
        b.className = 'gen-chip';
        b.textContent = n.name;
        // 選項只是「把字填進去」，填完照樣可以改——所以不做選中狀態
        b.addEventListener('click', function () {
          st.note = n.text || n.name;
          var el = body.querySelector('.gen-input[data-key="note"]');
          if (el) el.value = st.note;
          paint();
        });
        nrow.appendChild(b);
      });
      if (!ro) {
        var nm = document.createElement('button');
        nm.className = 'gen-chip gen-manage';
        nm.textContent = '管理';
        nm.title = '新增、改名、刪除常用的' + tab.labels.notes;
        nm.addEventListener('click', function () { ctx.manageGen(tab, 'notes'); });
        nrow.appendChild(nm);
      }
      if (!folded) nb.appendChild(nrow);

      var nf = document.createElement('div');
      nf.className = 'gen-field';
      var ni = document.createElement('input');
      ni.type = 'text';
      ni.className = 'gen-input';
      ni.dataset.key = 'note';
      ni.value = st.note;
      ni.placeholder = tab.labels.notes;
      ni.addEventListener('input', function () { st.note = ni.value; paint(); });
      ni.addEventListener('keydown', function (e) { e.stopPropagation(); });
      nf.appendChild(ni);
      nb.appendChild(nf);
      fill.appendChild(nb);
    }

    /* 類別：兩個模式各有一份清單、各有一個標籤字，互不影響。
       單向只有一段，所以它那份的顯示字也只有一格。 */
    var catKey = st.two ? 'cats' : 'catsOne';
    var catSel = st.two ? 'catTwo' : 'catOne';
    var catList = (st.two ? tab.cats : tab.catsOne) || [];

    var cb = document.createElement('div');
    cb.className = 'gen-block';
    var cl = document.createElement('div');
    cl.className = 'gen-label';
    cb.appendChild(cl);
    makeEditable(cl,
      function () { return tab.labels[catKey]; },
      function (v) {
        tab.labels[catKey] = (v || '').trim() || labelDefault(tab, catKey);
        DB.touch(true);
      },
      { placeholder: labelDefault(tab, catKey) });

    var crow = document.createElement('div');
    crow.className = 'gen-chips';
    catList.forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'gen-chip' + (st[catSel] === c.id ? ' on' : '');
      b.textContent = c.name;
      b.addEventListener('click', function () {
        st[catSel] = (st[catSel] === c.id) ? null : c.id;
        redraw();
      });
      crow.appendChild(b);
    });
    if (!ro) {
      var cm = document.createElement('button');
      cm.className = 'gen-chip gen-manage';
      cm.textContent = '管理';
      cm.title = '新增、改名、刪除' + tab.labels[catKey];
      cm.addEventListener('click', function () { ctx.manageGen(tab, catKey); });
      crow.appendChild(cm);
    }
    cb.appendChild(crow);
    fill.appendChild(cb);
    body.appendChild(fill);

    /* ---- 產出 ---- */
    var out = genZone(tab, 'out');
    var txt = document.createElement('div');
    txt.className = 'gen-text';
    txt.title = '點一下複製';
    txt.addEventListener('click', function () {
      if (txt.dataset.ready !== '1') return;
      Clip.copy(txt.textContent, txt);
    });
    out.appendChild(txt);

    var tip = document.createElement('div');
    tip.className = 'gen-tip';
    var tipText = document.createElement('span');
    tipText.textContent = '↑ 點一下就複製';
    tip.appendChild(tipText);

    {
      // 只清輸入欄：模式與選到的類別不動（使用者定的）
      var clear = document.createElement('button');
      clear.className = 'gen-chip gen-clear pip-ok';
      clear.textContent = '一鍵清空';
      clear.addEventListener('click', function () {
        st.src = ''; st.a = ''; st.b = ''; st.one = ''; st.amount = ''; st.note = '';
        redraw();
      });
      tip.appendChild(clear);
    }
    out.appendChild(tip);
    body.appendChild(out);

    formPaint(tab, body);
  }

  /** 只重畫產出，不動輸入欄（11.20：別在打字途中重建元素）。 */
  function formPaint(tab, body) {
    var st = formState(tab);
    var txt = body.querySelector('.gen-text');
    if (!txt) return;

    // 哪些欄位必填，由使用者自己的模板決定：用到哪個記號才必填
    var need = DB.formUsedTokens(tab, st.two);
    var missing = false;
    if (need.src && !st.src.trim()) missing = true;
    if (need.amount && !st.amount.trim()) missing = true;
    if (st.two) {
      if (need.objA && !st.a.trim()) missing = true;
      if (need.objB && !st.b.trim()) missing = true;
    } else {
      if (need.obj && !st.one.trim()) missing = true;
      if (need.note && !st.note.trim()) missing = true;
    }

    var catKey = st.two ? 'cats' : 'catsOne';
    var catList = (st.two ? tab.cats : tab.catsOne) || [];
    var catId = st.two ? st.catTwo : st.catOne;

    var text = catId && !missing ? DB.formBuildText(tab, {
      two: st.two, src: st.src, a: st.a, b: st.b, one: st.one,
      amount: st.amount, note: st.note, catId: catId
    }) : '';

    if (text) {
      txt.textContent = text;
      txt.classList.remove('gen-text-empty');
      txt.dataset.ready = '1';
      return;
    }

    txt.classList.add('gen-text-empty');
    txt.dataset.ready = '0';
    if (!catList.length) {
      txt.textContent = '還沒有' + tab.labels[catKey] + '，點「管理」建立';
    } else if (!String((st.two ? tab.tplTwo : tab.tplOne) || '').trim()) {
      txt.textContent = '「' + tab.labels[st.two ? 'mode1' : 'mode2']
        + '」還沒有輸出格式，從卡片的 ⋯ 選單進去設定';
    } else if (!catId) {
      txt.textContent = '選一個' + tab.labels[catKey] + '就會出現內容';
    } else {
      txt.textContent = '上面還有欄位沒填';
    }
  }

  function renderUnknown(tab, body) {
    var p = document.createElement('div');
    p.className = 'row-hint';
    p.textContent = '「' + (TYPE_LABEL[tab.type] || tab.type) + '」的編輯介面尚未實作，資料已保留。';
    body.appendChild(p);
  }

  var RENDERERS = {
    note: renderNote,
    quickphrase: renderQuickPhrase,
    todo: renderTodo,
    countdown: renderCountdown,
    link: renderLink,
    codegen: renderCodegen,
    form: renderForm,
    private: renderPrivate
  };

  window.Tabs = {
    openTab: openTab,
    renderCard: renderCard,
    TYPE_LABEL: TYPE_LABEL,
    makeEditable: makeEditable,
    iconBtn: iconBtn,
    // 置頂小視窗失去焦點時用：把展開的私人項目收回去（不解除卡片的鎖定狀態）
    collapsePrivate: forgetOpen
  };
})();
