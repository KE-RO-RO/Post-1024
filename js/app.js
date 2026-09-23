/* ============================================================
   app.js — 進入點：側欄、卡片區重繪、搜尋、數字鍵複製、選單、彈窗
   ============================================================ */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    currentCategoryId: null,
    search: '',
    searchFold: '',   // 搜尋字折成簡體後的樣子，見下方簡繁互轉
    hotkeys: {}   // 複製鍵 → 常用語列的對照表，每次重繪都重建
  };

  /* ============================================================
     簡繁互轉（只用在搜尋比對）
     ------------------------------------------------------------
     搜尋字與被比對的文字都折成簡體再比一次，所以打簡體找得到繁體，
     打繁體也找得到簡體。

     為什麼折成簡體而不是繁體：繁→簡是多對一，方向單純；
     簡→繁是一對多（发 → 發／髮），要靠詞彙判斷才選得對。

     為什麼只做逐字、不換詞彙：詞彙轉換會改變字串長度，
     「記憶體」整個被換成「内存」之後，打「記憶」就比不到了——
     而搜尋幾乎都是打一半。逐字轉換不動長度，部分比對照樣成立。

     字典是 opencc-js 的繁→簡單向包（js/opencc-t2cn.js，109 KB，MIT），
     放在自己的儲存庫而不是 CDN：不依賴第三方、網路環境再嚴格也擋不掉、
     file:// 本機測試也有效。第一次搜尋時才載，不佔開頁時間。
     載不到就整個退回原字比對——搜尋照樣能用，也不跳提示打斷使用者。
     ============================================================ */

  var CC = {
    conv: null,             // 轉換函式；null = 還沒好或載不到
    status: 'idle',         // idle | loading | ready | failed
    cache: Object.create(null),
    cacheSize: 0
  };

  /** 把字串折成簡體。字典還沒好時原樣回傳，呼叫端不必判斷。 */
  function ccFold(s) {
    if (!CC.conv || !s) return s;
    var hit = CC.cache[s];
    if (hit !== undefined) return hit;
    var out;
    try { out = CC.conv(s); } catch (e) { out = s; }
    // 快取的鍵就是字串內容，不會過期；上限只是防止無限成長
    if (CC.cacheSize > 4000) { CC.cache = Object.create(null); CC.cacheSize = 0; }
    CC.cache[s] = out;
    CC.cacheSize++;
    return out;
  }

  /** 第一次搜尋時才去載字典，只載一次。失敗就放棄，不重試也不提示。 */
  function ccLoad() {
    if (CC.status !== 'idle') return;
    CC.status = 'loading';
    var el = document.createElement('script');
    el.src = 'js/opencc-t2cn.js';
    el.onload = function () {
      try {
        CC.conv = window.OpenCC.Converter({ from: 't', to: 'cn' });
      } catch (e) {
        CC.status = 'failed';
        return;
      }
      CC.status = 'ready';
      // 字典是在使用者已經打完字之後才載好的，重算搜尋字並重繪一次
      if (state.search) {
        state.searchFold = ccFold(state.search);
        renderContent();
      }
    };
    el.onerror = function () { CC.status = 'failed'; };
    document.head.appendChild(el);
  }

  /** 搜尋字一律走這裡，避免有人只改了 search 忘了改 searchFold。 */
  function setSearch(v) {
    state.search = String(v || '').trim().toLowerCase();
    state.searchFold = ccFold(state.search);
    if (state.search) ccLoad();
  }

  /* ============================================================
     彈窗
     ============================================================ */

  var modalOnClose = null;
  var modalNoEscape = false;

  function closeModal() {
    var cb = modalOnClose;
    modalOnClose = null;
    modalNoEscape = false;
    if (cb) cb();
    $('modalBackdrop').hidden = true;
    $('modalBody').innerHTML = '';
    $('modalFooter').innerHTML = '';
  }

  /**
   * @param {Object} opt { title, body(Element|string), onClose, buttons:[{text,cls,onClick}] }
   */
  function showModal(opt) {
    modalOnClose = opt.onClose || null;
    // 內含使用者正在編輯的內容時設為 true，Esc 也不關，避免誤按丟資料
    modalNoEscape = !!opt.noEscape;
    $('modalTitle').textContent = opt.title || '';
    var body = $('modalBody');
    body.innerHTML = '';
    if (typeof opt.body === 'string') body.innerHTML = opt.body;
    else if (opt.body) body.appendChild(opt.body);

    var footer = $('modalFooter');
    footer.innerHTML = '';
    (opt.buttons || []).forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = b.cls || 'btn-plain';
      btn.textContent = b.text;
      btn.addEventListener('click', function () {
        if (b.onClick) b.onClick();
      });
      footer.appendChild(btn);
    });

    $('modalBackdrop').hidden = false;

    var first = body.querySelector('input, textarea');
    if (first) { first.focus(); first.select && first.select(); }
  }

  /** 單一輸入欄的小彈窗，取代瀏覽器原生 prompt。 */
  function promptModal(title, label, value, onOk) {
    var wrap = document.createElement('div');
    var l = document.createElement('label');
    l.textContent = label;
    var input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    wrap.appendChild(l);
    wrap.appendChild(input);

    function ok() {
      var v = input.value.trim();
      if (!v) { input.focus(); return; }
      closeModal();
      onOk(v);
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); ok(); }
      e.stopPropagation();
    });

    showModal({
      title: title,
      body: wrap,
      noEscape: true,
      buttons: [
        { text: '取消', onClick: closeModal },
        { text: '確定', cls: 'btn-primary', onClick: ok }
      ]
    });
  }

  function confirmModal(title, message, okText, onOk, danger, onCancel) {
    showModal({
      title: title,
      body: '<div style="line-height:1.7;color:var(--text-dim)">' + message + '</div>',
      buttons: [
        { text: '取消',
          onClick: function () { closeModal(); if (onCancel) onCancel(); } },
        {
          text: okText,
          cls: danger ? 'btn-danger' : 'btn-primary',
          onClick: function () { closeModal(); onOk(); }
        }
      ]
    });
  }

  /* ============================================================
     側欄
     ============================================================ */

  var dragCatId = null;

  function clearCatDropMarks() {
    var list = $('categoryList');
    if (!list) return;
    Array.prototype.forEach.call(list.querySelectorAll('.cat'), function (x) {
      x.classList.remove('drop-target');
      x.classList.remove('drop-move');
    });
  }

  function renderSidebar() {
    var list = $('categoryList');
    list.innerHTML = '';

    DB.categories().forEach(function (cat) {
      var el = document.createElement('div');
      el.className = 'cat' + (cat.id === state.currentCategoryId ? ' active' : '');
      el.draggable = true;
      el.dataset.catId = cat.id;
      if (cat.color) el.dataset.color = cat.color;

      var short = document.createElement('span');
      short.className = 'short';
      short.textContent = cat.shortLabel || cat.name.charAt(0);
      el.appendChild(short);

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = cat.name;
      name.title = cat.name;
      el.appendChild(name);

      /* 到期記號：這個分類有今天到期或已過期的未完成任務就浮一顆小紅點。
         只說「這裡有事」，不說幾件——低調，跟工具整體的克制風格一致。
         滑鼠移上去時讓位給 ⋯（兩者位置相同，見 style.css） */
      if (DB.categoryHasDue(cat.id)) {
        var dueDot = document.createElement('span');
        dueDot.className = 'cat-due';
        dueDot.title = '這個分類有今天到期或已過期的任務';
        el.appendChild(dueDot);
      }

      var more = document.createElement('span');
      more.className = 'more';
      more.textContent = '⋯';
      more.title = '分類選項';
      more.addEventListener('click', function (e) {
        e.stopPropagation();
        openCategoryMenu(cat);
      });
      el.appendChild(more);

      el.addEventListener('click', function () {
        // 全域搜尋中點分類，代表「我要去那個分類」，所以順手把搜尋清掉，
        // 不然畫面還是跨分類的結果，點了等於沒反應
        if (state.search) { $('searchBox').value = ''; setSearch(''); }
        state.currentCategoryId = cat.id;
        render();
      });

      /* 拖曳排序 */
      el.addEventListener('dragstart', function () {
        dragCatId = cat.id;
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', function () {
        dragCatId = null;
        el.classList.remove('dragging');
        clearCatDropMarks();
      });
      el.addEventListener('dragover', function (e) {
        // 拖進來的是卡片 → 這裡是「搬到這個分類」的放置區
        if (dragTabId) {
          var t = DB.findTab(dragTabId);
          if (!t || t.categoryId === cat.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          el.classList.add('drop-move');
          return;
        }
        e.preventDefault();
        if (dragCatId && dragCatId !== cat.id) el.classList.add('drop-target');
      });
      el.addEventListener('dragleave', function () {
        el.classList.remove('drop-target');
        el.classList.remove('drop-move');
      });
      el.addEventListener('drop', function (e) {
        e.preventDefault();
        el.classList.remove('drop-target');
        el.classList.remove('drop-move');
        if (dragTabId) {
          var id = dragTabId;
          dragTabId = null;
          moveTabToCategory(id, cat.id);
          return;
        }
        if (dragCatId && dragCatId !== cat.id) DB.moveCategory(dragCatId, cat.id);
      });

      list.appendChild(el);
    });
  }

  function openCategoryMenu(cat) {
    var wrap = document.createElement('div');
    var acts = [
      ['變更名稱', function () {
        promptModal('變更分類名稱', '分類名稱', cat.name, function (v) {
          DB.renameCategory(cat.id, v);
        });
      }],
      ['移到最上面', function () { closeModal(); DB.moveCategoryEdge(cat.id, true); }],
      ['移到最下面', function () { closeModal(); DB.moveCategoryEdge(cat.id, false); }],
      ['清除這個分類的所有卡片', function () {
        closeModal();
        confirmModal('清除內容',
          '將刪除「' + cat.name + '」底下的所有卡片，分類本身會保留。<br><br>'
          + deleteTail(true),
          '確定清除', function () { DB.clearCategory(cat.id); }, true);
      }],
      ['刪除整個分類', function () {
        closeModal();
        confirmModal('刪除分類',
          '將刪除「' + cat.name + '」以及底下的所有卡片。<br><br>' + deleteTail(true),
          '確定刪除', function () {
            DB.deleteCategory(cat.id);
            if (state.currentCategoryId === cat.id) state.currentCategoryId = null;
            render();
          }, true);
      }]
    ];

    /* 卡片多的時候一張張點很煩，所以整個分類一起開合。範圍限在這個分類。
       便籤卡片的 ⋯ 裡也有同名項目，但那是卡片內的每一筆，層級不同不會混淆。
       這個分類一張卡片都沒有時不顯示，免得按了沒事發生。 */
    if (DB.tabsOf(cat.id).length) {
      var toCollapse = DB.categoryAnyExpanded(cat.id);
      acts.unshift([toCollapse ? '全部收合' : '全部展開', function () {
        closeModal();
        DB.collapseAll(cat.id, toCollapse);
      }]);
    }

    acts.forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'type-opt';
      b.style.width = '100%';
      b.style.marginBottom = '6px';
      b.textContent = a[0];
      b.addEventListener('click', a[1]);
      wrap.appendChild(b);
    });

    // 顏色：點了立刻套用，彈窗不關，方便多試幾個
    var colorTitle = document.createElement('label');
    colorTitle.className = 'swatch-title';
    colorTitle.textContent = '顏色';
    wrap.appendChild(colorTitle);
    var catSwatches = swatchRow(
      [{ key: null, name: '中性' }].concat(paletteOptions()),
      cat.color || null,
      function (key) {
        DB.setCategoryColor(cat.id, key);
        markSwatch(catSwatches, key);
      });
    wrap.appendChild(catSwatches);

    showModal({
      title: '分類：' + cat.name,
      body: wrap,
      buttons: [{ text: '關閉', onClick: closeModal }]
    });
  }

  /* ============================================================
     顏色與外觀
     ============================================================ */

  /** 依設定把主題與上色方式寫到 <html> 上，實際配色全在 CSS 變數裡。 */
  function applyTheme() {
    var th = DB.theme();
    document.documentElement.dataset.theme = th.mode;
    document.documentElement.dataset.cardStyle = th.cardStyle;
    // 自訂配色是另一段 <style>；面板開著的話，主題換了面板也跟著換
    if (window.Theme) Theme.sync();
  }

  /**
   * 一排色票按鈕。options 是 [{ key, name }]，key 為 null 或 'none' 代表中性。
   * 色票本身只帶 data-color，顏色由 CSS 依目前主題決定。
   */
  function swatchRow(options, selected, onPick) {
    var row = document.createElement('div');
    row.className = 'swatch-row';
    options.forEach(function (o) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.title = o.name;
      b.dataset.key = o.key === null ? '' : o.key;
      if (o.key && o.key !== 'none') b.dataset.color = o.key;
      else b.classList.add('neutral');
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        onPick(o.key);
      });
      row.appendChild(b);
    });
    markSwatch(row, selected);
    return row;
  }

  function markSwatch(row, key) {
    var k = key === null || key === undefined ? '' : key;
    Array.prototype.forEach.call(row.querySelectorAll('.swatch'), function (b) {
      b.classList.toggle('sel', b.dataset.key === k);
    });
  }

  function paletteName(key) { return DB.paletteName(key); }

  /** 色票選項，名稱依目前主題 */
  function paletteOptions() {
    return DB.PALETTE.map(function (p) { return { key: p.key, name: DB.paletteName(p.key) }; });
  }

  /* ---- 卡片選色的小視窗 ----
     不用共用彈窗：選色是很輕的動作，跳一個遮住整個畫面的彈窗太重。
     點外面、按 Esc、捲動畫面都會關掉；沒有會遺失的東西，所以放寬。 */

  var colorPop = null;

  function closeColorPop() {
    if (colorPop) { colorPop.remove(); colorPop = null; }
  }

  function pickTabColor(tab, anchor) {
    var wasOpenForThis = colorPop && colorPop.dataset.tabId === tab.id;
    closeColorPop();
    if (wasOpenForThis) return;   // 再點一次同一顆色點 = 收起來

    var pop = document.createElement('div');
    pop.className = 'color-pop';
    pop.dataset.tabId = tab.id;

    // 第一列：跟隨類型，旁邊寫出這個類型目前的預設色
    var def = DB.TYPE_COLOR[tab.type] || null;
    var follow = document.createElement('div');
    follow.className = 'color-pop-follow';
    var followRow = swatchRow([{ key: null, name: '跟隨類型' }], tab.color || null, choose);
    var followBtn = followRow.firstChild;
    if (def) { followBtn.classList.remove('neutral'); followBtn.dataset.color = def; }
    follow.appendChild(followRow);
    var followText = document.createElement('span');
    followText.className = 'color-pop-text';
    followText.textContent = '跟隨類型';
    follow.appendChild(followText);
    var followHint = document.createElement('span');
    followHint.className = 'color-pop-hint';
    followHint.textContent = (Tabs.TYPE_LABEL[tab.type] || '') + '預設：' + paletteName(def);
    follow.appendChild(followHint);
    // 整列都可以點，不只那顆小圓
    follow.addEventListener('click', function () { choose(null); });
    pop.appendChild(follow);

    pop.appendChild(swatchRow(
      paletteOptions().concat([{ key: 'none', name: '中性' }]),
      tab.color,
      choose));

    function choose(key) {
      closeColorPop();
      DB.setTabColor(tab.id, key);
    }

    document.body.appendChild(pop);
    colorPop = pop;

    /* 貼在色點下方、右緣對齊；超出畫面就往內收。

       getBoundingClientRect 量到的是縮放後的實際像素，但寫進 style 的座標
       會再被縮放一次，所以要先除回去。沒除的話畫面放大到 125% 時，
       這個視窗會浮在離色點約 50px 的地方（實測）。 */
    var z = DB.uiZoom();
    var r = anchor.getBoundingClientRect();
    var w = pop.offsetWidth * z, h = pop.offsetHeight * z;
    var left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = (left / z) + 'px';
    pop.style.top = (top / z) + 'px';
  }

  /* ---- ☰ → 外觀 ---- */

  function segControl(options, value, onPick) {
    var seg = document.createElement('div');
    seg.className = 'kind-seg';
    options.forEach(function (o) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = o[1];
      b.dataset.v = o[0];
      if (o[0] === value) b.classList.add('on');
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(seg.children, function (x) {
          x.classList.toggle('on', x === b);
        });
        onPick(o[0]);
      });
      seg.appendChild(b);
    });
    return seg;
  }

  function openAppearance() {
    var th = DB.theme();
    var wrap = document.createElement('div');

    var l1 = document.createElement('label');
    l1.textContent = '主題';
    wrap.appendChild(l1);
    wrap.appendChild(segControl([['dark', '暗色'], ['light', '亮色']], th.mode,
      function (v) { DB.setTheme({ mode: v }); }));

    var l2 = document.createElement('label');
    l2.textContent = '卡片上色';
    wrap.appendChild(l2);
    wrap.appendChild(segControl([['line', '細線'], ['full', '滿版']], th.cardStyle,
      function (v) { DB.setTheme({ cardStyle: v }); }));
    var hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = '細線：左緣色邊加小圓標。滿版：整條標題列上色。' +
      '卡片顏色預設跟著類型走，想換可以點卡片標題列上的小色點。';
    wrap.appendChild(hint);

    // 配色套組的快速切換：預設亮色、預設暗色、存過的套組
    var l3 = document.createElement('label');
    l3.textContent = '配色套組';
    wrap.appendChild(l3);
    var qs = document.createElement('div');
    qs.className = 'quick-slots';
    var reopen = function () { closeModal(); openAppearance(); };   // 套用後重畫，按鈕狀態才會對
    [['light', '預設亮色'], ['dark', '預設暗色']].forEach(function (f) {
      var b = document.createElement('button');
      b.className = 'btn-plain';
      b.textContent = f[1];
      if (th.activeSlot === null && th.mode === f[0] && !Object.keys(DB.themeCustom(f[0])).length) b.classList.add('on');
      b.addEventListener('click', function () { Theme.applyFactory(f[0], reopen); });
      qs.appendChild(b);
    });
    DB.slots().forEach(function (slot, i) {
      if (!slot) return;   // 空的格子不顯示
      var b = document.createElement('button');
      b.className = 'btn-plain';
      var dot = document.createElement('i');
      dot.style.background = Theme.slotAccent(i);
      b.appendChild(dot);
      b.appendChild(document.createTextNode(DB.slotName(i)));
      if (th.activeSlot === i) b.classList.add('on');
      b.addEventListener('click', function () { Theme.applySlot(i, reopen); });
      qs.appendChild(b);
    });
    wrap.appendChild(qs);

    var more = document.createElement('button');
    more.className = 'btn-plain appearance-more';
    more.textContent = '自訂配色…';
    more.addEventListener('click', function () { closeModal(); Theme.open(); });
    wrap.appendChild(more);

    // 改了立刻生效、沒有會遺失的東西，所以 Esc 可以關
    showModal({
      title: '外觀',
      body: wrap,
      buttons: [{ text: '關閉', onClick: closeModal }]
    });
  }

  /* ============================================================
     編輯彈窗
     ------------------------------------------------------------
     常用語的編輯只能從鉛筆進來。刻意不做就地編輯，因為那會跟
     「點一下複製」搶同一塊可點區域，實測很容易想複製卻點成編輯。
     ============================================================ */

  /**
   * 倒數任務的新增與編輯。名稱、日期、時間三欄一起處理。
   * item 給 null 就是新增——新增直接開這個彈窗，不先生一列空白（同 5.1 的做法）。
   */
  function editDueItem(tab, item) {
    var isNew = !item;
    var wrap = document.createElement('div');

    var nameInput = labeledInput(wrap, '任務名稱', 'text',
      isNew ? '' : (item.text || ''), '這件事要做什麼');

    var dateInput = labeledInput(wrap, '日期（留空就是未定日期）', 'date',
      isNew ? '' : (item.due || ''), '');
    // 點文字區也要跳日曆，不是只有右邊那個小圖示（11.8）
    dateInput.addEventListener('click', function () {
      if (typeof dateInput.showPicker === 'function') {
        try { dateInput.showPicker(); } catch (err) { /* 退回瀏覽器預設行為 */ }
      }
    });

    var timeInput = labeledInput(wrap, '時間（可留空）', 'time',
      isNew ? '' : (item.time || ''), '');

    var hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = '沒填時間就代表「那一天」，會在當天結束後才算過期。';
    wrap.appendChild(hint);

    showModal({
      title: isNew ? '新增任務' : '編輯任務',
      body: wrap,
      // 裡面有使用者打的內容，點背景與 Esc 都不關（4.5）
      noEscape: true,
      buttons: [
        { text: '取消', onClick: closeModal },
        {
          text: '儲存',
          cls: 'btn-primary',
          onClick: function () {
            var target = item;
            if (isNew) {
              target = { id: DB.uid(), text: '', done: false, due: '', time: '', order: tab.items.length };
              tab.items.push(target);
            }
            target.text = nameInput.value.trim();
            target.due = DB.normalizeDue(dateInput.value);
            // 沒有日期的話時間沒有意義，一併清掉，避免留下看不到卻還在檔案裡的值
            target.time = target.due ? DB.normalizeTime(timeInput.value) : '';
            tab.updatedAt = DB.nowIso();
            closeModal();
            DB.touch();
          }
        }
      ]
    });
    nameInput.focus();
  }

  function editPhrase(tab, row) {
    var wrap = document.createElement('div');

    var l1 = document.createElement('label');
    l1.textContent = '標籤（簡短名稱，方便你辨認）';
    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = row.label || '';
    labelInput.placeholder = '簡短名稱，方便你辨認';

    var l2 = document.createElement('label');
    l2.textContent = '內容（實際複製出去的完整文字）';
    var contentInput = document.createElement('textarea');
    contentInput.rows = 8;
    contentInput.value = row.content || '';
    contentInput.placeholder = '在這裡輸入要複製出去的完整文字，可以換行';

    /* ---- 複製鍵錄製 ---- */
    var l3 = document.createElement('label');
    l3.textContent = '複製鍵（可留空）';

    var keyBar = document.createElement('div');
    keyBar.className = 'key-bar';

    var keyBox = document.createElement('div');
    keyBox.className = 'key-box';

    var recordBtn = document.createElement('button');
    recordBtn.className = 'btn-plain';
    recordBtn.textContent = '設定';

    var clearBtn = document.createElement('button');
    clearBtn.className = 'btn-plain';
    clearBtn.textContent = '清除';

    var keyErr = document.createElement('div');
    keyErr.className = 'key-err';
    keyErr.hidden = true;

    var pendingKey = DB.normalizeHotkey(row.hotkey);
    var recording = false;

    function paintKey() {
      if (recording) {
        keyBox.textContent = '請按下要用的鍵…（Esc 取消）';
        keyBox.className = 'key-box recording';
      } else if (pendingKey) {
        keyBox.textContent = pendingKey.replace('ALT+', 'Alt+');
        keyBox.className = 'key-box';
      } else {
        keyBox.textContent = '未設定';
        keyBox.className = 'key-box unset';
      }
    }
    paintKey();

    function showKeyError(msg) {
      keyErr.textContent = msg;
      keyErr.hidden = !msg;
    }

    /**
     * 錄製期間攔截所有按鍵。用 capture 階段是為了確保先於其他 handler 拿到，
     * 不然按 Esc 會被彈窗的關閉邏輯先吃掉。
     */
    function onRecord(e) {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') { stopRecord(); return; }
      // 只按住修飾鍵不算，等真正的字元鍵
      if (['Alt', 'Control', 'Shift', 'Meta'].indexOf(e.key) >= 0) return;

      if (e.ctrlKey || e.metaKey) {
        showKeyError('不支援 Ctrl 或 Win 組合，瀏覽器多半已經占用了。');
        return;
      }

      var ch = String(e.key).toUpperCase();
      if (!/^[0-9A-Z]$/.test(ch)) {
        showKeyError('只能用 0～9 或 A～Z，可搭配 Alt。');
        return;
      }

      var candidate = (e.altKey ? 'ALT+' : '') + ch;
      var conflict = DB.findHotkeyConflict(tab.categoryId, candidate, row.id);
      if (conflict) {
        showKeyError('這個鍵已經給「' + (conflict.row.label || '未命名') +
                     '」用了（' + conflict.tab.title + '）。');
        return;
      }

      pendingKey = candidate;
      showKeyError('');
      stopRecord();
    }

    function startRecord() {
      if (recording) return;
      recording = true;
      showKeyError('');
      paintKey();
      document.addEventListener('keydown', onRecord, true);
    }

    function stopRecord() {
      if (!recording) return;
      recording = false;
      document.removeEventListener('keydown', onRecord, true);
      paintKey();
    }

    recordBtn.addEventListener('click', startRecord);
    keyBox.addEventListener('click', startRecord);
    clearBtn.addEventListener('click', function () {
      stopRecord();
      pendingKey = '';
      showKeyError('');
      paintKey();
    });

    keyBar.appendChild(keyBox);
    keyBar.appendChild(recordBtn);
    keyBar.appendChild(clearBtn);

    wrap.appendChild(l1);
    wrap.appendChild(labelInput);
    wrap.appendChild(l2);
    wrap.appendChild(contentInput);
    wrap.appendChild(l3);
    wrap.appendChild(keyBar);
    wrap.appendChild(keyErr);

    function save() {
      stopRecord();
      row.label = labelInput.value.trim();
      row.content = contentInput.value;
      row.hotkey = pendingKey;
      tab.updatedAt = DB.nowIso();
      closeModal();
      DB.touch();
    }

    labelInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); contentInput.focus(); }
      e.stopPropagation();
    });
    contentInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); save(); }
      e.stopPropagation();
    });

    showModal({
      title: '編輯常用語',
      body: wrap,
      noEscape: true,
      onClose: stopRecord,
      buttons: [
        { text: '取消', onClick: function () { stopRecord(); closeModal(); } },
        { text: '儲存', cls: 'btn-primary', onClick: save }
      ]
    });
  }

  function editLink(tab, link) {
    var wrap = document.createElement('div');

    var l1 = document.createElement('label');
    l1.textContent = '名稱';
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = link.name || '';
    nameInput.placeholder = '例：Yahoo';

    var l2 = document.createElement('label');
    l2.textContent = '網址（一行一條，多條會隨機開其中一條）';
    var urlInput = document.createElement('textarea');
    urlInput.rows = 5;
    urlInput.value = (link.urls || []).join('\n');
    urlInput.placeholder = 'https://example.com\nhttps://example.org';

    var hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = '只填一條就是一般連結。填多條的話，每次開啟隨機挑其中一條。';

    wrap.appendChild(l1);
    wrap.appendChild(nameInput);
    wrap.appendChild(l2);
    wrap.appendChild(urlInput);
    wrap.appendChild(hint);

    function save() {
      link.name = nameInput.value.trim();
      link.urls = urlInput.value
        .split('\n')
        .map(function (u) { return u.trim(); })
        .filter(function (u, i, arr) { return u && arr.indexOf(u) === i; });
      tab.updatedAt = DB.nowIso();
      closeModal();
      DB.touch();
    }

    nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); urlInput.focus(); }
      e.stopPropagation();
    });
    urlInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); save(); }
      e.stopPropagation();
    });

    showModal({
      title: '編輯連結',
      body: wrap,
      noEscape: true,
      buttons: [
        { text: '取消', onClick: closeModal },
        { text: '儲存', cls: 'btn-primary', onClick: save }
      ]
    });
  }

  /* ============================================================
     私人卡片：建立、解鎖、編輯
     ============================================================ */

  var AUTO_LOCK_MINUTES = 10;   // 解鎖後固定 10 分鐘就鎖，不因操作重置
  // 搜尋去抖：停手這麼久之後才真的搜。太短沒效果，太長會像沒反應
  var SEARCH_DELAY = 150;

  /* ============================================================
     便籤：新增一筆（先選型別）／欄位型別的「管理欄位」（v4.23）
     ------------------------------------------------------------
     新增時彈窗最上面選型別，比照私人卡片（9.9）。自由格式照舊是一段文字；
     欄位型別是標題行＋一個框、一行一欄（使用者看過三案截圖後選的 A 案）。
     item 給了就是編輯既有的欄位型別，不再出現型別切換——
     改型別等於換一種東西，重新建一筆比較不會弄丟內容。
     ============================================================ */
  function editNoteItem(tab, item) {
    var isNew = !item;
    var kind = isNew ? 'free' : 'form';
    var wrap = document.createElement('div');

    var seg = null;
    if (isNew) {
      var kl = document.createElement('label');
      kl.textContent = '型別';
      wrap.appendChild(kl);
      seg = document.createElement('div');
      seg.className = 'kind-seg';
      wrap.appendChild(seg);
    }

    var freeBox = document.createElement('div');
    var formBox = document.createElement('div');
    wrap.appendChild(freeBox);
    wrap.appendChild(formBox);

    var cl = document.createElement('label');
    cl.textContent = '內容（可留空）';
    var content = document.createElement('textarea');
    content.rows = 5;
    freeBox.appendChild(cl);
    freeBox.appendChild(content);

    var title = labeledInput(formBox, '標題行（可留空）', 'text',
      item ? item.title : '', '留空的話，卡片上與複製出來都不會有這一行');

    var fl = document.createElement('label');
    fl.textContent = '欄位（一行一個）';
    var fields = document.createElement('textarea');
    fields.rows = 8;
    fields.value = item ? DB.noteFieldsText(item.fields) : '';
    fields.placeholder = '欄位名\n欄位名：預設值';
    formBox.appendChild(fl);
    formBox.appendChild(fields);

    var hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = '想帶預設值就寫「欄位名：預設值」。空白行會自動忽略，' +
      '順序就是卡片上的順序。';
    formBox.appendChild(hint);

    function applyKind() {
      freeBox.hidden = kind !== 'free';
      formBox.hidden = kind !== 'form';
      if (seg) {
        Array.prototype.forEach.call(seg.children, function (b) {
          b.classList.toggle('on', b.dataset.kind === kind);
        });
      }
    }

    if (seg) {
      [['free', '自由格式'], ['form', '欄位']].forEach(function (k) {
        var b = document.createElement('button');
        b.type = 'button';
        b.dataset.kind = k[0];
        b.textContent = k[1];
        b.addEventListener('click', function () {
          kind = k[0];
          applyKind();
          (kind === 'form' ? title : content).focus();
        });
        seg.appendChild(b);
      });
    }
    applyKind();

    function save() {
      if (kind === 'form') {
        var next = DB.noteFieldsParse(fields.value, item ? item.fields : null);
        if (isNew) {
          tab.items.push({ id: DB.uid(), kind: 'form', content: '', open: true,
            order: tab.items.length, title: title.value.trim(), fields: next });
        } else {
          item.title = title.value.trim();
          item.fields = next;
        }
      } else {
        tab.items.push({ id: DB.uid(), kind: 'free', content: content.value,
          open: true, order: tab.items.length });
      }
      tab.updatedAt = DB.nowIso();
      closeModal();
      DB.touch();
    }

    title.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); fields.focus(); }
    });
    [content, fields].forEach(function (ta) {
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); save(); }
        e.stopPropagation();
      });
    });

    showModal({
      title: isNew ? '新增一筆' : '管理欄位',
      body: wrap,
      noEscape: true,
      buttons: [
        { text: '取消', onClick: closeModal },
        { text: '儲存', cls: 'btn-primary', onClick: save }
      ]
    });
    // showModal 會把焦點給第一個輸入框；那可能是藏起來的那一格
    (kind === 'form' ? title : content).focus();
  }

  function labeledInput(wrap, labelText, type, value, placeholder) {
    var l = document.createElement('label');
    l.textContent = labelText;
    var i = document.createElement('input');
    i.type = type || 'text';
    i.value = value || '';
    if (placeholder) i.placeholder = placeholder;
    i.addEventListener('keydown', function (e) { e.stopPropagation(); });
    wrap.appendChild(l);
    wrap.appendChild(i);
    return i;
  }

  /**
   * 新增私人卡片時強制二選一，不給預設值。
   *
   * 加密與不加密是完全不同的東西，不該有一個「順手按下去」的預設答案。
   * 兩張卡片的行為差異本身就是最清楚的區分：加密的一定要輸密碼才看得到，
   * 不加密的一打開就在那裡。所以卡片上不另外加「未加密」的警告標籤。
   */
  function askPrivateMode() {
    var grid = document.createElement('div');
    grid.className = 'type-grid';

    [
      ['enc', '加密保存', '需要主密碼才看得到，存在瀏覽器裡的是密文'],
      ['plain', '不加密', '直接看得到，內容以明文存放。適合不需要保護的記事']
    ].forEach(function (m) {
      var b = document.createElement('button');
      b.className = 'type-opt';
      b.innerHTML = '<strong>' + m[1] + '</strong><small>' + m[2] + '</small>';
      if (m[0] === 'enc' && !Vault.available()) {
        b.disabled = true;
        b.innerHTML = '<strong>' + m[1] + '</strong><small>這個環境不支援加密</small>';
      } else {
        b.addEventListener('click', function () {
          closeModal();
          promptModal('新增私人卡片', '卡片標題', '未命名', function (title) {
            var tab = DB.addTab('private', state.currentCategoryId, title);
            tab.encrypted = (m[0] === 'enc');
            DB.touch();
            // 加密的話立刻設定金鑰；不加密的直接就能用
            if (tab.encrypted) openCard(tab, null);
          });
        });
      }
      grid.appendChild(b);
    });

    showModal({
      title: '這張卡片要加密嗎',
      body: grid,
      buttons: [{ text: '取消', onClick: closeModal }]
    });
  }

  /**
   * 加密與不加密互轉。
   *
   * 轉成加密：現有明文用新建的卡片金鑰加密後寫進 tab.enc，清掉 tab.entries。
   * 轉成不加密：**要先驗身分**，把明文攤回 tab.entries 並清掉 tab.enc。
   *   這個方向等於主動降低保護，所以驗證不能省。
   */
  function convertPrivate(tab) {
    if (tab.encrypted) {
      /* 解鎖只是拿到金鑰，明文是畫面重繪時才解出來的。
         所以這裡一定要自己 decryptFor 拿內容，不能用 getPlain——
         第一版就是這樣把空陣列寫進 entries、又清掉 enc，內容整個沒了。 */
      var toPlain = function () {
        Vault.decryptFor(tab.id, tab.enc).then(function (list) {
          confirmModal('取消加密',
            '「' + (tab.title || '未命名') + '」的 ' + (list || []).length + ' 筆內容會改成' +
            '<strong>明文</strong>存放，任何能打開這個瀏覽器的人都看得到，' +
            '匯出檔裡也會是明文。<br><br>內容本身不會遺失，之後可以再加回密碼保護。',
            '改為不加密',
            function () {
              tab.entries = list || [];
              tab.encrypted = false;
              tab.enc = null;
              tab.vault = null;
              Vault.lockCard(tab.id);
              DB.touch();
              // 這可能是最後一張加密卡片，主密碼要跟著消失
              Vault.dropMasterIfUnused();
              Clip.toast('已改為不加密');
              render();
            }, true);
        }, function () {
          Clip.toast('內容解不開，沒有做任何變更', true);
        });
      };

      /* 一律要驗身分，即使卡片現在是解開的。
         「看得到內容」和「把內容永久攤成明文」是兩件事——後者的效果
         在鎖定之後依然存在，等於繞過整個加密。所以不能因為畫面上
         已經看得到就省略驗證。 */
      if (Vault.isCardUnlocked(tab.id)) askSecret(tab, toPlain);
      else openCard(tab, toPlain);
      return;
    }

    confirmModal('加上密碼保護',
      '「' + (tab.title || '未命名') + '」的內容會被加密，之後要輸入主密碼才看得到。',
      '繼續', function () {
        /* 旗標與 entries 都等成功了才動。中途取消密碼彈窗的話，
           卡片要維持原狀，不能留下一個空殼。 */
        var list = tab.entries || [];
        openCard(tab, function () {
          Vault.setPlain(tab.id, list);
          tab.encrypted = true;
          tab.entries = [];
          savePrivate(tab).then(function () {
            Clip.toast('已加上密碼保護');
            render();
          });
        });
      });
  }

  /**
   * 第一次使用加密時建立主密碼，並把復原金鑰交給使用者。
   * 建完主金鑰之後接著幫這張卡片建立它專屬的金鑰包裹。
   */
  function setupMasterFor(tab, onDone) {
    var wrap = document.createElement('div');
    var p1 = labeledInput(wrap, '設定主密碼', 'password', '', '長度不限，越長越安全');
    var p2 = labeledInput(wrap, '再輸入一次', 'password', '');

    var err = document.createElement('div');
    err.className = 'key-err';
    err.hidden = true;
    wrap.appendChild(err);

    var note = document.createElement('div');
    note.className = 'field-hint';
    note.textContent = '這組密碼不會被儲存在任何地方。設定完成後會產生一組復原金鑰，' +
                       '那是忘記密碼時唯一的救援方式。';
    wrap.appendChild(note);

    function go() {
      err.hidden = true;
      if (p1.value.length < 4) { err.textContent = '主密碼太短了'; err.hidden = false; return; }
      if (p1.value !== p2.value) { err.textContent = '兩次輸入不一致'; err.hidden = false; return; }

      var pw = p1.value;
      Vault.setupMaster(pw).then(function (recovery) {
        return Vault.createCard(tab.id, pw, AUTO_LOCK_MINUTES).then(function (v) {
          tab.vault = v;
          Vault.setPlain(tab.id, []);
          DB.touch();
          closeModal();
          showRecoveryKey(recovery, onDone);
        });
      }, function (e) {
        err.textContent = '建立失敗：' + (e && e.message || '未知錯誤');
        err.hidden = false;
      });
    }

    p2.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });

    showModal({
      title: '設定主密碼',
      body: wrap,
      noEscape: true,
      buttons: [
        { text: '取消', onClick: closeModal },
        { text: '建立', cls: 'btn-primary', onClick: go }
      ]
    });
  }

  /** 復原金鑰只在這一刻出現一次，之後任何地方都看不到。 */
  function showRecoveryKey(recovery, onDone) {
    var wrap = document.createElement('div');

    var intro = document.createElement('div');
    intro.style.cssText = 'color:var(--text-dim);font-size:13px;line-height:1.8;margin-bottom:12px';
    intro.innerHTML = '這組復原金鑰<strong style="color:var(--text)">只會出現這一次</strong>。' +
      '忘記主密碼時，它是唯一能救回內容的方式。<br><br>' +
      '請抄下來存在這個工具以外的地方（寄給自己、或寫在紙上）。' +
      '只留在瀏覽器裡等於沒有——系統還原就會一起消失。';
    wrap.appendChild(intro);

    var box = document.createElement('div');
    box.className = 'recovery-key';
    box.textContent = recovery;
    wrap.appendChild(box);

    var copyBtn = document.createElement('button');
    copyBtn.className = 'btn-plain';
    copyBtn.style.cssText = 'width:100%;margin-bottom:12px';
    copyBtn.textContent = '複製復原金鑰';
    copyBtn.addEventListener('click', function () { Clip.copy(recovery, box, '復原金鑰'); });
    wrap.appendChild(copyBtn);

    var confirmWrap = document.createElement('label');
    confirmWrap.style.cssText = 'display:flex;gap:8px;align-items:center;cursor:pointer;color:var(--text)';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.style.accentColor = 'var(--accent)';
    confirmWrap.appendChild(cb);
    confirmWrap.appendChild(document.createTextNode('我已經把它存在別的地方了'));
    wrap.appendChild(confirmWrap);

    var doneBtn = { text: '完成', cls: 'btn-primary', onClick: function () {
      if (!cb.checked) { Clip.toast('請先確認你已經抄下來了', true); return; }
      closeModal();
      if (onDone) onDone();
      render();
    } };

    cb.addEventListener('keydown', function (e) { e.stopPropagation(); });

    showModal({ title: '復原金鑰', body: wrap, noEscape: true, buttons: [doneBtn] });
  }

  /**
   * 解開「一張」卡片。各卡片獨立：開這張不會連帶開別張。
   * 同時提供「用復原金鑰」與「兩個都忘了」的出路。
   */
  function openCard(tab, onDone) {
    if (!Vault.available()) {
      showModal({
        title: '這個環境不支援加密',
        body: '<div style="line-height:1.85;color:var(--text-dim);font-size:13px">' +
          '這個瀏覽器沒有提供網頁加密功能（<strong style="color:var(--text)">crypto.subtle</strong>），' +
          '所以加密卡片無法使用。<br><br>' +
          '請改用較新的瀏覽器，或用 https 開頭的網址開啟本工具。</div>',
        buttons: [{ text: '知道了', onClick: closeModal }]
      });
      return;
    }

    // 還沒有主金鑰 → 這是第一張加密卡片，先建立主密碼
    if (!Vault.masterExists()) { setupMasterFor(tab, onDone); return; }
    // 有主金鑰但這張卡片還沒有自己的包裹 → 幫它建一個
    if (!tab.vault) { attachCardVault(tab, onDone); return; }

    var wrap = document.createElement('div');
    var pw = labeledInput(wrap, '主密碼', 'password', '');

    var err = document.createElement('div');
    err.className = 'key-err';
    err.hidden = true;
    wrap.appendChild(err);

    var links = document.createElement('div');
    links.className = 'modal-links';
    var forgot = document.createElement('button');
    forgot.className = 'link-btn';
    forgot.textContent = '忘記主密碼';
    forgot.addEventListener('click', function () { closeModal(); useRecovery(tab, onDone); });
    links.appendChild(forgot);
    wrap.appendChild(links);

    function go() {
      err.hidden = true;
      Vault.unlockCard(tab.id, tab.vault, pw.value, AUTO_LOCK_MINUTES).then(function () {
        closeModal();
        Clip.toast('已解鎖，' + AUTO_LOCK_MINUTES + ' 分鐘後自動隱藏');
        render();
        if (onDone) onDone();
      }, function () {
        err.textContent = '主密碼不正確';
        err.hidden = false;
        pw.select();
      });
    }

    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });

    showModal({
      title: '輸入主密碼',
      body: wrap,
      noEscape: true,
      buttons: [
        { text: '取消', onClick: closeModal },
        { text: '確定', cls: 'btn-primary', onClick: go }
      ]
    });
  }

  function useRecovery(tab, onDone) {
    var wrap = document.createElement('div');
    var key = labeledInput(wrap, '復原金鑰', 'text', '', 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX');
    var p1 = labeledInput(wrap, '設定新的主密碼', 'password', '');
    var p2 = labeledInput(wrap, '再輸入一次', 'password', '');

    var err = document.createElement('div');
    err.className = 'key-err';
    err.hidden = true;
    wrap.appendChild(err);

    var links = document.createElement('div');
    links.className = 'modal-links';
    var wipe = document.createElement('button');
    wipe.className = 'link-btn danger';
    wipe.textContent = '復原金鑰也不見了';
    wipe.addEventListener('click', function () { closeModal(); confirmWipe(); });
    links.appendChild(wipe);
    wrap.appendChild(links);

    function go() {
      err.hidden = true;
      if (p1.value.length < 4) { err.textContent = '主密碼太短了'; err.hidden = false; return; }
      if (p1.value !== p2.value) { err.textContent = '兩次輸入不一致'; err.hidden = false; return; }

      /* 復原金鑰是破窗路徑：先用它打開這張卡片，再把主密碼換掉。
         換密碼要重新包裹主金鑰與「每一張」加密卡片的密碼包裹，
         所以要先把全部卡片撈出來交給 vault 層。 */
      var cards = DB.raw().tabs.filter(function (t) {
        return t.type === 'private' && t.encrypted && t.vault;
      }).map(function (t) { return { id: t.id, vault: t.vault }; });

      /* 每張卡片的 pwd 包裹是用「主密碼」包的，不是用復原金鑰包的，
         所以重設時要走主金鑰那條路重新包裹，不能拿金鑰去解卡片包裹。 */
      Vault.unlockCard(tab.id, tab.vault, key.value, AUTO_LOCK_MINUTES).then(function () {
        return Vault.resetPassword(key.value, p1.value, cards);
      }).then(function (out) {
        DB.raw().vault.pwd = out.master;
        DB.raw().tabs.forEach(function (t) {
          if (out[t.id]) t.vault.pwd = out[t.id];
        });
        DB.touch();
        closeModal();
        Clip.toast('主密碼已更新');
        render();
        if (onDone) onDone();
      }, function () {
        err.textContent = '復原金鑰不正確';
        err.hidden = false;
      });
    }

    showModal({
      title: '用復原金鑰重設',
      body: wrap,
      noEscape: true,
      buttons: [
        { text: '取消', onClick: closeModal },
        { text: '重設', cls: 'btn-primary', onClick: go }
      ]
    });
  }

  function confirmWipe() {
    confirmModal('無法復原',
      '主密碼與復原金鑰都遺失時，<strong>沒有任何方法能解開已加密的內容</strong>。' +
      '這是加密本身的性質，不是設計上的限制。<br><br>' +
      '唯一的出路是把所有「私人」卡片刪除、重新建立一組主密碼。',
      '全部刪除並重來',
      function () {
        Vault.reset();
        Clip.toast('已清除');
        render();
      }, true);
  }

  function lockCard(tab) {
    Vault.lockCard(tab.id);
    Clip.toast('內容已隱藏');
    render();
  }

  /**
   * 主金鑰已經存在，但這張卡片還沒有自己的金鑰包裹時用。
   * 需要主密碼才能取出主金鑰去做第二層包裹。
   */
  function attachCardVault(tab, onDone) {
    var wrap = document.createElement('div');
    var pw = labeledInput(wrap, '主密碼', 'password', '');

    var hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = '這張卡片會用你既有的主密碼保護，不會另外產生新的復原金鑰。';
    wrap.appendChild(hint);

    var err = document.createElement('div');
    err.className = 'key-err';
    err.hidden = true;
    wrap.appendChild(err);

    function go() {
      err.hidden = true;
      Vault.createCard(tab.id, pw.value, AUTO_LOCK_MINUTES).then(function (v) {
        tab.vault = v;
        if (!Vault.getPlain(tab.id)) Vault.setPlain(tab.id, []);
        DB.touch();
        closeModal();
        render();
        if (onDone) onDone();
      }, function () {
        err.textContent = '主密碼不正確。如果你不確定目前的主密碼是哪一組，' +
                          '可以用復原金鑰重設（在任何一張鎖住的卡片上點「忘記主密碼」）。';
        err.hidden = false;
        pw.select();
      });
    }

    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });

    showModal({
      title: '設定這張卡片的保護',
      body: wrap,
      noEscape: true,
      buttons: [
        { text: '取消', onClick: closeModal },
        { text: '確定', cls: 'btn-primary', onClick: go }
      ]
    });
  }

  /** 儲存一張私人卡片：把記憶體裡的明文加密後寫回 tab.enc。 */
  /**
   * 儲存一張私人卡片。
   * 加密卡片：把記憶體裡的明文用該卡片自己的金鑰加密後寫回 tab.enc。
   * 不加密卡片：內容本來就在 tab.entries，直接存檔。
   */
  function savePrivate(tab) {
    if (!tab.encrypted) {
      tab.updatedAt = DB.nowIso();
      DB.touch();
      return Promise.resolve();
    }
    var entries = Vault.getPlain(tab.id) || [];
    return Vault.encryptFor(tab.id, entries).then(function (blob) {
      tab.enc = blob;
      tab.updatedAt = DB.nowIso();
      DB.touch();
    }, function () {
      Clip.toast('儲存失敗，內容沒有寫入', true);
    });
  }

  /** 讀出一張私人卡片目前可用的內容。鎖著的加密卡片回傳 null。 */
  function privateEntries(tab) {
    return tab.encrypted ? Vault.getPlain(tab.id) : (tab.entries || []);
  }

  function setPrivateEntries(tab, list) {
    if (tab.encrypted) Vault.setPlain(tab.id, list);
    else tab.entries = list;
  }

  /** 編輯單筆。item 為 null 代表新增。 */
  /**
   * 刪除私人內容前先驗身分。
   *
   * 順序是「先驗證 → 再確認」：驗過了才問要不要刪，才不會讓人打完密碼
   * 又在確認彈窗前退出，白打一次。
   *
   * 還沒建立保管層的空白卡片沒有東西可驗，直接走一般確認。
   */
  function confirmDeletePrivate(tab, title, message, onOk, recoverable) {
    var confirm = function () {
      confirmModal(title, message + '<br><br>' + deleteTail(recoverable),
        '確定刪除', onOk, true);
    };
    // 不加密的卡片沒有東西可驗，走一般確認
    if (!tab || !tab.encrypted || !tab.vault || !Vault.available()) return confirm();
    askSecret(tab, confirm);
  }

  /**
   * 只問密碼、只驗身分，驗過就把控制權交出去。
   *
   * 刻意不自己決定後續文案——刪除、匯出、取消加密都會用到這個彈窗，
   * 但三者要說的話完全不同。之前把刪除的文案寫死在這裡，導致取消加密
   * 時跳出「確定刪除／此動作無法復原」，訊息與實際行為不符。
   */
  function askSecret(tab, onOk) {
    var wrap = document.createElement('div');
    var input = labeledInput(wrap, '主密碼', 'password', '', '');

    var hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = '這裡也接受復原金鑰。驗證只是確認身分，不會把內容打開。';
    wrap.appendChild(hint);

    var err = document.createElement('div');
    err.className = 'key-err';
    err.hidden = true;
    wrap.appendChild(err);

    function go() {
      err.hidden = true;
      if (!input.value) { err.textContent = '請先輸入主密碼'; err.hidden = false; return; }
      Vault.verifyCard(tab.vault, input.value).then(function () {
        closeModal();
        onOk();
      }, function () {
        err.textContent = '主密碼或復原金鑰不正確';
        err.hidden = false;
        input.value = '';
        input.focus();
      });
    }

    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });

    showModal({
      title: '確認身分',
      body: wrap,
      noEscape: true,
      buttons: [
        { text: '取消', onClick: closeModal },
        { text: '繼續', cls: 'btn-primary', onClick: go }
      ]
    });
  }

  function editPrivate(tab, item) {
    var isNew = !item;
    var kind = (item && item.kind === 'memo') ? 'memo' : 'info';
    var wrap = document.createElement('div');

    /* 型別只影響中間那段欄位。名稱與網址兩種都有——
       名稱是摺疊時唯一露出來的東西，網址驅動鏈條鈕。 */
    var kl = document.createElement('label');
    kl.textContent = '型別';
    wrap.appendChild(kl);

    var seg = document.createElement('div');
    seg.className = 'kind-seg';
    wrap.appendChild(seg);

    var infoBox = document.createElement('div');
    var memoBox = document.createElement('div');

    var name = labeledInput(wrap, '名稱', 'text', item && item.name, '方便你辨認的名稱');
    var url  = labeledInput(wrap, '網址（可留空）', 'text', item && item.url, 'https://');
    wrap.appendChild(infoBox);
    wrap.appendChild(memoBox);

    var user = labeledInput(infoBox, '帳號', 'text', item && item.user, '');
    var pass = labeledInput(infoBox, '密碼', 'text', item && item.pass, '');

    var nl = document.createElement('label');
    var note = document.createElement('textarea');
    note.rows = 3;
    note.value = (item && item.note) || '';
    note.addEventListener('keydown', function (e) { e.stopPropagation(); });
    memoBox.appendChild(nl);
    memoBox.appendChild(note);

    var hint = document.createElement('div');
    hint.className = 'field-hint';
    wrap.appendChild(hint);

    function applyKind() {
      var isMemo = kind === 'memo';
      infoBox.hidden = isMemo;
      nl.textContent = isMemo ? '內容' : '備註（可留空）';
      hint.textContent = isMemo
        ? '摺疊時只會看到名稱，內容要點開才顯示。'
        : '密碼欄位在這裡是明碼顯示，方便你確認有沒有打錯。存檔後在卡片上會遮起來。';
      Array.prototype.forEach.call(seg.children, function (b) {
        b.classList.toggle('on', b.dataset.kind === kind);
      });
    }

    [['info', '資訊'], ['memo', '備忘錄']].forEach(function (k) {
      var b = document.createElement('button');
      b.type = 'button';
      b.dataset.kind = k[0];
      b.textContent = k[1];
      b.addEventListener('click', function () { kind = k[0]; applyKind(); });
      seg.appendChild(b);
    });
    applyKind();

    function save() {
      var list = privateEntries(tab) || [];
      var isMemo = kind === 'memo';
      var payload = {
        kind: kind,
        name: name.value.trim(),
        url: url.value.trim(),
        // 切成備忘錄時清掉帳密，避免留下看不到但還在檔案裡的殘值
        user: isMemo ? '' : user.value.trim(),
        pass: isMemo ? '' : pass.value,
        note: note.value.trim()
      };
      if (isNew) {
        payload.id = DB.uid();
        list.push(payload);
      } else {
        Object.keys(payload).forEach(function (k) { item[k] = payload[k]; });
      }
      setPrivateEntries(tab, list);
      closeModal();
      savePrivate(tab);
    }

    showModal({
      title: isNew ? '新增一筆' : '編輯',
      body: wrap,
      noEscape: true,
      buttons: [
        { text: '取消', onClick: closeModal },
        { text: '儲存', cls: 'btn-primary', onClick: save }
      ]
    });
  }

  /* ============================================================
     批次開啟網址
     ------------------------------------------------------------
     Chrome 預設只放行一次點擊裡的第一個 window.open，其餘視為彈出視窗擋掉。
     被擋時 window.open 回傳 null，據此統計並提示使用者去開白名單。
     ============================================================ */

  /** 彈出視窗放行的說明。可從批次開啟時自動跳出，也可從卡片上的 ⓘ 主動叫出。 */
  function showPopupHelp(stats) {
    var head = '';
    if (stats) {
      head = '這次成功開啟 <strong style="color:var(--text)">' + stats.opened +
             '</strong> 個，被擋下 <strong style="color:var(--text)">' + stats.blocked +
             '</strong> 個。<br><br>';
    }

    showModal({
      title: '一次開多個分頁要先放行',
      body:
        '<div style="line-height:1.85;color:var(--text-dim);font-size:13px">' + head +
        'Chrome 預設一次只允許開一個分頁，其餘會被當成彈出式視窗擋掉。' +
        '要一次全開，需要對這個網站放行一次：<br><br>' +
        '1. 看網址列右邊，會有一個<strong style="color:var(--text)">被擋下的彈出式視窗</strong>圖示<br>' +
        '2. 點它，選<strong style="color:var(--text)">「一律允許…顯示彈出式視窗」</strong><br>' +
        '3. 之後就不會再被擋<br><br>' +
        '<span style="color:var(--text-faint)">這個設定是綁網址的。目前用檔案總管直接開啟的話可能存不住，' +
        '上到 GitHub Pages 之後設定一次就會永久生效。</span>' +
        '</div>',
      buttons: [{ text: '知道了', onClick: closeModal }]
    });
  }

  /* ============================================================
     批次開啟網址
     ------------------------------------------------------------
     Chrome 預設只放行一次點擊裡的第一個 window.open，其餘視為彈出視窗擋掉。
     被擋時 window.open 回傳 null——這是確實的偵測，不是推測。

     但「每次被擋都跳完整說明」很擾人，所以完整說明只出現第一次，
     之後只用一行提示帶過，需要時從卡片上的 ⓘ 自己叫出來。
     ============================================================ */

  function openLinks(links, pickUrl) {
    var opened = 0, blocked = 0, empty = 0;

    links.forEach(function (link) {
      var url = pickUrl(link);
      if (!url) { empty++; return; }
      if (Tabs.openTab(url)) opened++; else blocked++;
    });

    if (blocked) {
      var settings = DB.raw().settings || (DB.raw().settings = {});
      if (!settings.popupHintShown) {
        settings.popupHintShown = true;
        DB.touch(true);
        showPopupHelp({ opened: opened, blocked: blocked });
      } else {
        Clip.toast('開了 ' + opened + ' 個，' + blocked + ' 個被擋下（點卡片上的 ? 看怎麼放行）', true);
      }
      return;
    }

    if (empty && !opened) {
      Clip.toast('勾選的項目都還沒設定網址', true);
      return;
    }

    Clip.toast('已開啟 ' + opened + ' 個分頁' + (empty ? '（' + empty + ' 個沒設網址，略過）' : ''));
  }

  /* ============================================================
     卡片拖曳排序
     ------------------------------------------------------------
     只有卡片標題列的把手能起拖。整張卡片設成永久 draggable 的話，
     卡片裡的文字選取、常用語點擊複製都會被拖曳行為吃掉。
     ============================================================ */

  var dragTabId = null;

  function attachCardDrag(card, tab) {
    card.addEventListener('dragstart', function (e) {
      dragTabId = tab.id;
      card.classList.add('dragging');
      // Firefox 需要有資料才會真的開始拖
      try { e.dataTransfer.setData('text/plain', tab.id); } catch (err) { /* 忽略 */ }
      e.dataTransfer.effectAllowed = 'move';
    });

    card.addEventListener('dragend', function () {
      dragTabId = null;
      card.draggable = false;
      card.classList.remove('dragging');
      clearDropMarks();
    });

    card.addEventListener('dragover', function (e) {
      if (!dragTabId || dragTabId === tab.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      card.classList.add('drop-target');
    });

    card.addEventListener('dragleave', function () {
      card.classList.remove('drop-target');
    });

    card.addEventListener('drop', function (e) {
      e.preventDefault();
      card.classList.remove('drop-target');
      if (dragTabId && dragTabId !== tab.id) DB.moveTab(dragTabId, tab.id);
      dragTabId = null;
    });
  }

  var dragRow = null;   // { tabId, rowId }

  function attachRowDrag(el, tab, row) {
    el.addEventListener('dragstart', function (e) {
      dragRow = { tabId: tab.id, rowId: row.id };
      el.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', row.id); } catch (err) { /* 忽略 */ }
      e.dataTransfer.effectAllowed = 'move';
      // 不讓事件冒泡到卡片，否則會同時觸發整張卡片的拖曳
      e.stopPropagation();
    });

    el.addEventListener('dragend', function (e) {
      dragRow = null;
      el.draggable = false;
      el.classList.remove('dragging');
      clearRowDropMarks();
      e.stopPropagation();
    });

    el.addEventListener('dragover', function (e) {
      if (!dragRow || dragRow.rowId === row.id) return;
      // 只允許在同一張卡片內排序，跨卡片搬移是另一回事
      if (dragRow.tabId !== tab.id) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('row-drop-target');
    });

    el.addEventListener('dragleave', function () {
      el.classList.remove('row-drop-target');
    });

    el.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('row-drop-target');
      if (dragRow && dragRow.tabId === tab.id && dragRow.rowId !== row.id) {
        DB.moveRow(tab.id, dragRow.rowId, row.id);
      }
      dragRow = null;
    });
  }

  /** 便籤項目的拖曳。跟常用語列同一套做法，只是清單與排序函式不同。 */
  function attachNoteDrag(el, tab, item) {
    el.addEventListener('dragstart', function (e) {
      dragRow = { tabId: tab.id, rowId: item.id };
      el.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', item.id); } catch (err) { /* 忽略 */ }
      e.dataTransfer.effectAllowed = 'move';
      e.stopPropagation();
    });

    el.addEventListener('dragend', function (e) {
      dragRow = null;
      el.draggable = false;
      el.classList.remove('dragging');
      clearRowDropMarks();
      e.stopPropagation();
    });

    el.addEventListener('dragover', function (e) {
      if (!dragRow || dragRow.rowId === item.id) return;
      if (dragRow.tabId !== tab.id) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('row-drop-target');
    });

    el.addEventListener('dragleave', function () {
      el.classList.remove('row-drop-target');
    });

    el.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('row-drop-target');
      if (dragRow && dragRow.tabId === tab.id && dragRow.rowId !== item.id) {
        DB.moveNoteItem(tab.id, dragRow.rowId, item.id);
      }
      dragRow = null;
    });
  }

  /** 連結項目的拖曳。跟便籤同一套做法，只有排序函式不同。 */
  function attachLinkDrag(el, tab, link) {
    el.addEventListener('dragstart', function (e) {
      dragRow = { tabId: tab.id, rowId: link.id };
      el.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', link.id); } catch (err) { /* 忽略 */ }
      e.dataTransfer.effectAllowed = 'move';
      e.stopPropagation();
    });

    el.addEventListener('dragend', function (e) {
      dragRow = null;
      el.draggable = false;
      el.classList.remove('dragging');
      clearRowDropMarks();
      e.stopPropagation();
    });

    el.addEventListener('dragover', function (e) {
      if (!dragRow || dragRow.rowId === link.id) return;
      if (dragRow.tabId !== tab.id) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('row-drop-target');
    });

    el.addEventListener('dragleave', function () {
      el.classList.remove('row-drop-target');
    });

    el.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('row-drop-target');
      if (dragRow && dragRow.tabId === tab.id && dragRow.rowId !== link.id) {
        DB.moveLink(tab.id, dragRow.rowId, link.id);
      }
      dragRow = null;
    });
  }

  /**
   * 通用的清單列拖曳（v4.24：待辦、倒數、私人卡片的每一筆）。
   * group 相同才能放：倒數用它限制在「同一天、同一個時間」之內，
   * 其他清單整張卡片就是一組。實際怎麼搬由呼叫端給的 move 決定。
   */
  var dragItem = null;

  function attachItemDrag(el, tab, id, group, move) {
    el.addEventListener('dragstart', function (e) {
      dragItem = { tabId: tab.id, id: id, group: group };
      el.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', id); } catch (err) { /* 忽略 */ }
      e.dataTransfer.effectAllowed = 'move';
      e.stopPropagation();
    });

    el.addEventListener('dragend', function (e) {
      dragItem = null;
      el.draggable = false;
      el.classList.remove('dragging');
      clearRowDropMarks();
      e.stopPropagation();
    });

    function ok() {
      return dragItem && dragItem.id !== id && dragItem.tabId === tab.id &&
             dragItem.group === group;
    }

    el.addEventListener('dragover', function (e) {
      if (!ok()) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('row-drop-target');
    });

    el.addEventListener('dragleave', function () {
      el.classList.remove('row-drop-target');
    });

    el.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('row-drop-target');
      var go = ok();
      var from = dragItem && dragItem.id;
      dragItem = null;
      if (go) move(from, id);
    });
  }

  /** 私人卡片的一筆換位置。加密的卡片由 savePrivate 重新加密後存回去。 */
  function movePrivate(tab, fromId, toId) {
    var list = (privateEntries(tab) || []).slice();
    var a = list.findIndex(function (x) { return x.id === fromId; });
    var b = list.findIndex(function (x) { return x.id === toId; });
    if (a < 0 || b < 0 || a === b) return;
    var moved = list.splice(a, 1)[0];
    list.splice(b, 0, moved);
    setPrivateEntries(tab, list);
    savePrivate(tab);
  }

  function clearRowDropMarks() {
    Array.prototype.forEach.call(
      document.querySelectorAll('.row-drop-target'),
      function (r) { r.classList.remove('row-drop-target'); }
    );
  }

  function clearDropMarks() {
    Array.prototype.forEach.call(
      document.querySelectorAll('.card.drop-target'),
      function (c) { c.classList.remove('drop-target'); }
    );
    // 卡片可能被拖到側欄再放掉，那邊的標記也要收乾淨
    clearCatDropMarks();
  }

  /**
   * 把卡片搬到另一個分類，並把「順手處理掉的事」講清楚。
   * 兩個入口共用：拖到側欄分類，以及卡片標題列的「移到其他分類」。
   */
  function moveTabToCategory(tabId, toCategoryId) {
    var tab = DB.findTab(tabId);
    var cat = DB.findCategory(toCategoryId);
    if (!tab || !cat) return;

    var r = DB.moveTabToCategory(tabId, toCategoryId);
    if (!r) return;

    var msg = '已移到「' + cat.name + '」';
    if (r.unpinned) msg += '，釘選已取消（那邊同類型已經釘滿）';
    if (r.clearedKeys) msg += '，' + r.clearedKeys + ' 條複製鍵與該分類重複已清空';
    render();
    Clip.toast(msg);
  }

  /**
   * 卡片的 ⋯ 選單。項目由 tabs.js 的 cardMenuItems() 決定（那裡才知道
   * 每種卡片有哪些動作），這裡只負責畫，跟分類的 ⋯ 長得一樣。
   */
  function openCardMenu(tab, items) {
    var wrap = document.createElement('div');

    items.forEach(function (it) {
      var b = document.createElement('button');
      b.className = 'type-opt' + (it.danger ? ' danger-opt' : '');
      b.style.width = '100%';
      b.style.marginBottom = it.hint ? '2px' : '6px';
      b.textContent = it.text;
      if (it.disabled) {
        b.disabled = true;
      } else {
        b.addEventListener('click', function () {
          closeModal();
          it.onClick();
        });
      }
      wrap.appendChild(b);

      if (it.hint) {
        var hint = document.createElement('div');
        hint.className = 'field-hint';
        hint.style.margin = '0 0 10px';
        hint.textContent = it.hint;
        wrap.appendChild(hint);
      }
    });

    showModal({
      title: '卡片：' + (tab.title || '未命名'),
      body: wrap,
      buttons: [{ text: '關閉', onClick: closeModal }]
    });
  }

  /** 卡片標題列的入口：列出所有分類讓使用者挑一個。 */
  function askMoveTab(tab) {
    var wrap = document.createElement('div');
    wrap.className = 'move-list';

    var cats = DB.categories();
    if (cats.length < 2) {
      var only = document.createElement('div');
      only.className = 'field-hint';
      only.textContent = '目前只有一個分類，沒有別的地方可以搬。';
      wrap.appendChild(only);
    }

    cats.forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'move-item';
      b.disabled = c.id === tab.categoryId;
      if (c.color) b.dataset.color = c.color;

      var short = document.createElement('span');
      short.className = 'short';
      short.textContent = c.shortLabel || c.name.charAt(0);
      b.appendChild(short);

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = c.name + (c.id === tab.categoryId ? '（目前所在）' : '');
      b.appendChild(name);

      b.addEventListener('click', function () {
        closeModal();
        moveTabToCategory(tab.id, c.id);
      });
      wrap.appendChild(b);
    });

    showModal({
      title: '把「' + (tab.title || '未命名') + '」移到',
      body: wrap,
      buttons: [{ text: '取消', onClick: closeModal }]
    });
  }

  /* ============================================================
     卡片區
     ============================================================ */

  function matchText(s) {
    if (!state.search) return true;
    s = (s || '').toLowerCase();
    // 先用原字比一次。字典載不到時這就是全部的行為，跟加這個功能之前一樣
    if (s.indexOf(state.search) >= 0) return true;
    if (!CC.conv) return false;
    // 兩邊都折成簡體再比一次，繁簡才互相找得到
    return ccFold(s).indexOf(state.searchFold) >= 0;
  }

  /** 卡片是否符合搜尋：標題或任一內容欄命中都算。 */
  function matchTab(tab) {
    if (!state.search) return true;
    if (matchText(tab.title)) return true;
    if (tab.type === 'quickphrase') {
      return (tab.rows || []).some(function (r) {
        return matchText(r.label) || matchText(r.content);
      });
    }
    if (tab.type === 'note') {
      /* 欄位型別：標題行與欄位名是資料，參與搜尋；
         填進去的值根本沒存，不參與（使用者定的） */
      return (tab.items || []).some(function (i) {
        if (i.kind === 'form') {
          return matchText(i.title) || (i.fields || []).some(function (f) {
            return matchText(f.label);
          });
        }
        return matchText(i.content);
      });
    }
    if (tab.type === 'todo' || tab.type === 'countdown') {
      return (tab.items || []).some(function (i) { return matchText(i.text); });
    }
    if (tab.type === 'link') {
      return (tab.links || []).some(function (l) {
        return matchText(l.name) || matchText(l.url);
      });
    }
    if (tab.type === 'private') {
      /* 加密且鎖著時內容一律不參與搜尋——「搜到了就代表存在」
         本身就洩漏了資訊。不加密的卡片沒有這個顧慮，照常比對。 */
      if (tab.encrypted && !Vault.isCardUnlocked(tab.id)) return false;
      var list = privateEntries(tab) || [];
      return list.some(function (x) {
        return matchText(x.name) || matchText(x.user) || matchText(x.note);
      });
    }
    return false;
  }

  /* ============================================================
     卡片的密集排版
     ------------------------------------------------------------
     CSS grid 有「列」的概念：同一列裡最高的那張卡片決定整列高度，其他卡片
     底下就空著。一張很長的便籤會把旁邊的卡片整排往下推。

     做法是把列切得很細（每列 2px），再依每張卡片的實際高度算出它該佔幾列，
     縱向的空隙就被壓掉了。卡片的先後順序不變，還是由左到右、由上到下填。

     為什麼不用別的做法：瀏覽器原生的 masonry 還是實驗性功能，正式版沒有；
     多欄排版（column）是直向填滿的，順序會變成「數完第一欄再跳第二欄」，
     而且常用語卡沒辦法橫跨整行。

     **`align-items: start` 是防止無限迴圈的關鍵，不要拿掉。** grid 預設會把
     格子裡的東西拉滿：卡片被拉高之後量到的高度變大 → 算出更大的佔格數 →
     再拉更高，一路長下去。靠上對齊把拉滿關掉，高度永遠由內容決定。
     ============================================================ */

  var GRID_UNIT = 2;    // 每一列的高度，單位 px
  var GRID_GAP = 14;    // 跟 style.css 的 gap 一致
  var gridObserver = null;

  function layoutGrid() {
    var grid = $('cardGrid');
    if (!grid) return;

    /* 先全部量完再全部寫入。邊量邊寫會讓瀏覽器一直重算版面。

       量到的高度是縮放後的實際像素，但佔格數是用 CSS 像素算的，所以要先
       除回去。沒除的話畫面放大到 125% 時，每張卡片都會多佔四分之一的高度，
       卡片之間出現一條空白（實測）。 */
    var z = DB.uiZoom();
    var sizes = [];
    Array.prototype.forEach.call(grid.children, function (el) {
      if (el.classList.contains('cat-group')) return;
      var h = el.getBoundingClientRect().height / z;
      sizes.push([el, Math.ceil((h + GRID_GAP) / GRID_UNIT)]);
    });
    sizes.forEach(function (pair) {
      var want = 'span ' + pair[1];
      // 值沒變就不寫，連那一次改動都省掉
      if (pair[0].style.gridRowEnd !== want) pair[0].style.gridRowEnd = want;
    });
  }

  /**
   * 高度會變的時機很多：便籤展開收合、拉大編輯框、勾待辦、視窗縮放。
   * 用 ResizeObserver 而不是定時檢查——它只在元素真的變了大小時才被叫，
   * 沒有東西在動的時候一次都不跑。
   *
   * 全程只用一個觀察器，重繪前先解除登記；不然被刪掉的卡片會被觀察器
   * 抓著不放，那才是真的記憶體洩漏。
   */
  function watchGrid() {
    var grid = $('cardGrid');
    if (!grid) return;

    if (!window.ResizeObserver) { layoutGrid(); return; }
    if (!gridObserver) gridObserver = new ResizeObserver(layoutGrid);

    gridObserver.disconnect();
    Array.prototype.forEach.call(grid.children, function (el) {
      if (!el.classList.contains('cat-group')) gridObserver.observe(el);
    });
    layoutGrid();
  }

  function renderContent() {
    var grid = $('cardGrid');
    grid.innerHTML = '';
    state.hotkeys = {};
    // 搜尋時把手要藏起來：畫面上是過濾後的結果，這時候拖曳算出來的順序是錯的
    grid.classList.toggle('searching', !!state.search);

    var cat = DB.findCategory(state.currentCategoryId);
    // 全域搜尋時畫面上是跨分類的結果，標題再顯示某個分類名稱會誤導；
    // 「＋ 新增卡片」同理——看不出會加到哪個分類，所以搜尋中停用
    $('currentCategoryName').textContent = state.search
      ? '搜尋「' + state.search + '」'
      : (cat ? cat.name : '—');
    $('btnAddTab').disabled = !cat || !!state.search;
    $('btnAddTab').title = state.search ? '搜尋中沒辦法新增卡片，先清掉搜尋' : '';

    if (!cat) {
      $('emptyHint').hidden = false;
      $('emptyHint').textContent = '左邊還沒有分類，點側欄下方的 ＋ 新增一個。';
      return;
    }

    var ctx = {
      // 主視窗是可編輯的；唯讀只有置頂小視窗（見 pip.js 的 pipCtx）
      readOnly: false,
      // 編碼卡與表單卡的選項管理彈窗
      manageGen: manageGen,
      // 表單卡的輸出格式與模式名稱
      editFormTemplate: editFormTemplate,
      manageModes: manageModes,
      // 搜尋中的卡片一律當成展開（見 tabs.js 的 renderCard）
      searching: !!state.search,
      // 搜尋命中要標出來。沒搜尋時給 null，渲染端就不做任何事
      highlight: state.search
        ? { q: state.search, qFold: state.searchFold, fold: ccFold }
        : null,
      matchRow: function (row) {
        if (!state.search) return true;
        return matchText(row.label) || matchText(row.content);
      },
      /* 複製鍵的對照表，每次重繪都重建。
         全域搜尋時畫面上會同時出現好幾個分類的卡片，同一個鍵可能被兩條
         不同分類的常用語佔用（唯一性的範圍本來就是分類，見規格書 6.2）。
         撞到的那幾條一律暫時失效，不亂猜該複製哪一條，也不跳提示——
         搜尋是暫時狀態，為此打斷使用者不划算。 */
      registerHotkey: function (key, row, el) {
        if (Object.prototype.hasOwnProperty.call(state.hotkeys, key)) {
          state.hotkeys[key] = null;
          return;
        }
        state.hotkeys[key] = { row: row, el: el };
      },
      /* 所有刪除一律走這裡，確保每個 ✕ 都有二次確認。
         recoverable 為真時改講還原方式——卡片與分類現在會先進保留區，
         再寫「無法復原」就是騙人的。 */
      confirmDelete: function (title, message, onOk, recoverable) {
        confirmModal(title, message + '<br><br>' + deleteTail(recoverable),
          '確定刪除', onOk, true);
      },
      // 私人卡片與其中的每一筆，刪除前要先驗主密碼或復原金鑰
      confirmDeletePrivate: confirmDeletePrivate,
      privateEntries: privateEntries,
      setPrivateEntries: setPrivateEntries,
      convertPrivate: convertPrivate,
      pickTabColor: pickTabColor,
      askMoveTab: askMoveTab,
      openCardMenu: openCardMenu,
      pipSupported: PiP.supported,
      isPipped: PiP.isOpen,
      pipMode: PiP.mode,
      togglePip: PiP.toggle,
      togglePipWindow: PiP.toggleWindowed,
      togglePin: function (tab) {
        var err = DB.togglePin(tab.id);
        if (err) Clip.toast(err, true);
      },
      attachDrag: attachCardDrag,
      attachRowDrag: attachRowDrag,
      attachNoteDrag: attachNoteDrag,
      // 待辦、倒數、私人卡片的每一筆（v4.24）
      attachItemDrag: attachItemDrag,
      movePrivate: movePrivate,
      // 便籤新增一筆（先選型別）、欄位型別的「管理欄位」
      editNoteItem: editNoteItem,
      attachLinkDrag: attachLinkDrag,
      editPhrase: editPhrase,
      editDueItem: editDueItem,
      editLink: editLink,
      openLinks: openLinks,
      showPopupHelp: function () { showPopupHelp(null); },
      openCard: function (tab) { openCard(tab, null); },
      lockCard: lockCard,
      savePrivate: savePrivate,
      editPrivate: editPrivate
    };

    var hint = $('emptyHint');
    var total = 0;

    if (state.search) {
      /* 全域搜尋：跨所有分類，依分類分組，每組上面一行分類名稱。
         卡片一離開自己的分類就看不出是哪來的，所以分組標題是必要的。 */
      DB.categories().forEach(function (c) {
        var hits = DB.tabsOf(c.id).filter(matchTab);
        if (!hits.length) return;
        total += hits.length;

        var gh = document.createElement('div');
        gh.className = 'cat-group';
        gh.textContent = c.name;
        if (c.color) gh.dataset.color = c.color;
        grid.appendChild(gh);

        hits.forEach(function (tab) {
          grid.appendChild(Tabs.renderCard(tab, ctx));
        });
      });

      hint.hidden = !!total;
      if (!total) hint.textContent = '沒有符合「' + state.search + '」的內容。';
      watchGrid();
      return;
    }

    var tabs = DB.tabsOf(cat.id);
    total = tabs.length;
    tabs.forEach(function (tab) {
      grid.appendChild(Tabs.renderCard(tab, ctx));
    });

    hint.hidden = !!total;
    if (!total) hint.textContent = '這個分類還沒有卡片。點右上角「＋ 新增卡片」開始。';
    watchGrid();
  }

  /* ============================================================
     到期時刻的計時器
     ------------------------------------------------------------
     加了時間之後，14:30 一到畫面就該變紅，不能等使用者重新整理。

     刻意不用「每分鐘檢查一次」：沒有倒數卡片時那個迴圈永遠不會有結果，
     卻會一直把 CPU 叫醒、妨礙筆電進入省電狀態。改成由資料層算出下一次
     真的會有變化的時刻（某一筆到期，或午夜），只排那一個計時器。
     沒有倒數卡片時連一個都不排。

     分頁切到背景就停掉，切回來重算一次——這同時處理了電腦睡眠：
     睡醒後計時器的行為本來就不可靠，靠「切回來重算」比靠計時器準。
     ============================================================ */

  var dueTimer = null;

  function clearDueTimer() {
    if (dueTimer) { clearTimeout(dueTimer); dueTimer = null; }
  }

  function scheduleDueCheck() {
    clearDueTimer();
    if (document.hidden) return;

    var at = DB.nextDueChange();
    if (!at) return;

    // 上限一天：計時器排太久本來就不可靠，而且午夜一定會先到
    var wait = Math.min(Math.max(at.getTime() - Date.now(), 1000), 86400000);
    dueTimer = setTimeout(function () {
      dueTimer = null;
      render();   // 這個時刻本來就是「狀態會變」的那一刻，重繪是對的
    }, wait);
  }

  /* ============================================================
     顯示大小
     ------------------------------------------------------------
     網頁沒辦法呼叫瀏覽器自己的縮放（那是瀏覽器的功能，JS 碰不到），但 CSS 的
     zoom 做得到一樣的事：整個版面等比放大，字、按鈕、間距一起變，不會跑版。

     套在 body 上而不是 #app：彈窗遮罩、☰ 選單、浮動提示都是 body 的直接子元素，
     套在 #app 上的話它們不會跟著縮放。

     跟瀏覽器自己的 Ctrl 加號是相乘的，兩個都調會疊加。
     ============================================================ */

  function applyZoom() {
    var z = DB.uiZoom();
    document.body.style.zoom = z === 1 ? '' : String(z);
    var v = $('zoomVal');
    if (v) v.textContent = Math.round(z * 100) + '%';
  }

  function openZoomPanel() {
    var panel = $('zoomPanel');
    panel.innerHTML = '';
    var cur = DB.uiZoom();

    DB.ZOOM_STEPS.slice().reverse().forEach(function (z) {
      var b = document.createElement('button');
      b.textContent = Math.round(z * 100) + '%';
      if (z === cur) b.className = 'on';
      b.addEventListener('click', function () {
        panel.hidden = true;
        DB.setUiZoom(z);
      });
      panel.appendChild(b);
    });

    panel.hidden = false;
  }

  /* ============================================================
     雲端同步（Drive）

     狀態點常駐在頂部列，帳號與動作收在點開的小面板裡——面板沒有會遺失
     的東西，所以點外面、Esc、捲動都關得掉（對照 4.5）。
     ============================================================ */

  var SYNC_TEXT = {
    out:     '尚未登入雲端同步',
    ok:      '已同步',
    syncing: '同步中…',
    offline: '未同步（離線或連不上）',
    error:   '同步失敗'
  };

  /* 絕對時間＋（相對時間）。衝突彈窗要拿兩個時間互相比較，只寫「3 分鐘前」
     不夠用；而且 sinceText() 對未來的時間會回空字串——兩台機器的時鐘有落差
     時真的會出現，那時候整行會變成「這台最後修改：」後面空白。 */
  function stampText(iso) {
    var t = Date.parse(iso);
    if (!t) return '未知';
    var d = new Date(t);
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    var abs = d.getFullYear() + '/' + p2(d.getMonth() + 1) + '/' + p2(d.getDate()) +
              ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    var ago = sinceText(iso);
    return ago ? abs + '（' + ago + '）' : abs;
  }

  function updateSyncBtn(s) {
    var dot = $('syncDot');
    if (!dot) return;
    dot.dataset.s = s.state;
    var t = SYNC_TEXT[s.state] || '';
    if (s.state === 'ok' && s.at) t += ' · ' + (sinceText(s.at) || '剛剛');
    if (s.state === 'ok' && s.dirty) t = '有變更還沒上傳';
    if (s.msg) t += '（' + s.msg + '）';
    $('btnSync').title = t;
    if (!$('syncPanel').hidden) openSyncPanel();   // 開著的話跟著更新
  }

  function openSyncPanel() {
    var p = $('syncPanel');
    var s = Drive.status();
    p.innerHTML = '';

    var line = document.createElement('div');
    line.className = 'sy-line';
    var dot = document.createElement('span');
    dot.className = 'sync-dot';
    dot.dataset.s = s.state;
    dot.style.marginRight = '6px';
    line.appendChild(dot);
    var txt = document.createElement('span');
    if (s.state === 'ok') {
      txt.innerHTML = s.dirty ? '有變更還沒上傳'
        : '已同步' + (s.at ? ' · <b>' + (sinceText(s.at) || '剛剛') + '</b>' : '');
    } else {
      txt.textContent = SYNC_TEXT[s.state] || '';
    }
    line.appendChild(txt);
    p.appendChild(line);

    if (s.msg) {
      var m = document.createElement('div');
      m.className = 'sy-mail';
      m.style.color = 'var(--danger)';
      m.textContent = s.msg;
      p.appendChild(m);
    }

    var row = document.createElement('div');
    row.className = 'sy-row';

    if (s.state === 'out') {
      var inBtn = document.createElement('button');
      inBtn.className = 'main';
      inBtn.textContent = '登入 Google';
      inBtn.addEventListener('click', function () {
        p.hidden = true;
        Drive.signIn();
      });
      row.appendChild(inBtn);

      /* 連不上 Google 的時候還有一條路：匯入備份檔。它只進這個分頁的暫存區，
         關掉分頁就沒了，但至少當下有東西可以用。 */
      var alt = document.createElement('div');
      alt.className = 'sy-hint';
      alt.textContent = '連不上的話可以「☰ → 匯入資料」用備份檔，只存在這個分頁';
      p.appendChild(alt);
    } else {
      var mail = document.createElement('div');
      mail.className = 'sy-mail';
      mail.textContent = s.email || '已登入';
      p.appendChild(mail);        // row 這時還沒掛上去，不能拿它當參考節點

      var nowBtn = document.createElement('button');
      nowBtn.className = 'main';
      nowBtn.textContent = '立刻同步';
      nowBtn.addEventListener('click', function () { Drive.syncNow(); });
      var outBtn = document.createElement('button');
      outBtn.textContent = '登出';
      outBtn.title = '登出會把這個分頁的資料一併清掉';
      outBtn.addEventListener('click', function () {
        p.hidden = true;
        doSignOut();
      });
      row.appendChild(nowBtn);
      row.appendChild(outBtn);
    }

    p.appendChild(row);
    p.hidden = false;
  }

  /**
   * 登出。資料放在分頁暫存，登出會一併清掉——公用電腦上不能只斷開雲端、
   * 把內容留在瀏覽器裡。
   *
   * 唯一會被打斷的情況是**有變更還沒上到雲端**（離線、上傳失敗）：
   * 那時候清掉就是真的弄丟了，所以先問，並給一顆「先匯出留底」。
   */
  function doSignOut() {
    Drive.signOut().then(function (r) {
      if (r !== 'pending') {
        Clip.toast('已登出，這個分頁的資料已清除');
        return;
      }
      var wrap = document.createElement('div');
      wrap.innerHTML =
        '<div style="line-height:1.7;color:var(--text-dim)">' +
        '有變更<strong style="color:var(--text)">還沒上傳到雲端</strong>' +
        '（可能是離線或上傳失敗）。<br>' +
        '登出會把這個分頁的資料清掉，那些變更就找不回來了。' +
        '</div>';

      var save = document.createElement('button');
      save.className = 'btn-plain';
      save.style.cssText = 'margin-top:12px;padding:6px 12px;border:1px solid var(--border-strong);' +
                           'border-radius:var(--radius-sm);background:var(--raise-xs);' +
                           'color:var(--text);font-family:inherit;font-size:12px;cursor:pointer';
      save.textContent = '先匯出這台的資料留底';
      save.addEventListener('click', function () { handleMenu('export'); });
      wrap.appendChild(save);

      showModal({
        title: '要登出嗎？',
        body: wrap,
        noEscape: true,      // 按下去資料就清掉，不讓 Esc 順手關掉
        buttons: [
          { text: '先不要', onClick: closeModal },
          {
            text: '還是要登出',
            // danger-btn 是給 .icon-btn 用的，彈窗的破壞性按鈕走 btn-danger
            cls: 'btn-danger',
            onClick: function () {
              closeModal();
              Drive.signOut({ force: true }).then(function () {
                Clip.toast('已登出，這個分頁的資料已清除');
              });
            }
          }
        ]
      });
    });
  }

  /**
   * 兩邊都改過。永遠不自動合併，把選擇權交回去——但先給一顆「匯出這台的」，
   * 選錯邊的代價才不是不可逆的。
   */
  function askConflict(info) {
    $('syncPanel').hidden = true;
    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<div style="line-height:1.7;color:var(--text-dim)">' +
      '這台和雲端從上次同步之後<strong style="color:var(--text)">都改過</strong>，' +
      '沒辦法自動合併，要選一邊覆蓋另一邊。<br><br>' +
      '這台最後修改：<b style="color:var(--text)">' + stampText(info.localAt) + '</b><br>' +
      '雲端最後修改：<b style="color:var(--text)">' + stampText(info.cloudAt) + '</b>' +
      '</div>';

    var save = document.createElement('button');
    save.className = 'btn-plain';
    save.style.cssText = 'margin-top:12px;padding:6px 12px;border:1px solid var(--border-strong);' +
                         'border-radius:var(--radius-sm);background:var(--raise-xs);' +
                         'color:var(--text);font-family:inherit;font-size:12px;cursor:pointer';
    save.textContent = '先匯出這台的資料留底';
    save.addEventListener('click', function () { handleMenu('export'); });
    wrap.appendChild(save);

    showModal({
      title: '兩邊都改過',
      body: wrap,
      noEscape: true,      // 選錯就覆蓋掉一邊，不讓 Esc 順手關掉
      buttons: [
        { text: '先不要', onClick: closeModal },
        { text: '用雲端的', onClick: function () { closeModal(); Drive.syncNow({ force: 'down' }); } },
        { text: '用這台的', cls: 'btn-primary',
          onClick: function () { closeModal(); Drive.syncNow({ force: 'up' }); } }
      ]
    });
  }

  function render() {
    applyZoom();
    applyTheme();
    closeColorPop();   // 重繪後原本的色點已經不在了，視窗留著會指向空氣
    var cats = DB.categories();
    if (!state.currentCategoryId || !DB.findCategory(state.currentCategoryId)) {
      state.currentCategoryId = cats.length ? cats[0].id : null;
    }
    $('appTitle').textContent = DB.raw().appTitle || '便籤／常用語';
    renderSidebar();
    renderContent();
    // 小視窗排在最後：主題與自訂配色都套好了，抄過去才是對的
    PiP.render();
    scheduleDueCheck();
    maybeWarnQuota();   // 自己有節流，不會每次重繪都去掃儲存空間
  }

  /* ============================================================
     新增卡片
     ============================================================ */

  /* 類型的名稱與說明。順序不在這裡：出廠順序是 DB.CARD_TYPES，
     使用者排過的順序是 DB.typeOrder()（v4.23，跟著匯出匯入與同步走）。 */
  var TYPES = {
    quickphrase: ['常用語', '雙欄清單，點一下複製內容'],
    note: ['便籤', '自由文字，或一排固定欄位'],
    todo: ['待辦清單', '可勾選的任務'],
    countdown: ['倒數提醒', '顯示距離某天還有幾天'],
    link: ['連結收藏', '常用網址清單'],
    private: ['私人', '加密保存，需要主密碼才看得到'],
    codegen: ['編碼', '選好選項產生一段文案與一組隨機碼'],
    form: ['表單', '填幾個欄位，照你的格式產生一段可以複製的文字'],
    table: ['表格／參考清單', '（尚未實作）']
  };

  var dragType = null;

  /**
   * 選擇卡片類型的那一排磁磚。可以拖曳排序：
   * - 只有左上角的 ⠿ 能起拖（7.1）。磁磚本身按下去是「建立這種卡片」，
   *   整格可拖會讓「點一下」跟「按住拖」搶同一塊（11.1）
   * - 把手跟磁磚是**兄弟**，不是包在按鈕裡：點到把手不會建立卡片
   * - 放開就存，彈窗不關；只重畫這一排，而且順序沒變就不重畫（11.20）
   * - 停用的「表格／參考清單」照樣可以拖（使用者選的）
   */
  function fillTypeGrid(grid) {
    var order = DB.typeOrder();
    var sig = order.join(',');
    if (grid.dataset.sig === sig) return;
    grid.dataset.sig = sig;
    grid.innerHTML = '';

    order.forEach(function (type) {
      var t = TYPES[type];
      if (!t) return;
      var cell = document.createElement('div');
      cell.className = 'type-cell';
      cell.dataset.type = type;

      var b = document.createElement('button');
      b.className = 'type-opt';
      var st = document.createElement('strong');
      st.textContent = t[0];
      var sm = document.createElement('small');
      sm.textContent = t[1];
      b.appendChild(st);
      b.appendChild(sm);
      if (type === 'table') {
        b.disabled = true;
      } else {
        b.addEventListener('click', function () {
          closeModal();
          if (type === 'private') { askPrivateMode(); return; }
          promptModal('新增' + t[0], '卡片標題', t[0], function (title) {
            DB.addTab(type, state.currentCategoryId, title);
          });
        });
      }
      cell.appendChild(b);

      var grip = document.createElement('span');
      grip.className = 'type-grip';
      grip.textContent = '⠿';
      grip.title = '按住拖曳可調整順序';
      grip.addEventListener('mousedown', function (e) {
        e.stopPropagation();
        cell.draggable = true;
      });
      // 按下去沒拖就放開：把可拖關回去，不然下一次點磁磚可能變成拖曳
      grip.addEventListener('mouseup', function () { cell.draggable = false; });
      grip.addEventListener('click', function (e) { e.stopPropagation(); });
      cell.appendChild(grip);

      cell.addEventListener('dragstart', function (e) {
        dragType = type;
        cell.classList.add('dragging');
        try { e.dataTransfer.setData('text/plain', type); } catch (err) { /* 忽略 */ }
        e.dataTransfer.effectAllowed = 'move';
        e.stopPropagation();
      });
      cell.addEventListener('dragend', function (e) {
        dragType = null;
        cell.draggable = false;
        cell.classList.remove('dragging');
        clearTypeDropMarks(grid);
        e.stopPropagation();
      });
      cell.addEventListener('dragover', function (e) {
        if (!dragType || dragType === type) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        cell.classList.add('row-drop-target');
      });
      cell.addEventListener('dragleave', function () {
        cell.classList.remove('row-drop-target');
      });
      cell.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var from = dragType;
        dragType = null;
        clearTypeDropMarks(grid);
        if (!from || from === type) return;
        DB.moveType(from, type);
        fillTypeGrid(grid);
      });

      grid.appendChild(cell);
    });
  }

  function clearTypeDropMarks(grid) {
    Array.prototype.forEach.call(grid.querySelectorAll('.row-drop-target'),
      function (x) { x.classList.remove('row-drop-target'); });
  }

  function openAddTab() {
    if (!state.currentCategoryId) return;

    var grid = document.createElement('div');
    grid.className = 'type-grid';
    fillTypeGrid(grid);

    showModal({
      title: '選擇卡片類型',
      body: grid,
      buttons: [{ text: '取消', onClick: closeModal }]
    });
  }

  /* ============================================================
     編碼卡的選項管理
     ------------------------------------------------------------
     兩組選項共用同一個彈窗，差別只在編輯單一選項時要填什麼：
     第一組多一個文案模板，第二組多兩個開關。
     卡片只負責決定要開哪一組（tabs.js 的 ctx.manageGen），
     彈窗一律由這裡畫，樣子才會跟其他選單一致。
     ============================================================ */

  /** 哪一組選項的實際陣列由資料層說了算，這裡不另外寫一份對照表。 */
  function genList(tab, which) {
    return DB.genOptionList(tab, which) || [];
  }

  var dragGenOpt = null;

  function clearGenDropMarks() {
    Array.prototype.forEach.call(
      document.querySelectorAll('#modalBody .gen-manage-row'),
      function (x) { x.classList.remove('row-drop-target'); });
  }

  /**
   * 管理清單裡的拖曳排序。跟常用語列同一套：把手 mousedown 才變成可拖、
   * 放開之後重畫清單（重畫也讓拖曳狀態自然歸零）。
   * 只在同一組之內排序——不同組的欄位結構本來就不一樣。
   */
  function attachGenOptionDrag(row, tab, which, opt, back) {
    row.addEventListener('dragstart', function (e) {
      dragGenOpt = { tabId: tab.id, which: which, id: opt.id };
      row.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', opt.id); } catch (err) { /* 忽略 */ }
      e.dataTransfer.effectAllowed = 'move';
      e.stopPropagation();
    });

    row.addEventListener('dragend', function (e) {
      dragGenOpt = null;
      row.draggable = false;
      row.classList.remove('dragging');
      clearGenDropMarks();
      e.stopPropagation();
    });

    row.addEventListener('dragover', function (e) {
      if (!dragGenOpt || dragGenOpt.id === opt.id) return;
      if (dragGenOpt.tabId !== tab.id || dragGenOpt.which !== which) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('row-drop-target');
    });

    row.addEventListener('dragleave', function () {
      row.classList.remove('row-drop-target');
    });

    row.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('row-drop-target');
      var d = dragGenOpt;
      dragGenOpt = null;
      if (!d || d.tabId !== tab.id || d.which !== which || d.id === opt.id) return;
      DB.moveGenOption(tab.id, which, d.id, opt.id);
      // 清單要重畫才看得到新順序（彈窗不會跟著 render() 更新）
      closeModal();
      back();
    });
  }

  function manageGen(tab, which) {
    var list = genList(tab, which);
    var title = tab.labels[which];

    /* 編輯、新增、刪除完都回到這份清單，只有「關閉」才真的關掉——
       選項要一個一個改的時候，每改一個就被關掉很難用。
       重新呼叫自己而不是留著舊畫面，剛改的名字才會跟著更新。 */
    function back() { manageGen(tab, which); }

    var wrap = document.createElement('div');

    if (!list.length) {
      var hint = document.createElement('div');
      hint.className = 'row-hint';
      hint.style.marginBottom = '10px';
      hint.textContent = '還沒有選項。';
      wrap.appendChild(hint);
    }

    list.forEach(function (opt) {
      var row = document.createElement('div');
      row.className = 'gen-manage-row';
      row.dataset.optId = opt.id;

      /* 拖曳把手。跟卡片與常用語列同一套做法：只有按住把手才讓這一列
         變成可拖，否則整列上的按鈕會被拖曳行為吃掉 */
      var grip = document.createElement('span');
      grip.className = 'gen-grip';
      grip.textContent = '⠿';
      grip.title = '按住拖曳可調整順序';
      grip.addEventListener('mousedown', function (e) {
        e.stopPropagation();
        row.draggable = true;
      });
      row.appendChild(grip);
      attachGenOptionDrag(row, tab, which, opt, back);

      var name = document.createElement('span');
      name.className = 'gen-manage-name';
      name.textContent = opt.name;
      row.appendChild(name);

      row.appendChild(Tabs.iconBtn('✎', '編輯', function () {
        closeModal();
        editGenOption(tab, which, opt, back);
      }));

      row.appendChild(Tabs.iconBtn('✕', '刪除', function () {
        closeModal();
        confirmModal('刪除選項',
          '將刪除「' + opt.name + '」。<br><br>此動作無法復原。',
          '確定刪除', function () {
            var i = list.indexOf(opt);
            if (i >= 0) list.splice(i, 1);
            tab.updatedAt = DB.nowIso();
            DB.touch();
            back();
          }, true, back);
      }, 'danger-btn'));

      wrap.appendChild(row);
    });

    var add = document.createElement('button');
    add.className = 'row-add';
    add.textContent = '＋ 新增一個' + title;
    add.addEventListener('click', function () {
      closeModal();
      editGenOption(tab, which, null, back);
    });
    wrap.appendChild(add);

    showModal({
      title: title,
      body: wrap,
      buttons: [{ text: '關閉', onClick: closeModal }]
    });
  }

  /** 新增或編輯單一選項。含使用者輸入，所以點背景與 Esc 都不關（4.5）。
      存檔與取消都回到 back()（那份清單），不直接關掉整個彈窗。 */
  function editGenOption(tab, which, opt, back) {
    var isNew = !opt;
    var list = genList(tab, which);

    var wrap = document.createElement('div');

    var l1 = document.createElement('label');
    l1.textContent = '名稱';
    var name = document.createElement('input');
    name.type = 'text';
    name.value = opt ? opt.name : '';
    name.placeholder = '簡短名稱，方便你辨認';
    wrap.appendChild(l1);
    wrap.appendChild(name);

    var tpl = null;
    var noSrc = null;
    var needDigit = null;
    var pre = null;
    var post = null;
    var show = null;
    var extra = null;
    var text = null;

    if (which === 'g1') {
      var l2 = document.createElement('label');
      l2.textContent = '文案';
      tpl = document.createElement('textarea');
      tpl.rows = 5;
      tpl.value = opt ? opt.tpl : '';
      tpl.placeholder = '選到這個時要產生的整段文字';
      wrap.appendChild(l2);
      wrap.appendChild(tpl);

      var hint = document.createElement('div');
      hint.className = 'field-hint';
      hint.innerHTML =
        '可以用三種記號：<br>'
        + '<b>' + DB.GEN_CODE_TOKEN + '</b> 換成這一次的隨機碼<br>'
        + '<b>' + DB.GEN_WAY_TOKEN + '</b> 換成下面那一組選到的名稱<br>'
        + '<b>〔…〕</b> 括起來的段落，選到「不需要來源」的選項時整段消失';
      wrap.appendChild(hint);
    } else if (which === 'cats') {
      pre = addField(wrap, tab.labels.mode1 + '模式的前段顯示成',
        opt ? opt.pre : '', '留空就用上面的名稱');
      post = addField(wrap, tab.labels.mode1 + '模式的後段顯示成',
        opt ? opt.post : '', '留空就用上面的名稱');
      extra = addField(wrap, '附加句',
        opt ? opt.extra : '', '選到這個時接在最後面的一行，不填就沒有');
    } else if (which === 'catsOne') {
      // 單向只有一段，顯示字就只有一格
      show = addField(wrap, '顯示成',
        opt ? opt.show : '', '留空就用上面的名稱');
      extra = addField(wrap, '附加句',
        opt ? opt.extra : '', '選到這個時接在最後面的一行，不填就沒有');
    } else if (which === 'notes') {
      text = addField(wrap, '內容',
        opt ? opt.text : '', '實際填進去的字，留空就用上面的名稱');
    } else {
      noSrc = addCheck(wrap, '這個選項不需要來源字串',
        opt ? opt.noSrc : false,
        '勾了之後不會出現貼上欄，隨機碼改成長版，本身就是完整結果');
      needDigit = addCheck(wrap, '結果一定要有數字',
        opt ? opt.needDigit : false,
        '取到的尾段全是英文字母時，把隨機碼的最後一碼換成數字');
    }

    function ok() {
      var v = name.value.trim();
      if (!v) { name.focus(); return; }
      var target = opt;
      if (isNew) {
        if (which === 'g1') target = { id: DB.uid(), name: v, tpl: '' };
        else if (which === 'g2') target = { id: DB.uid(), name: v, noSrc: false, needDigit: false };
        else if (which === 'cats') target = { id: DB.uid(), name: v, pre: '', post: '', extra: '' };
        else if (which === 'catsOne') target = { id: DB.uid(), name: v, show: '', extra: '' };
        else target = { id: DB.uid(), name: v, text: '' };
        list.push(target);
      }
      target.name = v;
      if (which === 'g1') {
        target.tpl = tpl.value;
      } else if (which === 'g2') {
        target.noSrc = noSrc.checked;
        target.needDigit = needDigit.checked;
      } else if (which === 'cats') {
        target.pre = pre.value.trim();
        target.post = post.value.trim();
        target.extra = extra.value.trim();
      } else if (which === 'catsOne') {
        target.show = show.value.trim();
        target.extra = extra.value.trim();
      } else {
        target.text = text.value.trim();
      }
      tab.updatedAt = DB.nowIso();
      closeModal();
      DB.touch();
      if (back) back();
    }

    [name, tpl, pre, post, show, extra, text].forEach(function (el) {
      if (el) el.addEventListener('keydown', function (e) { e.stopPropagation(); });
    });

    showModal({
      title: (isNew ? '新增' : '編輯') + tab.labels[which],
      body: wrap,
      noEscape: true,
      buttons: [
        // 取消是「不改這一個」，不是「離開管理」，所以一樣回到清單
        { text: '取消',
          onClick: function () { closeModal(); if (back) back(); } },
        { text: '儲存', cls: 'btn-primary', onClick: ok }
      ]
    });
  }

  /** 彈窗裡的一個勾選項，附一行說明。 */
  function addCheck(wrap, text, checked, hint) {
    var row = document.createElement('label');
    row.className = 'gen-check';
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!checked;
    row.appendChild(box);
    var span = document.createElement('span');
    span.textContent = text;
    row.appendChild(span);
    wrap.appendChild(row);
    if (hint) {
      var h = document.createElement('div');
      h.className = 'field-hint';
      h.textContent = hint;
      wrap.appendChild(h);
    }
    return box;
  }

  /** 彈窗裡的一個單行欄位。說明放在框裡當淡字，不在框下面再寫一次——
      同一句話上下各出現一遍只是把彈窗撐長。 */
  function addField(wrap, label, value, hint) {
    var l = document.createElement('label');
    l.textContent = label;
    wrap.appendChild(l);
    var input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    if (hint) input.placeholder = hint;
    wrap.appendChild(input);
    return input;
  }

  /**
   * 表單卡的輸出格式。兩個模式各寫一整份，程式不替誰跑兩次（11.37）。
   * 收在 ⋯ 選單裡：這是設定一次就不太會動的東西，不該每天佔著卡片版面。
   */
  function editFormTemplate(tab) {
    var wrap = document.createElement('div');

    function section(key, tokens) {
      var l = document.createElement('label');
      l.textContent = '「' + tab.labels[key === 'tplTwo' ? 'mode1' : 'mode2']
        + '」的輸出格式';
      wrap.appendChild(l);

      var ta = document.createElement('textarea');
      ta.rows = 8;
      ta.value = tab[key];
      ta.placeholder = '把最後要複製的樣子整個寫出來';
      ta.addEventListener('keydown', function (e) { e.stopPropagation(); });
      wrap.appendChild(ta);

      var hint = document.createElement('div');
      hint.className = 'field-hint';
      hint.innerHTML = '可以用的記號：' + Object.keys(tokens).map(function (k) {
        return '<b>' + tokens[k] + '</b>';
      }).join('　');
      wrap.appendChild(hint);
      return ta;
    }

    var two = section('tplTwo', DB.FORM_TOKENS_TWO);
    var extra = document.createElement('div');
    extra.className = 'field-hint';
    extra.textContent = '兩段的對象與' + tab.labels.cats
      + '各有自己的記號，所以直接把兩段都寫出來就好，程式不會替你重複。';
    wrap.appendChild(extra);

    var one = section('tplOne', DB.FORM_TOKENS);

    function ok() {
      tab.tplTwo = two.value;
      tab.tplOne = one.value;
      tab.updatedAt = DB.nowIso();
      closeModal();
      DB.touch();
    }

    showModal({
      title: '輸出格式',
      body: wrap,
      noEscape: true,
      buttons: [
        { text: '取消', onClick: closeModal },
        { text: '儲存', cls: 'btn-primary', onClick: ok }
      ]
    });
  }

  /**
   * 模式改名。只有兩個而且不能增減——那兩種模式的行為（跑兩段或跑一段、
   * 欄位長什麼樣）是寫在程式裡的，不是資料。
   */
  function manageModes(tab) {
    var wrap = document.createElement('div');
    var one = addField(wrap, '第一個模式的名稱', tab.labels.mode1, '');
    var two = addField(wrap, '第二個模式的名稱', tab.labels.mode2, '');

    var hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = '這兩種模式不能增減：第一種會產生兩段、第二種一段，'
      + '欄位也不一樣。這裡只改名字。';
    wrap.appendChild(hint);

    function ok() {
      tab.labels.mode1 = one.value.trim() || tab.labels.mode1;
      tab.labels.mode2 = two.value.trim() || tab.labels.mode2;
      tab.updatedAt = DB.nowIso();
      closeModal();
      DB.touch();
    }

    [one, two].forEach(function (el) {
      el.addEventListener('keydown', function (e) { e.stopPropagation(); });
    });

    showModal({
      title: '模式名稱',
      body: wrap,
      noEscape: true,
      buttons: [
        { text: '取消', onClick: closeModal },
        { text: '儲存', cls: 'btn-primary', onClick: ok }
      ]
    });
  }

  /* ============================================================
     數字鍵 1～9 複製
     ------------------------------------------------------------
     這不是全域熱鍵，只在這個網頁有焦點、而且沒有在輸入框裡打字時才生效，
     所以不會影響其他程式，也沒有桌面版「註冊 ~ 之後在哪都打不出來」的問題。
     ============================================================ */

  function onKeyDown(e) {
    var t = e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

    if (e.key === 'Escape') {
      if (!$('modalBackdrop').hidden) {
        if (!modalNoEscape) closeModal();
        return;
      }
      if (!$('menuPanel').hidden) { $('menuPanel').hidden = true; return; }
      if (!$('zoomPanel').hidden) { $('zoomPanel').hidden = true; return; }
      if (!$('syncPanel').hidden) { $('syncPanel').hidden = true; return; }
      if (colorPop) { closeColorPop(); return; }
      if (Theme.isOpen()) { Theme.close(); return; }
      if (t === $('searchBox')) { $('searchBox').value = ''; setSearch(''); render(); }
      return;
    }

    // Ctrl／Win 組合一律讓給瀏覽器，不搶
    if (e.ctrlKey || e.metaKey) return;
    if (!$('modalBackdrop').hidden) return;

    var ch = String(e.key || '').toUpperCase();
    if (!/^[0-9A-Z]$/.test(ch)) return;

    // 純字元的複製鍵在打字時要讓路，不然搜尋框跟編輯框都不能用；
    // Alt 組合不會出現在正常輸入裡，所以打字中照樣有效
    if (typing && !e.altKey) return;

    var entry = state.hotkeys[(e.altKey ? 'ALT+' : '') + ch];
    if (entry) {
      e.preventDefault();
      Clip.copy(entry.row.content, entry.el, entry.row.label);
    }
  }

  /* ============================================================
     ☰ 選單
     ============================================================ */

  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function stamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
           '_' + p(d.getHours()) + p(d.getMinutes());
  }

  /* ============================================================
     最近刪除
     ------------------------------------------------------------
     刪掉的卡片與分類先進保留區（資料層的 trash），保留兩天或三十筆。
     這裡只負責畫清單與轉達動作。跟選項管理一樣，做完一筆回到清單，
     按「關閉」才真的關掉。
     ============================================================ */

  function sinceText(iso) {
    var ms = Date.now() - Date.parse(iso);
    if (!(ms >= 0)) return '';
    var min = Math.floor(ms / 60000);
    if (min < 1) return '剛剛';
    if (min < 60) return min + ' 分鐘前';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' 小時前';
    return Math.floor(hr / 24) + ' 天前';
  }

  function trashKindText(e) {
    if (e.kind === 'category') return '分類，含 ' + e.count + ' 張卡片';
    if (e.kind === 'clear') return '清除內容，共 ' + e.count + ' 張卡片';
    return Tabs.TYPE_LABEL[e.type] || '卡片';
  }

  function openTrash() {
    var list = DB.trashList();

    function back() { openTrash(); }

    var wrap = document.createElement('div');

    var head = document.createElement('div');
    head.className = 'row-hint';
    head.style.marginBottom = '10px';
    head.textContent = list.length
      ? '刪掉的卡片與分類會留在這裡 ' + DB.TRASH_DAYS + ' 天，最多 '
        + DB.TRASH_MAX + ' 筆，滿了先擠掉最舊的。'
      : '這裡是空的。刪掉的卡片與分類會先留在這裡 ' + DB.TRASH_DAYS + ' 天。';
    wrap.appendChild(head);

    list.forEach(function (e) {
      var row = document.createElement('div');
      row.className = 'gen-manage-row trash-row';

      var main = document.createElement('div');
      main.className = 'trash-main';

      var name = document.createElement('div');
      name.className = 'trash-name';
      name.textContent = e.name || '未命名';
      main.appendChild(name);

      var meta = document.createElement('div');
      meta.className = 'trash-meta';
      var where = e.kind === 'tab' && e.categoryName ? '　·　原本在「' + e.categoryName + '」' : '';
      meta.textContent = trashKindText(e) + where + '　·　' + sinceText(e.deletedAt);
      main.appendChild(meta);

      row.appendChild(main);

      var undo = document.createElement('button');
      undo.className = 'gen-chip';
      undo.textContent = '還原';
      undo.addEventListener('click', function () {
        var r = DB.restoreTrash(e.id, state.currentCategoryId);
        closeModal();
        if (r) {
          var msg = '已還原「' + r.name + '」';
          if (r.kind !== 'tab') msg += '（' + (r.count || 0) + ' 張卡片）';
          if (r.movedTo) msg += '，原分類已經不在，放到「' + r.movedTo + '」';
          Clip.toast(msg);
        }
        back();
      });
      row.appendChild(undo);

      row.appendChild(Tabs.iconBtn('✕', '永久刪除', function () {
        closeModal();
        confirmModal('永久刪除',
          '將永久刪除「' + (e.name || '未命名') + '」。<br><br>此動作無法復原。',
          '永久刪除', function () {
            DB.purgeTrashItem(e.id);
            back();
          }, true, back);
      }, 'danger-btn'));

      wrap.appendChild(row);
    });

    var buttons = [];
    if (list.length) {
      buttons.push({
        text: '全部清空',
        cls: 'btn-danger',
        onClick: function () {
          closeModal();
          confirmModal('清空最近刪除',
            '將永久刪除保留區裡的 ' + list.length + ' 筆。<br><br>此動作無法復原。',
            '全部清空', function () {
              DB.clearTrash();
              Clip.toast('已清空');
              back();
            }, true, back);
        }
      });
    }
    buttons.push({ text: '關閉', onClick: closeModal });

    showModal({ title: '最近刪除', body: wrap, buttons: buttons });
  }

  /* ============================================================
     存不進去的時候要講出來
     ------------------------------------------------------------
     以前寫入失敗只在主控台印一行，畫面完全沒反應，使用者會以為存好了。
     這裡把原因與解法一次講清楚，而且只在「從成功變成失敗」時跳一次。
     ============================================================ */

  function showSaveError() {
    showModal({
      title: '變更畫面失敗，未成功儲存',
      body: '<div style="line-height:1.8;color:var(--text-dim)">'
        + '<strong>剛才的變更還在畫面上，但沒有寫進這個分頁的暫存區。</strong>'
        + '現在重新整理會回到上一次成功儲存的狀態；'
        + '已經登入雲端的話，下一次同步仍然會把畫面上的內容傳上去。<br><br>'
        + '<strong>常見原因</strong><br>'
        + '· 這個分頁的儲存空間滿了（瀏覽器大約給每個網站 5MB）<br>'
        + '· 瀏覽器設定擋掉了網站資料<br>'
        + '· 硬碟空間不足<br><br>'
        + '<strong>建議照這個順序處理</strong><br>'
        + '1. 先「☰ → 匯出資料」存一份檔案——畫面上的內容是完整的，先留底<br>'
        + '2. 「☰ → 最近刪除」按「全部清空」<br>'
        + '3. 刪掉用不到的卡片，特別是內容很長的便籤<br>'
        + '4. 確認瀏覽器沒有擋掉網站資料（無痕視窗不影響分頁暫存）<br>'
        + '5. 都做完還是跳這個訊息，就用剛才那份匯出檔在另一台電腦匯入'
        + '</div>',
      buttons: [{ text: '知道了', cls: 'btn-primary', onClick: closeModal }]
    });
  }

  /** 刪除確認的最後一句。可還原的東西不該寫「無法復原」。 */
  function deleteTail(recoverable) {
    return recoverable
      ? '刪掉之後 ' + DB.TRASH_DAYS + ' 天內可以從 ☰ →「最近刪除」還原。'
      : '此動作無法復原。';
  }

  /* ============================================================
     瀏覽器儲存空間
     ------------------------------------------------------------
     收在 ☰ 選單裡：平常不佔畫面，要處理的動作（匯出、最近刪除）就在旁邊。
     超過門檻才提醒一次——每次開頁面只講一次，不然每存一次檔就跳一次。
     ============================================================ */

  var QUOTA_WARN = 80;
  var quotaWarned = false;
  var quotaCheckedAt = 0;

  /** 小的時候用 KB，不然一律顯示 0.0 MB 看起來像沒在存。 */
  function fmtMB(chars) {
    if (chars < 1024 * 1024) return Math.round(chars / 1024) + ' KB';
    return (chars / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function quotaLevel(pct) {
    if (pct >= 95) return 'full';
    if (pct >= QUOTA_WARN) return 'warn';
    return '';
  }

  function updateQuotaRow() {
    var box = $('menuQuota');
    if (!box) return;
    var u = DB.storageUsage();
    if (!u) { box.hidden = true; return; }
    box.hidden = false;
    var pct = u.percent;
    // 有東西但不到 0.1% 時寫 <0.1%，寫 0% 會讓人以為沒在存
    var shown = (u.used > 0 && pct < 0.1) ? '<0.1%' : pct + '%';
    $('menuQuotaText').innerHTML = '儲存空間　<b>' + shown + '</b>';
    $('menuQuotaText').title = fmtMB(u.used) + '／' + fmtMB(u.limit);
    var fill = $('menuQuotaFill');
    fill.style.width = Math.max(pct, u.used > 0 ? 1.5 : 0) + '%';
    var lv = quotaLevel(pct);
    if (lv) fill.dataset.level = lv;
    else delete fill.dataset.level;
  }

  /** 誰佔掉了空間。直接寫出來，不必讓使用者自己一張張猜。 */
  function quotaBreakdownHtml() {
    var b = DB.storageBreakdown(5);
    if (!b || !b.tabs.length) return '';
    var html = '<strong style="color:var(--text)">目前最佔空間的</strong><br>';
    var listed = 0;
    b.tabs.forEach(function (t) {
      if (t.chars < 1024) return;     // 不到 1KB 的列出來只是雜訊
      listed++;
      var label = Tabs.TYPE_LABEL[t.type] || t.type;
      html += '· ' + label + '「' + escapeText(t.title) + '」　'
        + fmtMB(t.chars) + '<br>';
    });
    if (b.trash > 1024) {
      html += '· 最近刪除（保留區）　' + fmtMB(b.trash) + '<br>';
    }
    if (b.other > 1024) {
      html += '· 這個網址下的其他東西　' + fmtMB(b.other)
        + '（同一個帳號的別的 Pages 專案）<br>';
    }
    if (!listed && b.trash <= 1024 && b.other <= 1024) return '';
    return html + '<br>';
  }

  /** 使用者自己打的字要進 HTML，先把角括號與 & 換掉（對照 tabs.js 的 setText）。 */
  function escapeText(s) {
    return String(s == null ? '' : s)
      .split('&').join('&amp;')
      .split('<').join('&lt;')
      .split('>').join('&gt;');
  }

  /** 重繪時順手看一眼，但不要每次都掃——三秒內只掃一次。 */
  function maybeWarnQuota() {
    var now = Date.now();
    if (now - quotaCheckedAt < 3000) return;
    quotaCheckedAt = now;
    var u = DB.storageUsage();
    if (!u || u.percent < QUOTA_WARN || quotaWarned) return;
    quotaWarned = true;
    showModal({
      title: '儲存空間快滿了',
      body: '<div style="line-height:1.8;color:var(--text-dim)">'
        + '這個分頁的儲存空間已經用掉 <strong>' + u.percent + '%</strong>'
        + '（' + fmtMB(u.used) + '／' + fmtMB(u.limit) + '）。'
        + '<strong>滿了之後新的變更會存不進去。</strong><br><br>'
        + '<strong>建議照這個順序處理</strong><br>'
        + '1. 先「☰ → 匯出資料」存一份留底<br>'
        + '2. 「☰ → 最近刪除」按「全部清空」<br>'
        + '3. 刪掉用不到的卡片，特別是內容很長的便籤<br><br>'
        + quotaBreakdownHtml()
        + '這個訊息每次開啟頁面只會出現一次。目前的用量隨時可以在 ☰ 選單最下面看到。'
        + '</div>',
      buttons: [{ text: '知道了', cls: 'btn-primary', onClick: closeModal }]
    });
  }

  function handleMenu(act) {
    $('menuPanel').hidden = true;

    if (act === 'export') {
      /* 只有存在「加密」卡片才需要驗身分。全部都是不加密卡片時
         匯出完全不會被打斷——分享給別人的人多半是這種情況。 */
      var locked = DB.raw().tabs.filter(function (t) {
        return t.type === 'private' && t.encrypted && t.vault && !Vault.isCardUnlocked(t.id);
      });
      var doExport = function () {
        DB.saveNow();
        download('便籤資料_' + stamp() + '.json', DB.exportJson());
        Clip.toast('已匯出');
      };
      // 匯出檔裡的加密內容是密文，但仍先驗一次身分才放行
      if (locked.length) askSecret(locked[0], doExport);
      else doExport();
    }

    if (act === 'import') {
      confirmModal('匯入資料',
        '匯入會<strong>覆蓋目前所有內容</strong>。<br><br>' +
        '建議先做一次「匯出資料」留底再繼續。',
        '選擇檔案', function () { $('importFile').click(); }, true);
    }

    if (act === 'trash') openTrash();

    if (act === 'appearance') openAppearance();

    if (act === 'rename') {
      promptModal('修改標題', '顯示在左上角的名稱', DB.raw().appTitle, function (v) {
        DB.raw().appTitle = v;
        DB.touch();
      });
    }

    if (act === 'about') {
      showModal({
        title: '關於',
        body:
          '<div style="line-height:1.85;color:var(--text-dim);font-size:13px">' +
          '<strong style="color:var(--text)">操作方式</strong><br>' +
          '• 點常用語的任一列 → 內容進剪貼簿，切到要用的視窗按 Ctrl+V 貼上<br>' +
          '• 每條常用語可以設一個<strong>複製鍵</strong>，沒在打字時按下去直接複製<br>' +
          '• 常用語從右側 ✎ 編輯；卡片標題、便籤、待辦點文字就能改<br>' +
          '• 多行內容用 Ctrl+Enter 存檔，直接按 Enter 是換行<br>' +
          '• 主題與卡片上色方式在 ☰ →「外觀」切換<br><br>' +
          '<strong style="color:var(--text)">資料存在哪</strong><br>' +
          '<strong>放在這個分頁的暫存區，關掉分頁就清掉</strong>，登出也會清掉。' +
          '真正長期保存的地方是雲端同步（頂部列那顆雲朵）——' +
          '登入之後資料會存在你自己雲端硬碟的隱藏資料夾裡，' +
          '換電腦或重開機打開網址、登入同一個帳號就回來了。<br>' +
          '所以：<strong>沒登入的話，這個分頁關掉東西就沒了</strong>。' +
          '公用電腦上這是刻意的（不留痕跡）；自己的電腦上請先登入再輸入內容，' +
          '或用「匯出資料」自己留一份。<br><br>' +
          '<strong style="color:var(--text)">儲存空間滿了怎麼辦</strong><br>' +
          '☰ 選單最下面看得到用掉幾 %，超過 80% 會提醒一次。' +
          '正常打字很難用完（要八千多條常用語才會到 80%），' +
          '真的滿了通常代表有異常。照這個順序處理：<br>' +
          '1. 先「匯出資料」存一份留底，不管後面做什麼都先把東西拿到手上<br>' +
          '2. 「最近刪除」按「全部清空」——保留區裝的是完整的卡片內容<br>' +
          '3. 找出真正大的東西，最常見的是把長文件整篇貼進便籤<br>' +
          '4. 最後手段：匯出、關掉這個分頁重開（暫存區跟著清空）、再匯入回來<br>' +
          '算的是<strong>這個分頁</strong>用掉多少，跟別的分頁與其他專案各自計算。' +
          '雲端同步不會放寬這道牆——資料要先放得進分頁暫存才談得上同步。<br><br>' +
          '<strong style="color:var(--text)">尚未實作</strong><br>' +
          'Google 登入與雲端同步、全域鎖定、表格／參考清單。' +
          '</div>',
        buttons: [{ text: '關閉', onClick: closeModal }]
      });
    }
  }

  /* ============================================================
     啟動
     ============================================================ */

  function init() {
    DB.load();
    // 存不進去的時候要講出來，不能只印在主控台
    DB.onSaveError(showSaveError);
    applyTheme();
    Theme.init();    // 先讀樣式表裡的預設值，再疊上使用者自訂的顏色
    Theme.setUI({ show: showModal, close: closeModal, confirm: confirmModal });
    /* 置頂小視窗需要主程式這幾樣能力。用注入而不是直接呼叫，
       是為了讓 pip.js 可以排在 app.js 前面載入（它只依賴 DB／Vault／Clip／Tabs） */
    PiP.setUI({
      openLinks: openLinks,
      lockCard: lockCard,
      privateEntries: privateEntries,
      autoLockMinutes: AUTO_LOCK_MINUTES,
      onChange: render
    });
    DB.onChange(render);

    /* 雲端同步。**不主動跳授權視窗**——只是想看一眼常用語的時候被 Google
       的視窗擋住很煩。但這個分頁先前登入過時會自動去靜默取一次權杖
       （drive.js 的 resume），那個動作不跳任何視窗，所以重新整理之後
       資料會自己回來。 */
    Drive.init({ onStatus: updateSyncBtn, onConflict: askConflict });

    /* 連分頁暫存都不能用時（某些瀏覽器設定），資料只在記憶體裡——
       重新整理就沒了。這種狀況一定要講，不然使用者會以為存好了（11.44）。 */
    if (DB.memoryOnly()) {
      setTimeout(function () {
        Clip.toast('這個瀏覽器不讓網頁暫存資料，這一輪的內容只在記憶體裡，'
          + '重新整理就會消失——請先登入雲端，或用「☰ → 匯出資料」留底', true);
      }, 600);
    }

    /* 舊版的資料放在 localStorage，新版改成分頁暫存。搬過來之後講一聲，
       不然「關掉分頁就沒了」這個新行為會讓人措手不及。 */
    if (DB.legacyMigrated()) {
      setTimeout(function () {
        showModal({
          title: '資料的存放方式改了',
          body: '<div style="line-height:1.8;color:var(--text-dim)">'
            + '你原本存在這個瀏覽器裡的資料已經<strong>搬到這個分頁的暫存區</strong>，'
            + '內容一樣，畫面看起來也一樣。<br><br>'
            + '<strong>差別是：關掉這個分頁（或登出）資料就會清掉。</strong>'
            + '這是為了在公用電腦上不留痕跡。<br><br>'
            + '長期保存請用<strong>雲端同步</strong>（頂部列那顆雲朵）：'
            + '登入之後資料存在你自己雲端硬碟的隱藏資料夾，'
            + '換電腦或重開機登入同一個帳號就回來了。<br><br>'
            + '現在建議先做兩件事：<strong>登入雲端</strong>，'
            + '或先「☰ → 匯出資料」把這份東西存成檔案。'
            + '</div>',
          buttons: [{ text: '知道了', cls: 'btn-primary', onClick: closeModal }]
        });
      }, 400);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) clearDueTimer();
      else render();   // 回到前景先重算一次，不信任背景期間的計時器
    });

    // 每張卡片各自計時，所以這個回呼會帶著是哪一張到期
    Vault.onLock(function () {
      Clip.toast('已超過 ' + AUTO_LOCK_MINUTES + ' 分鐘，內容自動隱藏');
      render();
    });

    $('btnAddCategory').addEventListener('click', function () {
      promptModal('新增分類', '分類名稱', '', function (v) {
        var c = DB.addCategory(v);
        state.currentCategoryId = c.id;
        render();
      });
    });

    $('btnAddTab').addEventListener('click', openAddTab);

    /* 搜尋去抖：每按一鍵就整批比對加重畫，資料一多就會頓住鍵盤
       （實測每鍵 100～650ms）。改成停手之後才做一次，打字期間完全不做事。
       清空搜尋不等待——那是「我要回去」，應該立刻回應。 */
    var searchTimer = null;
    $('searchBox').addEventListener('input', function (e) {
      var v = e.target.value;
      if (searchTimer) clearTimeout(searchTimer);
      if (!String(v || '').trim()) {
        setSearch('');
        renderContent();
        return;
      }
      searchTimer = setTimeout(function () {
        searchTimer = null;
        setSearch(v);
        renderContent();
      }, SEARCH_DELAY);
    });

    $('appTitle').addEventListener('click', function () { handleMenu('rename'); });

    $('btnMenu').addEventListener('click', function (e) {
      e.stopPropagation();
      $('zoomPanel').hidden = true;
      $('syncPanel').hidden = true;
      $('menuPanel').hidden = !$('menuPanel').hidden;
      if (!$('menuPanel').hidden) updateQuotaRow();
    });

    $('btnSync').addEventListener('click', function (e) {
      e.stopPropagation();
      $('menuPanel').hidden = true;
      $('zoomPanel').hidden = true;
      if ($('syncPanel').hidden) openSyncPanel();
      else $('syncPanel').hidden = true;
    });

    $('btnZoom').addEventListener('click', function (e) {
      e.stopPropagation();
      $('menuPanel').hidden = true;
      $('syncPanel').hidden = true;
      if ($('zoomPanel').hidden) openZoomPanel();
      else $('zoomPanel').hidden = true;
    });

    $('menuPanel').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b) handleMenu(b.dataset.act);
    });

    document.addEventListener('click', function (e) {
      if (!$('menuPanel').hidden && !e.target.closest('#menuPanel') && e.target !== $('btnMenu')) {
        $('menuPanel').hidden = true;
      }
      if (!$('zoomPanel').hidden && !e.target.closest('#zoomPanel') && !e.target.closest('#btnZoom')) {
        $('zoomPanel').hidden = true;
      }
      if (!$('syncPanel').hidden && !e.target.closest('#syncPanel') && !e.target.closest('#btnSync')) {
        $('syncPanel').hidden = true;
      }
      if (colorPop && !e.target.closest('.color-pop') && !e.target.closest('.color-dot')) {
        closeColorPop();
      }
    });
    // 捲動時色點會移走，小視窗不跟著動，乾脆關掉
    document.addEventListener('scroll', closeColorPop, true);
    window.addEventListener('resize', closeColorPop);
    // 視窗變寬變窄會換欄數，佔格數要重算
    window.addEventListener('resize', layoutGrid);

    // 刻意不做「點背景關閉彈窗」。
    // 那是常見慣例，但這些彈窗裡都有使用者正在打的內容，
    // 手滑點到框外就整批消失，代價遠大於方便。
    // 關閉一律要走明確的動作：取消、儲存、或關閉鈕。

    $('importFile').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          DB.importJson(String(reader.result));
          state.currentCategoryId = null;
          render();
          Clip.toast('匯入完成');
        } catch (err) {
          Clip.toast('匯入失敗：' + err.message, true);
        }
      };
      reader.readAsText(file, 'utf-8');
      e.target.value = '';
    });

    document.addEventListener('keydown', onKeyDown);

    // 關閉分頁前確保最後的變更有寫進去
    window.addEventListener('beforeunload', function () { DB.saveNow(); });

    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
