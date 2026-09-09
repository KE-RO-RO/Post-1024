/* ============================================================
   data.js — 資料模型、localStorage 讀寫、匯出／匯入
   ------------------------------------------------------------
   刻意不用 ES module（沒有 type="module"），因為這樣直接用檔案
   總管點兩下 index.html 也能開起來測試；ES module 在 file:// 底下
   會被 CORS 擋掉。全部掛在 window.DB 這個命名空間下。
   ============================================================ */

(function () {
  'use strict';

  var STORAGE_KEY = 'stickyNotes.data.v2';
  var SCHEMA_VERSION = 2;

  /* ---------- 小工具 ---------- */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  /** 取字串的第一個字，給側欄貼紙當短代表字用。 */
  function firstChar(s) {
    return (s || '').trim().charAt(0) || '?';
  }

  /**
   * 連結正規化：舊資料是單一 `url` 字串，新格式是 `urls` 陣列（多條備援網址）。
   * 兩種都吃，統一輸出成陣列，讓畫面層不必到處判斷。
   */
  function normalizeLink(l, j) {
    var urls = [];
    if (Array.isArray(l.urls)) urls = l.urls.slice();
    else if (Array.isArray(l.Urls)) urls = l.Urls.slice();
    if (l.url) urls.push(l.url);
    if (l.Url) urls.push(l.Url);

    urls = urls
      .map(function (u) { return String(u || '').trim(); })
      .filter(function (u, i, arr) { return u && arr.indexOf(u) === i; });

    return {
      id: l.id || l.Id || uid(),
      name: l.name || l.Name || '',
      urls: urls,
      order: typeof l.order === 'number' ? l.order
           : typeof l.Order === 'number' ? l.Order : j
    };
  }

  /**
   * 把複製鍵正規化成統一寫法：'A'、'5'、'ALT+A'。
   * 只接受單一個 0-9 或 A-Z，可選擇搭配 Alt。不合法一律回傳空字串。
   */
  function normalizeHotkey(v) {
    if (!v || typeof v !== 'string') return '';
    var s = v.trim().toUpperCase().replace(/\s+/g, '');
    var alt = false;
    if (s.indexOf('ALT+') === 0) { alt = true; s = s.slice(4); }
    if (!/^[0-9A-Z]$/.test(s)) return '';
    return (alt ? 'ALT+' : '') + s;
  }

  /* ---------- 預設資料 ---------- */

  function emptyData() {
    var catId = uid();
    return {
      version: SCHEMA_VERSION,
      updatedAt: nowIso(),
      appTitle: '便籤／常用語',
      settings: {
        // 鎖定由使用者主動控制，預設不啟用（見規格書 v2.1 第 5 章）
        autoLockEnabled: false,
        autoLockMinutes: 30,
        // 彈出視窗被擋的完整說明只跳一次，之後改用簡短提示
        popupHintShown: false
      },
      categories: [
        { id: catId, name: '常用語', shortLabel: '語', order: 0 }
      ],
      tabs: [
        {
          id: uid(),
          categoryId: catId,
          type: 'quickphrase',
          title: '未命名',
          order: 0,
          pinned: false,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          // 刻意不放任何範例內容。預設資料一旦帶了真實句子，
          // 使用者匯出的檔案就會夾帶不該外流的東西
          rows: []
        }
      ]
    };
  }

  /** 各分頁類型的預設空白內容。 */
  function newTab(type, categoryId, title) {
    var base = {
      id: uid(),
      categoryId: categoryId,
      type: type,
      title: title || '未命名',
      order: 0,
      pinned: false,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    if (type === 'note') base.content = '';
    if (type === 'quickphrase') base.rows = [];
    if (type === 'todo') base.items = [];
    if (type === 'link') base.links = [];
    if (type === 'countdown') { base.dueDate = ''; base.items = []; }
    if (type === 'private') {
      base.badge = '私人';        // 標題列小圓標的文字，可自行改成不起眼的字
      /* encrypted 刻意不給預設值。建立卡片時強制使用者二選一，
         沒選過的卡片不該被當成「已加密」或「未加密」任何一種。 */
      base.encrypted = null;
      base.vault = null;          // { pwd, rec }：這張卡片專屬的金鑰包裹
      base.enc = null;            // { iv, data }：加密後的內容，明文永不進硬碟
      base.entries = [];          // 不加密時的明文內容
    }
    return base;
  }

  /* ---------- 狀態 ---------- */

  var data = emptyData();
  var saveTimer = null;
  var listeners = [];

  function onChange(fn) { listeners.push(fn); }

  function notify() {
    for (var i = 0; i < listeners.length; i++) listeners[i]();
  }

  /**
   * 標記資料已變更：更新時間戳、通知畫面重繪、延遲寫入 localStorage。
   * 延遲 1 秒是為了避免打字時每按一個鍵就寫一次硬碟。
   */
  function touch(skipRender) {
    data.updatedAt = nowIso();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 1000);
    if (!skipRender) notify();
  }

  function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error('寫入 localStorage 失敗', e);
    }
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.categories) {
          data = migrate(parsed);
          return;
        }
      }
    } catch (e) {
      console.error('讀取 localStorage 失敗，改用空白資料', e);
    }
    data = emptyData();
    saveNow();
  }

  /* ---------- 格式相容 ---------- */

  /**
   * 把任何來源的資料轉成目前的內部格式。
   *
   * 需要處理兩種舊格式：
   *  1. 桌面版 WPF 實際存出來的檔（PascalCase、Tabs 底下用 type 區分、含熱鍵欄位）
   *  2. v1.3 規格書第 9 章的草案格式（camelCase、quickPhrases/tableTabs 各自成陣列）
   *     —— 這份草案跟實際實作對不上，但萬一有人照草案手寫過資料，一併吃進來
   */
  function migrate(src) {
    // 桌面版格式：最外層是 PascalCase 的 Categories / Tabs
    if (src.Categories || src.Tabs) return fromDesktop(src);

    var out = {
      version: SCHEMA_VERSION,
      updatedAt: src.updatedAt || nowIso(),
      appTitle: src.appTitle || '便籤／常用語',
      settings: {
        autoLockEnabled: !!(src.settings && src.settings.autoLockEnabled),
        autoLockMinutes: (src.settings && src.settings.autoLockMinutes) || 30,
        popupHintShown: !!(src.settings && src.settings.popupHintShown)
      },
      categories: [],
      tabs: []
    };

    // 保管層原樣搬過去。裡面只有加密後的金鑰包裹，沒有任何明文
    if (src.vault && src.vault.pwd && src.vault.rec) out.vault = src.vault;

    (src.categories || []).forEach(function (c, i) {
      out.categories.push({
        id: c.id || uid(),
        name: c.name || '未命名',
        shortLabel: c.shortLabel || firstChar(c.name),
        order: typeof c.order === 'number' ? c.order : i
      });
    });

    (src.tabs || []).forEach(function (t, i) {
      out.tabs.push(normalizeTab(t, i));
    });

    // 草案格式：常用語列另外收在 quickPhrases 陣列，用 tabId 掛回去
    if (src.quickPhrases) {
      src.quickPhrases.forEach(function (qp) {
        var host = out.tabs.filter(function (t) { return t.id === qp.tabId; })[0];
        if (!host) return;
        if (host.type !== 'quickphrase') return;
        host.rows = host.rows || [];
        host.rows.push({
          id: qp.id || uid(),
          label: qp.label || '',
          content: qp.content || '',
          order: host.rows.length
        });
      });
    }

    if (!out.categories.length) return emptyData();
    return out;
  }

  /** 桌面版 WPF 存檔（PascalCase）→ 內部格式 */
  function fromDesktop(src) {
    var out = {
      version: SCHEMA_VERSION,
      updatedAt: src.SavedAtUtc || nowIso(),
      appTitle: src.AppTitle || '便籤／常用語',
      settings: { autoLockEnabled: false, autoLockMinutes: 30 },
      categories: [],
      tabs: []
    };

    (src.Categories || []).forEach(function (c, i) {
      out.categories.push({
        id: c.Id || uid(),
        name: c.Name || '未命名',
        shortLabel: c.ShortLabel || firstChar(c.Name),
        order: typeof c.Order === 'number' ? c.Order : i
        // IsQuickPhraseZone 直接丟掉：那個標記存在的唯一目的是控制
        // 全域快選熱鍵要不要註冊，瀏覽器版沒有全域熱鍵
      });
    });

    (src.Tabs || []).forEach(function (t, i) {
      var tab = {
        id: t.Id || uid(),
        categoryId: t.CategoryId || '',
        type: (t.type || t.Type || 'note').toLowerCase(),
        title: t.Title || '未命名',
        order: typeof t.Order === 'number' ? t.Order : i,
        pinned: false,
        createdAt: t.CreatedAt || nowIso(),
        updatedAt: t.UpdatedAt || nowIso()
      };

      if (tab.type === 'quickphrase') {
        tab.rows = (t.Rows || []).map(function (r, j) {
          return {
            id: r.Id || uid(),
            label: r.Label || '',
            content: r.Content || '',
            hotkey: '',
            order: typeof r.Order === 'number' ? r.Order : j
            // 桌面版的 Hotkey（例如 "Ctrl+Alt+1"）是全域熱鍵，格式與用途都跟
            // 瀏覽器版的頁內複製鍵不同，不做轉換，一律留空讓使用者重設
          };
        });
      } else if (tab.type === 'note') {
        tab.content = t.Content || '';
      } else if (tab.type === 'todo') {
        tab.items = (t.Items || []).map(function (x, j) {
          return { id: x.Id || uid(), text: x.Text || '', done: !!x.Done, order: j };
        });
      } else if (tab.type === 'link') {
        tab.links = (t.Links || []).map(normalizeLink);
      } else if (tab.type === 'countdown') {
        tab.dueDate = (t.DueDate || '').slice(0, 10);
        tab.items = (t.Items || []).map(function (x, j) {
          return { id: x.Id || uid(), text: x.Text || '', done: !!x.Done, order: j };
        });
      } else if (tab.type === 'table') {
        // 表格類型桌面版沒實作完，原樣保留欄位，等表格介面做好再處理
        tab.columns = t.Columns || [];
        tab.rows = t.Rows || [];
      }

      out.tabs.push(tab);
    });

    if (!out.categories.length) return emptyData();
    return out;
  }

  /** 補齊單一分頁缺少的欄位，避免畫面渲染時到處要判斷 undefined。 */
  function normalizeTab(t, i) {
    var tab = {
      id: t.id || uid(),
      categoryId: t.categoryId || '',
      type: (t.type || 'note').toLowerCase(),
      title: t.title || '未命名',
      order: typeof t.order === 'number' ? t.order : i,
      pinned: !!t.pinned,
      createdAt: t.createdAt || nowIso(),
      updatedAt: t.updatedAt || nowIso()
    };
    if (tab.type === 'note') {
      tab.content = t.content || '';
      // 版面偏好，跟著資料走，沒有就留空讓它用預設高度
      if (t.editorHeight) tab.editorHeight = t.editorHeight;
    }
    if (tab.type === 'quickphrase') {
      tab.rows = (t.rows || []).map(function (r, j) {
        return {
          id: r.id || uid(),
          label: r.label || '',
          content: r.content || '',
          hotkey: normalizeHotkey(r.hotkey),
          order: typeof r.order === 'number' ? r.order : j
        };
      });
    }
    if (tab.type === 'todo') tab.items = t.items || [];
    if (tab.type === 'link') tab.links = (t.links || []).map(normalizeLink);
    if (tab.type === 'countdown') { tab.dueDate = t.dueDate || ''; tab.items = t.items || []; }
    if (tab.type === 'table') { tab.columns = t.columns || []; tab.rows = t.rows || []; }
    if (tab.type === 'private') {
      tab.badge = t.badge || '私人';
      tab.badge = t.badge || '私人';
      tab.encrypted = (t.encrypted === true || t.encrypted === false) ? t.encrypted : null;
      tab.vault = t.vault || null;
      tab.enc = t.enc || null;
      tab.entries = Array.isArray(t.entries) ? t.entries : [];
    }
    return tab;
  }

  /* ---------- 查詢 ---------- */

  function categories() {
    return data.categories.slice().sort(function (a, b) { return a.order - b.order; });
  }

  /** 釘選的卡片一律排在前面，其餘照 order。 */
  function tabsOf(categoryId) {
    return data.tabs
      .filter(function (t) { return t.categoryId === categoryId; })
      .sort(function (a, b) {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return a.order - b.order;
      });
  }

  function findTab(id) {
    return data.tabs.filter(function (t) { return t.id === id; })[0] || null;
  }

  function findCategory(id) {
    return data.categories.filter(function (c) { return c.id === id; })[0] || null;
  }

  /* ---------- 分類操作 ---------- */

  function addCategory(name) {
    var c = {
      id: uid(),
      name: name,
      shortLabel: firstChar(name),
      order: data.categories.length
    };
    data.categories.push(c);
    touch();
    return c;
  }

  function renameCategory(id, name) {
    var c = findCategory(id);
    if (!c) return;
    c.name = name;
    c.shortLabel = firstChar(name);
    touch();
  }

  /** 刪除分類，連同底下所有卡片一起刪掉。 */
  function deleteCategory(id) {
    data.categories = data.categories.filter(function (c) { return c.id !== id; });
    data.tabs = data.tabs.filter(function (t) { return t.categoryId !== id; });
    reorderCategories();
    touch();
  }

  /** 只清空底下的卡片，分類本身留著。 */
  function clearCategory(id) {
    data.tabs = data.tabs.filter(function (t) { return t.categoryId !== id; });
    touch();
  }

  function reorderCategories() {
    categories().forEach(function (c, i) { c.order = i; });
  }

  /** 把 fromId 這張貼紙移到 toId 的位置。 */
  function moveCategory(fromId, toId) {
    var list = categories();
    var from = list.findIndex(function (c) { return c.id === fromId; });
    var to = list.findIndex(function (c) { return c.id === toId; });
    if (from < 0 || to < 0 || from === to) return;
    var moved = list.splice(from, 1)[0];
    list.splice(to, 0, moved);
    list.forEach(function (c, i) { c.order = i; });
    touch();
  }

  function moveCategoryEdge(id, toTop) {
    var list = categories();
    var idx = list.findIndex(function (c) { return c.id === id; });
    if (idx < 0) return;
    var moved = list.splice(idx, 1)[0];
    if (toTop) list.unshift(moved); else list.push(moved);
    list.forEach(function (c, i) { c.order = i; });
    touch();
  }

  /* ---------- 卡片操作 ---------- */

  function addTab(type, categoryId, title) {
    var t = newTab(type, categoryId, title);
    t.order = tabsOf(categoryId).length;
    data.tabs.push(t);
    touch();
    return t;
  }

  function deleteTab(id) {
    data.tabs = data.tabs.filter(function (t) { return t.id !== id; });
    touch();
  }

  /** 拖曳排序：把 fromId 這張卡片移到 toId 的位置。 */
  function moveTab(fromId, toId) {    var a = findTab(fromId);
    var b = findTab(toId);
    if (!a || !b || a.id === b.id || a.categoryId !== b.categoryId) return;

    var list = tabsOf(a.categoryId);
    var from = list.findIndex(function (t) { return t.id === fromId; });
    var to = list.findIndex(function (t) { return t.id === toId; });
    if (from < 0 || to < 0) return;

    var moved = list.splice(from, 1)[0];
    list.splice(to, 0, moved);
    list.forEach(function (t, i) { t.order = i; });
    touch();
  }

  /**
   * 常用語列的拖曳排序。跟卡片排序分開處理：
   * 卡片的順序存在 tabs[].order，列的順序存在 rows[].order。
   */
  function moveRow(tabId, fromRowId, toRowId) {
    var tab = findTab(tabId);
    if (!tab || tab.type !== 'quickphrase' || fromRowId === toRowId) return;

    var list = (tab.rows || []).slice().sort(function (a, b) { return a.order - b.order; });
    var from = list.findIndex(function (r) { return r.id === fromRowId; });
    var to = list.findIndex(function (r) { return r.id === toRowId; });
    if (from < 0 || to < 0) return;

    var moved = list.splice(from, 1)[0];
    list.splice(to, 0, moved);
    list.forEach(function (r, i) { r.order = i; });
    tab.rows = list;
    tab.updatedAt = nowIso();
    touch();
  }

  var PIN_LIMIT = 3;

  function pinnedCount(categoryId, type) {
    return data.tabs.filter(function (t) {
      return t.categoryId === categoryId && t.type === type && t.pinned;
    }).length;
  }

  /**
   * 切換釘選。上限是「同一分類、同一類型最多三個」——
   * 便籤釘三個不會吃掉常用語的額度，各類型分開算。
   * @returns {string|null} 不能釘時回傳原因，成功回傳 null
   */
  function togglePin(tabId) {
    var tab = findTab(tabId);
    if (!tab) return '找不到這張卡片';

    if (tab.pinned) {
      tab.pinned = false;
      touch();
      return null;
    }

    if (pinnedCount(tab.categoryId, tab.type) >= PIN_LIMIT) {
      return '這個分類的「' + (window.Tabs ? Tabs.TYPE_LABEL[tab.type] : tab.type) +
             '」已經釘了 ' + PIN_LIMIT + ' 個，請先取消其中一個。';
    }

    tab.pinned = true;
    touch();
    return null;
  }

  /**
   * 找出同一分類裡已經佔用這個複製鍵的常用語。
   * 範圍限在同一分類：複製鍵只在畫面看得到的卡片上有意義，
   * 全軟體唯一的話鍵很快就不夠分。
   */
  function findHotkeyConflict(categoryId, key, exceptRowId) {
    key = normalizeHotkey(key);
    if (!key) return null;
    var hit = null;
    data.tabs.forEach(function (t) {
      if (t.categoryId !== categoryId || t.type !== 'quickphrase') return;
      (t.rows || []).forEach(function (r) {
        if (hit) return;
        if (r.id === exceptRowId) return;
        if (normalizeHotkey(r.hotkey) === key) hit = { tab: t, row: r };
      });
    });
    return hit;
  }

  /* ---------- 匯出／匯入 ---------- */

  function exportJson() {
    var copy = JSON.parse(JSON.stringify(data));
    copy.savedByDevice = navigator.platform || 'browser';
    return JSON.stringify(copy, null, 2);
  }

  function importJson(text) {
    var parsed = JSON.parse(text);
    var next = migrate(parsed);
    if (!next.categories || !next.categories.length) {
      throw new Error('檔案裡沒有任何分類，可能不是這個工具的資料檔');
    }
    data = next;
    saveNow();
    notify();
    return next;
  }

  /* ---------- 對外 ---------- */

  window.DB = {
    uid: uid,
    nowIso: nowIso,
    load: load,
    saveNow: saveNow,
    touch: touch,
    onChange: onChange,
    raw: function () { return data; },
    categories: categories,
    tabsOf: tabsOf,
    findTab: findTab,
    findCategory: findCategory,
    addCategory: addCategory,
    renameCategory: renameCategory,
    deleteCategory: deleteCategory,
    clearCategory: clearCategory,
    moveCategory: moveCategory,
    moveCategoryEdge: moveCategoryEdge,
    addTab: addTab,
    deleteTab: deleteTab,
    moveTab: moveTab,
    moveRow: moveRow,
    togglePin: togglePin,
    pinnedCount: pinnedCount,
    PIN_LIMIT: PIN_LIMIT,
    normalizeHotkey: normalizeHotkey,
    findHotkeyConflict: findHotkeyConflict,
    exportJson: exportJson,
    importJson: importJson
  };
})();
