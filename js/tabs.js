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
    table: '表格',
    private: '私人'
  };

  /* ---------- 就地編輯（非常用語類型使用） ---------- */

  function makeEditable(el, getValue, setValue, opt) {
    opt = opt || {};
    el.classList.add('editable');

    function paint() {
      var v = getValue();
      if (v) {
        el.textContent = v;
        el.classList.remove('placeholder');
      } else {
        el.textContent = opt.placeholder || '還沒有內容';
        el.classList.add('placeholder');
      }
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
      input.select();

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

  /* ---------- 卡片外框 ---------- */

  function renderCard(tab, ctx) {
    var card = document.createElement('div');
    card.className = 'card';
    // 常用語是主要工作區，佔滿整行寬度，內容才有地方完整呈現
    if (tab.type === 'quickphrase') card.classList.add('card-wide');
    if (tab.pinned) card.classList.add('pinned');
    card.dataset.tabId = tab.id;

    var head = document.createElement('div');
    head.className = 'card-head';

    // 拖曳把手：只有這裡能起拖，不然卡片裡選字、點常用語都會誤觸拖曳
    var handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = '⠿';
    handle.title = '按住拖曳可調整卡片順序';
    handle.addEventListener('mousedown', function () { card.draggable = true; });
    head.appendChild(handle);

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

    // 連結卡片才有：批次開啟被瀏覽器擋下時的處理說明，隨時可以叫出來看
    if (tab.type === 'link') {
      head.appendChild(iconBtn('?', '一次開多個分頁被擋下時怎麼辦', function () {
        ctx.showPopupHelp();
      }, 'help-btn'));
    }

    if (tab.type === 'private') {
      if (tab.encrypted && Vault.isCardUnlocked(tab.id)) {
        head.appendChild(iconBtn('⦿', '立即隱藏內容', function () {
          ctx.lockCard(tab);
        }));
      }
      head.appendChild(iconBtn(tab.encrypted ? '⚿' : '⚯',
        tab.encrypted ? '取消加密' : '加上密碼保護',
        function () { ctx.convertPrivate(tab); }));
    }

    var pinBtn = iconBtn(tab.pinned ? '★' : '☆',
      tab.pinned ? '取消釘選' : '釘選（固定在最上面）',
      function () { ctx.togglePin(tab); },
      tab.pinned ? 'pin-on' : '');
    head.appendChild(pinBtn);

    head.appendChild(iconBtn('✕', '刪除這張卡片', function () {
      var msg = '將刪除「' + (tab.title || '未命名') + '」這張卡片及其全部內容。';
      if (tab.type === 'private') {
        ctx.confirmDeletePrivate(tab, '刪除卡片', msg, function () { DB.deleteTab(tab.id); });
      } else {
        ctx.confirmDelete('刪除卡片', msg, function () { DB.deleteTab(tab.id); });
      }
    }, 'danger-btn'));

    card.appendChild(head);

    ctx.attachDrag(card, tab);

    var body = document.createElement('div');
    body.className = 'card-body';
    card.appendChild(body);

    (RENDERERS[tab.type] || renderUnknown)(tab, body, ctx);

    return card;
  }

  /* ---------- 便籤 ---------- */

  function renderNote(tab, body) {
    var p = document.createElement('div');
    body.appendChild(p);
    makeEditable(p,
      function () { return tab.content; },
      function (v) { tab.content = v; tab.updatedAt = DB.nowIso(); DB.touch(true); },
      {
        multiline: true,
        placeholder: '還沒有內容',
        // 每張便籤各自記，跟著資料檔走，所以匯出匯入與日後的 Drive 同步都會帶著
        getHeight: function () { return tab.editorHeight; },
        setHeight: function (h) {
          if (tab.editorHeight === h) return;
          tab.editorHeight = h;
          DB.touch(true);
        }
      });
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
      label.textContent = row.label || '未命名';
      if (!row.label) label.classList.add('placeholder');
      el.appendChild(label);

      var content = document.createElement('div');
      content.className = 'qp-content';
      content.textContent = row.content || '還沒有內容';
      if (!row.content) content.classList.add('placeholder');
      el.appendChild(content);

      var actions = document.createElement('div');
      actions.className = 'qp-actions';

      // 展開鈕預設藏著，等下面量到內容真的被截斷才顯示
      var expandBtn = iconBtn('▾', '展開完整內容', function () {
        var open = el.classList.toggle('expanded');
        expandBtn.textContent = open ? '▴' : '▾';
        expandBtn.title = open ? '收合' : '展開完整內容';
      });
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

      if (key) ctx.registerHotkey(key, row, el);

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
  }

  /* ---------- 倒數 ---------- */

  /** 2026-09-30 → 2026年9月30日 */
  function formatDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '';
    return Number(m[1]) + '年' + Number(m[2]) + '月' + Number(m[3]) + '日';
  }

  var WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

  function renderCountdown(tab, body, ctx) {
    tab.items = tab.items || [];

    var days = document.createElement('div');
    days.className = 'countdown-days';

    var dateLine = document.createElement('div');
    dateLine.className = 'countdown-date';

    var picker = document.createElement('input');
    picker.type = 'date';
    picker.className = 'date-picker';
    picker.value = tab.dueDate || '';
    picker.title = '點一下選擇日期';

    function paint() {
      if (!tab.dueDate) {
        days.textContent = '—';
        days.className = 'countdown-days';
        dateLine.textContent = '尚未設定日期';
        return;
      }
      var due = new Date(tab.dueDate + 'T00:00:00');
      var today = new Date();
      today.setHours(0, 0, 0, 0);
      var diff = Math.round((due - today) / 86400000);

      days.className = 'countdown-days';
      if (diff > 0) {
        days.innerHTML = diff + ' <small>天後</small>';
        if (diff <= 3) days.classList.add('soon');
      } else if (diff === 0) {
        days.innerHTML = '就是今天';
        days.classList.add('soon');
      } else {
        days.innerHTML = Math.abs(diff) + ' <small>天前已過期</small>';
        days.classList.add('overdue');
      }

      dateLine.textContent = formatDate(tab.dueDate) +
                             '（週' + WEEKDAY[due.getDay()] + '）';
    }

    /*
     * Chrome 的 <input type="date"> 只有點右邊那個小日曆圖示才會展開選單，
     * 點文字區域什麼都不會發生——使用者回報「點日期欄位應該要出現日曆」。
     * showPicker() 可以主動叫出來，但它要求必須由使用者手勢觸發，
     * 而且是比較新的 API，所以包在 try 裡，失敗就退回原本的行為。
     */
    picker.addEventListener('click', function () {
      if (typeof picker.showPicker === 'function') {
        try { picker.showPicker(); } catch (err) { /* 退回瀏覽器預設行為 */ }
      }
    });

    picker.addEventListener('change', function () {
      tab.dueDate = picker.value;
      tab.updatedAt = DB.nowIso();
      DB.touch(true);
      paint();
    });

    body.appendChild(days);
    body.appendChild(dateLine);
    body.appendChild(picker);
    paint();

    /* ---- 子任務清單（規格書 v1.3 第 1.4 節，先前漏做） ---- */

    var divider = document.createElement('div');
    divider.className = 'countdown-divider';
    divider.textContent = '子任務';
    body.appendChild(divider);

    tab.items.slice().sort(function (a, b) { return a.order - b.order; }).forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'todo-row' + (item.done ? ' done' : '');

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

      row.appendChild(iconBtn('✕', '刪除這項子任務', function () {
        ctx.confirmDelete(
          '刪除子任務',
          '將刪除「' + (item.text || '未命名') + '」。',
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
    add.textContent = '＋ 新增子任務';
    add.addEventListener('click', function () {
      tab.items.push({ id: DB.uid(), text: '', done: false, order: tab.items.length });
      DB.touch();
    });
    body.appendChild(add);
  }

  /* ---------- 連結收藏 ---------- */

  /**
   * 勾選狀態刻意不寫進資料檔，只留在記憶體裡。
   * 這是「這次要開哪幾個」的暫時選擇，不是使用者的設定，
   * 存起來反而會讓下次打開時看到莫名其妙的勾選結果。
   */
  var linkChecked = {};

  function isChecked(id) {
    return linkChecked[id] !== false;   // 預設全勾
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
      var n = links.filter(function (l) { return isChecked(l.id) && (l.urls || []).length; }).length;
      countEl.textContent = '開啟已勾選（' + n + '）';
      countEl.disabled = n === 0;
    }

    if (links.length) {
      var bar = document.createElement('div');
      bar.className = 'link-bar';

      var selAll = document.createElement('button');
      selAll.className = 'link-mini';
      selAll.textContent = '全選';
      selAll.addEventListener('click', function () {
        links.forEach(function (l) { linkChecked[l.id] = true; });
        body.querySelectorAll('.link-check').forEach(function (c) { c.checked = true; });
        refreshCount();
      });

      var selNone = document.createElement('button');
      selNone.className = 'link-mini';
      selNone.textContent = '取消全選';
      selNone.addEventListener('click', function () {
        links.forEach(function (l) { linkChecked[l.id] = false; });
        body.querySelectorAll('.link-check').forEach(function (c) { c.checked = false; });
        refreshCount();
      });

      countEl = document.createElement('button');
      countEl.className = 'btn-primary link-open';
      countEl.addEventListener('click', function () {
        ctx.openLinks(links.filter(function (l) { return isChecked(l.id); }), pickUrl);
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

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'link-check';
      cb.checked = isChecked(link.id);
      cb.title = '勾選後可批次開啟';
      cb.addEventListener('change', function () {
        linkChecked[link.id] = cb.checked;
        refreshCount();
      });
      row.appendChild(cb);

      var urls = link.urls || [];
      var a = document.createElement('a');
      a.href = urls[0] || '#';
      a.textContent = link.name || urls[0] || '未命名連結';
      a.title = urls.join('\n') || '尚未設定網址';
      a.addEventListener('click', function (e) {
        // 單獨點名稱：維持原本的行為，開一個分頁。
        // 但多條備援時要隨機挑，所以不能讓 <a> 用固定的 href 去開
        e.preventDefault();
        var u = pickUrl(link);
        if (!u) { Clip.toast('這個項目還沒有設定網址', true); return; }
        if (!openTab(u)) Clip.toast('分頁被瀏覽器擋下了', true);
      });
      row.appendChild(a);

      if (urls.length > 1) {
        var badge = document.createElement('span');
        badge.className = 'link-badge';
        badge.textContent = urls.length + ' 條備援，隨機開 1 條';
        row.appendChild(badge);
      } else if (!urls.length) {
        var warn = document.createElement('span');
        warn.className = 'link-badge warn';
        warn.textContent = '未設定網址';
        row.appendChild(warn);
      }

      row.appendChild(iconBtn('✎', '編輯', function () {
        ctx.editLink(tab, link);
      }));

      row.appendChild(iconBtn('✕', '刪除這個連結', function () {
        ctx.confirmDelete(
          '刪除連結',
          '將刪除「' + (link.name || urls[0] || '未命名') + '」這個項目。',
          function () {
            tab.links = tab.links.filter(function (x) { return x.id !== link.id; });
            delete linkChecked[link.id];
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
  var LINK_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/>' +
    '<path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';

  function svgIconBtn(svg, title, onClick) {
    var b = document.createElement('button');
    b.className = 'icon-btn';
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

      // 展開鈕。摺疊時整列只露出名稱，型別不標——標了等於幫人分類
      var tri = document.createElement('button');
      tri.className = 'icon-btn pv-tri';
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
      name.textContent = item.name || '未命名';
      head.appendChild(name);

      if (item.url) {
        head.appendChild(svgIconBtn(LINK_SVG, '開啟網址', function () {
          if (!Tabs.openTab(item.url)) Clip.toast('分頁被瀏覽器擋下了', true);
        }));
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
        v.textContent = isSecret ? maskOf(value) : value;
        line.appendChild(v);

        if (isSecret) {
          var shown = false;
          line.appendChild(iconBtn('◉', '暫時顯示', function () {
            shown = !shown;
            v.textContent = shown ? value : maskOf(value);
            v.classList.toggle('secret', !shown);
          }));
        }

        line.appendChild(iconBtn('⧉', '複製' + label, function () {
          Clip.copy(value, line, label);
        }));

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
          }));
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
    private: renderPrivate
  };

  window.Tabs = {
    openTab: openTab,
    renderCard: renderCard,
    TYPE_LABEL: TYPE_LABEL,
    makeEditable: makeEditable,
    iconBtn: iconBtn
  };
})();
