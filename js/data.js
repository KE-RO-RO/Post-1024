/* ============================================================
   data.js — 資料模型、分頁暫存讀寫、匯出／匯入
   ------------------------------------------------------------
   刻意不用 ES module（沒有 type="module"），因為這樣直接用檔案
   總管點兩下 index.html 也能開起來測試；ES module 在 file:// 底下
   會被 CORS 擋掉。全部掛在 window.DB 這個命名空間下。

   **資料放在分頁暫存（sessionStorage），不是 localStorage。**
   同一個分頁重新整理資料還在、斷線也在，但**關掉那個分頁（或視窗）就清掉**，
   登出時也會主動清。公用電腦上不會留下東西，而且不必依賴使用者記得登出。
   代價是「不登入就等於空白工具」——真正保存資料的地方是雲端（見 drive.js）。
   ============================================================ */

(function () {
  'use strict';

  var STORAGE_KEY = 'stickyNotes.data.v2';
  var SCHEMA_VERSION = 2;

  /* ---------- 儲存後端 ----------
     只有這裡決定資料放哪一種儲存，其他地方一律走 store()。
     沒有 sessionStorage 的極端情況（很舊的瀏覽器、被政策關掉）退回一個
     記憶體版本：程式照樣跑得完，只是重新整理就沒了——比整個壞掉好。 */

  var memStore = (function () {
    var m = {};
    return {
      get length() { return Object.keys(m).length; },
      key: function (i) { return Object.keys(m)[i]; },
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; }
    };
  }());

  /* 後端**只挑一次**，挑完就記住。
     每次呼叫都重新探測是個陷阱：探測用的寫入在空間滿了的時候也會丟錯，
     於是 store() 會偷偷改回記憶體版本、寫入「成功」，使用者永遠看不到
     「存不進去」那個警告——靜默失敗比報錯更糟（11.44）。
     挑定之後，後來寫不進去就讓錯誤往上丟，由 saveNow 回報。 */
  var chosen = null;
  var degraded = false;

  function store() {
    if (chosen) return chosen;
    try {
      if (window.sessionStorage) {
        // 真的寫得進去才算可用（無痕視窗或政策關掉時會丟錯）
        window.sessionStorage.setItem('stickyNotes.probe', '1');
        window.sessionStorage.removeItem('stickyNotes.probe');
        chosen = window.sessionStorage;
        return chosen;
      }
    } catch (e) { /* 不能用就走記憶體版本 */ }
    degraded = true;
    chosen = memStore;
    return chosen;
  }

  /** 這個瀏覽器根本不讓網頁暫存資料，只剩記憶體可用（重新整理就沒了）。 */
  function memoryOnly() {
    store();
    return degraded;
  }

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
   * 連結正規化：舊資料是單一 `url` 字串，新格式是 `urls` 陣列（一個項目可放多個網址）。
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

    var out = {
      id: l.id || l.Id || uid(),
      name: l.name || l.Name || '',
      urls: urls,
      order: typeof l.order === 'number' ? l.order
           : typeof l.Order === 'number' ? l.Order : j
    };
    /* 勾選狀態（v4.24 起記住）：只記「沒勾」的，預設就是勾選。
       舊資料與新加的連結都沒有這個欄位，所以畫面跟以前一樣是全勾。 */
    if (l.off === true) out.off = true;
    return out;
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

  /* ---------- 色票與主題 ----------
     卡片與分類貼紙共用同一組色票。資料裡存的是色票的「名稱」（'teal'），
     不是色碼——同一個名稱在亮色、暗色主題下對應不同的實際顏色（CSS 變數），
     下一輪做自訂配色時改了某個色，所有用到它的卡片與分類也會一起變。 */

  var PALETTE = [
    { key: 'green', name: '綠' },
    { key: 'teal',  name: '青' },
    { key: 'blue',  name: '霧藍' },
    { key: 'pink',  name: '粉' },
    { key: 'tea',   name: '奶茶褐' },
    // 亮色的這一格是藕荷色（使用者指定，v4.8），暗色仍是可可，所以名稱跟著主題
    { key: 'cocoa', name: '可可', nameLight: '藕荷' }
  ];

  /** 色票在目前主題下的名稱 */
  function paletteName(key, mode) {
    var p = PALETTE.filter(function (x) { return x.key === key; })[0];
    if (!p) return '中性';
    mode = mode || (data.settings && data.settings.theme && data.settings.theme.mode);
    return (mode === 'light' && p.nameLight) || p.name;
  }

  /* 各類型卡片的預設色。沒列的（便籤、私人、表格）預設中性。
     私人卡片刻意不給預設色：專屬顏色等於在畫面上標出「這張比較重要」。
     便籤也中性，讓私人卡片能混在便籤裡（見規格書 10.5）。 */
  var TYPE_COLOR = {
    quickphrase: 'green',
    todo: 'blue',
    countdown: 'pink',
    link: 'tea'
  };

  function isPaletteKey(v) {
    return PALETTE.some(function (p) { return p.key === v; });
  }

  /**
   * 卡片的 color 有三種狀態：
   *   null   → 跟隨類型（預設）
   *   'none' → 使用者主動選了中性
   *   色票名 → 使用者自選
   * 分類貼紙只有兩種：null（中性）或色票名。
   */
  function normalizeTabColor(v) {
    if (v === 'none') return 'none';
    return isPaletteKey(v) ? v : null;
  }

  /* 自訂配色能改的項目與型別。只有列在這裡的鍵會被保留。
     這些值最後會被寫進一段 <style>，所以格式一定要驗得很嚴——
     匯入檔若被動過手腳，一個 'red;} body{display:none' 就能把畫面弄壞。 */
  var CUSTOM_TYPES = {
    bg: 'color', panel: 'color', text: 'color', accent: 'color',
    'c-green': 'color', 'c-teal': 'color', 'c-blue': 'color',
    'c-pink': 'color', 'c-tea': 'color', 'c-cocoa': 'color',
    catOnNeutral: 'colorAlpha',
    tintCat: 'num', tintCatOn: 'num',
    tintBadgeLine: 'num', tintHeadFull: 'num', tintBadgeFull: 'num',
    border: 'colorAlpha', danger: 'color', warn: 'color', accentMark: 'colorAlpha'
  };

  function cleanHex(v) {
    return (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) ? v.toLowerCase() : null;
  }

  function cleanNum(v) {
    var n = Number(v);
    if (!isFinite(n)) return null;
    return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
  }

  function cleanCustomValue(key, v) {
    var t = CUSTOM_TYPES[key];
    if (t === 'color') return cleanHex(v);
    if (t === 'num') return cleanNum(v);
    if (t === 'colorAlpha') {
      if (!v || typeof v !== 'object') return null;
      var c = cleanHex(v.c), a = cleanNum(v.a);
      return (c && a !== null) ? { c: c, a: a } : null;
    }
    return null;
  }

  function normalizeCustom(src) {
    var out = {};
    if (!src || typeof src !== 'object') return out;
    Object.keys(CUSTOM_TYPES).forEach(function (k) {
      var v = cleanCustomValue(k, src[k]);
      if (v !== null) out[k] = v;
    });
    return out;
  }

  /* ---------- 配色套組（v4.8）----------
     三格，每格記住「整個外觀」：亮或暗、細線或滿版、那個主題的自訂顏色。
     名稱只會用 textContent 顯示，不會被當成 HTML，這裡只限長度。 */
  var SLOT_COUNT = 3;

  function normalizeSlot(s) {
    if (!s || typeof s !== 'object') return null;
    return {
      name: String(s.name || '').trim().slice(0, 12),
      mode: s.mode === 'light' ? 'light' : 'dark',
      cardStyle: s.cardStyle === 'full' ? 'full' : 'line',
      custom: normalizeCustom(s.custom)
    };
  }

  function normalizeSlots(list) {
    var out = [];
    for (var i = 0; i < SLOT_COUNT; i++) out.push(normalizeSlot(Array.isArray(list) ? list[i] : null));
    return out;
  }

  /* 顯示大小。固定級距，不做無段調整——無段會讓人調出 103% 這種看不出
     差別的值。這個數字會被寫進 style 屬性，所以只接受名單裡的值。 */
  var ZOOM_STEPS = [0.8, 0.9, 1, 1.05, 1.1, 1.25, 1.5];

  function normalizeZoom(v) {
    v = Number(v);
    return ZOOM_STEPS.indexOf(v) >= 0 ? v : 1;
  }

  function uiZoom() {
    return normalizeZoom(data.settings && data.settings.uiZoom);
  }

  function setUiZoom(v) {
    var next = normalizeZoom(v);
    if (uiZoom() === next) return;
    data.settings.uiZoom = next;
    touch();
  }

  var PIP_DEFAULT = { w: 420, h: 520 };

  /* 置頂小視窗的大小。跟顏色一樣，這個值會被交給瀏覽器 API，
     所以資料檔被動過手腳時不能照單全收：只接受數字並夾在合理範圍內。 */
  function normalizePipSize(p) {
    p = p || {};
    function clamp(v, min, max, dflt) {
      v = Number(v);
      if (!isFinite(v)) return dflt;
      return Math.min(max, Math.max(min, Math.round(v)));
    }
    return {
      w: clamp(p.w, 280, 1600, PIP_DEFAULT.w),
      h: clamp(p.h, 220, 1200, PIP_DEFAULT.h)
    };
  }

  /* 「＋ 新增卡片」那個彈窗裡的類型順序（v4.23）。
     程式認得的類型與出廠順序寫在這裡；使用者拖出來的順序存在
     settings.typeOrder，跟著匯出匯入與雲端同步走。

     這個陣列決定畫面上出現哪幾格，所以驗證要嚴（3.2 的通則）：
     不認得的名字丟掉、重複的丟掉；程式認得但清單裡沒有的補在最後面——
     之後新增卡片類型時，舊的資料檔不會讓它消失。
     沒排過就是 null，畫面用出廠順序。 */
  var CARD_TYPES = ['quickphrase', 'note', 'todo', 'countdown', 'link',
                    'private', 'codegen', 'form', 'table'];

  function normalizeTypeOrder(v) {
    if (!Array.isArray(v)) return null;
    var out = [];
    v.forEach(function (t) {
      if (typeof t === 'string' && CARD_TYPES.indexOf(t) >= 0 && out.indexOf(t) < 0) out.push(t);
    });
    if (!out.length) return null;
    CARD_TYPES.forEach(function (t) { if (out.indexOf(t) < 0) out.push(t); });
    return out;
  }

  function typeOrder() {
    return normalizeTypeOrder(data.settings && data.settings.typeOrder) || CARD_TYPES.slice();
  }

  /** 把 from 這個類型移到 to 的位置（同便籤、連結的拖曳排序：插在目標前面或後面由方向決定） */
  function moveType(from, to) {
    if (from === to) return false;
    var list = typeOrder();
    var a = list.indexOf(from), b = list.indexOf(to);
    if (a < 0 || b < 0) return false;
    list.splice(a, 1);
    list.splice(b, 0, from);
    data.settings.typeOrder = list;
    touch();
    return true;
  }

  function normalizeSettings(s) {
    s = s || {};
    var th = s.theme || {};
    var out = {
      autoLockEnabled: !!s.autoLockEnabled,
      autoLockMinutes: s.autoLockMinutes || 30,
      popupHintShown: !!s.popupHintShown,
      pipSize: normalizePipSize(s.pipSize),
      uiZoom: normalizeZoom(s.uiZoom),
      typeOrder: normalizeTypeOrder(s.typeOrder),
      theme: {
        // 預設亮色＋細線版。寫成「不是 dark 就當 light」，所以只有資料裡
        // 明確存著 dark 的才是暗色；既有使用者存過的設定不會被覆蓋。
        mode: th.mode === 'dark' ? 'dark' : 'light',
        cardStyle: th.cardStyle === 'full' ? 'full' : 'line',
        // 亮暗各存一份，只記使用者改過的項目；沒改的就是樣式表裡的預設
        custom: {
          dark: normalizeCustom(th.custom && th.custom.dark),
          light: normalizeCustom(th.custom && th.custom.light)
        },
        slots: normalizeSlots(th.slots),
        activeSlot: null
      }
    };
    // 使用中的套組必須真的存在
    var a = th.activeSlot;
    if (typeof a === 'number' && a >= 0 && a < SLOT_COUNT && out.theme.slots[a]) out.theme.activeSlot = a;
    return out;
  }

  /** 卡片實際要顯示的色票名，中性回傳 null。 */
  function tabColor(tab) {
    if (!tab || tab.color === 'none') return null;
    return tab.color || TYPE_COLOR[tab.type] || null;
  }

  /* ---------- 預設資料 ---------- */

  function emptyData() {
    var catId = uid();
    return {
      version: SCHEMA_VERSION,
      updatedAt: nowIso(),
      appTitle: '便籤／常用語',
      // 鎖定預設不啟用；彈出視窗說明只跳一次；主題預設亮色＋細線版
      settings: normalizeSettings(null),
      categories: [
        { id: catId, name: '常用語', shortLabel: '語', order: 0, color: null }
      ],
      tabs: [
        {
          id: uid(),
          categoryId: catId,
          type: 'quickphrase',
          title: '未命名',
          order: 0,
          pinned: false,
          collapsed: false,
          color: null,
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
      collapsed: false,
      color: null,          // 跟隨類型；使用者自選後才會有值
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    if (type === 'note') base.items = [];
    if (type === 'quickphrase') base.rows = [];
    if (type === 'todo') base.items = [];
    if (type === 'codegen') {
      base.labels = defaultGenLabels();
      base.g1 = [];
      base.g2 = [];
    }
    if (type === 'form') {
      base.labels = defaultFormLabels();
      base.tplTwo = '';
      base.tplOne = '';
      base.cats = [];       // 雙向那份
      base.catsOne = [];    // 單向那份，跟雙向完全分開
      base.notes = [];
      base.notesFold = false;   // 附註那排收起來沒有。出廠展開
    }
    if (type === 'link') base.links = [];
    if (type === 'countdown') base.items = [];
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

  /* ============================================================
     便籤：一張卡片放多筆
     ------------------------------------------------------------
     以前一張便籤卡只有一段文字，要記三件事就得開三張卡，畫面很快就堆滿。
     改成一串項目之後每筆可以各自摺疊，卡片高度不會被最長的那一段撐開。

     刻意不做標題欄位：便籤是隨手記的東西，強迫取名很煩。摺疊時顯示內容的
     第一行就夠認了。

     `open` 存進資料檔（跟著匯出匯入走）。私人卡片刻意不記展開狀態是安全
     理由——每次解鎖都要從乾淨狀態開始；便籤沒有那個顧慮，每次打開都要重新
     展開反而煩。
     ============================================================ */

  function normalizeNoteItems(list, legacyContent) {
    if (Array.isArray(list)) {
      return list.map(function (x, j) {
        x = x || {};
        var out = {
          id: x.id || uid(),
          // 沒有 kind 的舊資料一律是自由格式，畫面完全不變
          kind: x.kind === 'form' ? 'form' : 'free',
          content: typeof x.content === 'string' ? x.content : '',
          open: x.open !== false,
          order: typeof x.order === 'number' ? x.order : j
        };
        if (out.kind === 'form') {
          out.title = typeof x.title === 'string' ? x.title : '';
          out.fields = normalizeNoteFields(x.fields);
        }
        return out;
      });
    }
    // 舊卡片：整段內容轉成第一筆，一個字都不掉
    if (legacyContent) {
      return [{ id: uid(), kind: 'free', content: legacyContent, open: true, order: 0 }];
    }
    return [];
  }

  /* ============================================================
     便籤的「欄位」型別（v4.23）
     ------------------------------------------------------------
     一筆 = 標題行（可留空）＋一排「欄位名：值」。
     存進資料檔的只有欄位名與預設值（使用者的設定），
     **填進去的值不存**，只放在 tabs.js 的記憶體裡（同編碼卡、表單卡）。

     欄位名一律是使用者的資料，程式碼裡不寫任何一個實際的欄位名（4.4）。
     ============================================================ */

  function normalizeNoteFields(arr) {
    if (!Array.isArray(arr)) return [];
    var seen = {};
    var out = [];
    arr.forEach(function (f) {
      if (!f || typeof f.label !== 'string') return;
      var label = f.label.trim();
      if (!label) return;
      var id = typeof f.id === 'string' && f.id && !seen[f.id] ? f.id : uid();
      seen[id] = true;
      out.push({ id: id, label: label, def: typeof f.def === 'string' ? f.def : '' });
    });
    return out;
  }

  /** 欄位名與預設值之間的分隔：全形或半形冒號，取第一個 */
  var NOTE_FIELD_SEP = /[：:]/;

  /**
   * 把設定框裡的字（一行一欄，「欄位名：預設值」）轉成欄位陣列。
   * 空白行忽略。欄位名相同的沿用舊的 id，已經填進去的值才不會因為
   * 改了別一行就整個清掉。
   */
  function noteFieldsParse(text, oldFields) {
    var pool = (oldFields || []).slice();
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return;
      var m = NOTE_FIELD_SEP.exec(line);
      var label = (m ? line.slice(0, m.index) : line).trim();
      var def = m ? line.slice(m.index + 1).trim() : '';
      if (!label) return;
      var k = pool.findIndex(function (f) { return f.label === label; });
      var id = k >= 0 ? pool.splice(k, 1)[0].id : uid();
      out.push({ id: id, label: label, def: def });
    });
    return out;
  }

  /** noteFieldsParse 的反方向：填回設定框用 */
  function noteFieldsText(fields) {
    return (fields || []).map(function (f) {
      return f.def ? f.label + '：' + f.def : f.label;
    }).join('\n');
  }

  /**
   * 複製出來的字：每一欄「欄位名：值」（v4.25 起不含標題行），
   * **空的欄位也印**，整張的形狀完整保留。
   * @param {object} item   便籤的一筆（kind === 'form'）
   * @param {function} valueOf 欄位 → 目前的值
   */
  function noteFormText(item, valueOf) {
    // v4.25：標題不複製（使用者要的），只複製欄位
    var lines = [];
    (item.fields || []).forEach(function (f) {
      var v = valueOf ? valueOf(f) : f.def;
      lines.push(f.label + '：' + (v == null ? '' : String(v)));
    });
    return lines.join('\n');
  }

  /** 便籤項目的拖曳排序。跟常用語的 moveRow 分開，兩者的清單不同。 */
  function moveNoteItem(tabId, fromId, toId) { moveItem(tabId, fromId, toId); }

  /**
   * `tab.items` 的拖曳排序：便籤、待辦、倒數共用（v4.24）。
   * 把 from 搬到 to 的位置，整份重排 order。
   * 倒數的畫面仍然先依日期分組、同一天依時間排，order 只決定「同一組、
   * 同一個時間」之間的先後，所以畫面那一層只准在同一組內拖。
   */
  function moveItem(tabId, fromId, toId) {
    var tab = findTab(tabId);
    if (!tab || ['note', 'todo', 'countdown'].indexOf(tab.type) < 0 || fromId === toId) return;

    var list = (tab.items || []).slice().sort(function (a, b) { return a.order - b.order; });
    var from = list.findIndex(function (x) { return x.id === fromId; });
    var to = list.findIndex(function (x) { return x.id === toId; });
    if (from < 0 || to < 0) return;

    var moved = list.splice(from, 1)[0];
    list.splice(to, 0, moved);
    list.forEach(function (x, i) { x.order = i; });
    tab.items = list;
    tab.updatedAt = nowIso();
    touch();
  }

  /** 連結項目的拖曳排序。跟便籤、常用語各自一套，因為清單不同。 */
  function moveLink(tabId, fromId, toId) {
    var tab = findTab(tabId);
    if (!tab || tab.type !== 'link' || fromId === toId) return;

    var list = (tab.links || []).slice().sort(function (a, b) { return a.order - b.order; });
    var from = list.findIndex(function (x) { return x.id === fromId; });
    var to = list.findIndex(function (x) { return x.id === toId; });
    if (from < 0 || to < 0) return;

    var moved = list.splice(from, 1)[0];
    list.splice(to, 0, moved);
    list.forEach(function (x, i) { x.order = i; });
    tab.links = list;
    tab.updatedAt = nowIso();
    touch();
  }

  /* ============================================================
     倒數提醒：每一筆各自有日期與（選填的）時間
     ------------------------------------------------------------
     v4.10 之前是「卡片一個日期 + 一串沒有日期的子任務」，一張卡片只能倒數
     一件事。現在日期搬到每一筆身上，同一天的多件事與不同天的事可以放在
     同一張卡片裡。

     舊資料由 normalizeDueItems() 一次搬完：卡片原本的 dueDate 套到所有還沒有
     自己日期的子任務上，之後卡片層級就不再有日期。有日期卻一個子任務都沒有的
     舊卡片，那個日期無處可去——不會憑空生一筆任務出來。
     ============================================================ */

  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  /* 光比對格式不夠：`2026-13-99` 完全符合 `\d{4}-\d{2}-\d{2}`，
     卻是一個不存在的日期，放進 new Date() 會變成 Invalid Date 或被自動進位到
     別的月份。所以再組回去比對一次，只有原樣吻合的才算數。 */
  function normalizeDue(v) {
    v = String(v || '').slice(0, 10);
    if (!DATE_RE.test(v)) return '';
    var d = new Date(v + 'T00:00:00');
    if (isNaN(d.getTime())) return '';
    var back = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    return back === v ? v : '';
  }

  function normalizeTime(v) {
    v = String(v || '').slice(0, 5);
    return TIME_RE.test(v) ? v : '';
  }

  function normalizeDueItems(list, legacyDate) {
    var fallback = normalizeDue(legacyDate);
    return (Array.isArray(list) ? list : []).map(function (x, j) {
      x = x || {};
      var due = normalizeDue(x.due);
      return {
        id: x.id || uid(),
        text: x.text || '',
        done: !!x.done,
        // 沒有自己的日期就沿用卡片原本的那個（只會在第一次載入舊資料時發生）
        due: due || fallback,
        time: normalizeTime(x.time),
        order: typeof x.order === 'number' ? x.order : j
      };
    });
  }

  /** 這一筆什麼時候算過期。沒設時間就是那一天結束（隔天零點）。 */
  function dueMoment(item) {
    if (!item || !item.due) return null;
    if (item.time) return new Date(item.due + 'T' + item.time + ':00');
    var d = new Date(item.due + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return d;
  }

  /**
   * 一筆任務目前的狀態。畫面與側欄記號都讀這裡，只有一份判斷邏輯。
   * @returns {Object} { has, diffDays, overdue, today, soon, at }
   */
  function dueInfo(item, now) {
    now = now || new Date();
    if (!item || !item.due) {
      return { has: false, diffDays: null, overdue: false, today: false, soon: false, at: null };
    }
    var today = new Date(now.getTime());
    today.setHours(0, 0, 0, 0);
    var day = new Date(item.due + 'T00:00:00');
    var diff = Math.round((day - today) / 86400000);
    var at = dueMoment(item);
    return {
      has: true,
      diffDays: diff,
      overdue: now >= at,
      today: diff === 0,
      soon: diff > 0 && diff <= 3,
      at: at
    };
  }

  /** 某個分類裡有沒有「今天到期或已過期」的未完成任務——側欄小紅點用。 */
  function categoryHasDue(categoryId, now) {
    now = now || new Date();
    return data.tabs.some(function (t) {
      return t.categoryId === categoryId && tabHasDue(t, now);
    });
  }

  /**
   * 單張卡片有沒有今天到期或已過期的未完成任務。
   * 分類的小紅點與「收合的倒數卡片」用的是同一套判斷——收起來之後看不到
   * 裡面的日期，提醒不能跟著消失。
   */
  function tabHasDue(tab, now) {
    if (!tab || tab.type !== 'countdown') return false;
    now = now || new Date();
    return (tab.items || []).some(function (i) {
      if (i.done) return false;
      var d = dueInfo(i, now);
      return d.has && (d.overdue || d.today);
    });
  }

  /**
   * 下一次畫面真的會有變化的時刻。
   *
   * 刻意不做「每分鐘檢查一次」：沒有倒數卡片時那個迴圈永遠不會有結果，卻會
   * 一直把 CPU 叫醒、妨礙筆電進入省電狀態。改成算出確切時刻只排一個計時器，
   * 沒有倒數卡片時連一個都不排。
   *
   * 會造成變化的只有兩種時刻：某一筆到期的那一刻，以及午夜（天數會少一天，
   * 「今天」與三天內的判斷也跟著換）。
   *
   * @returns {Date|null} null = 沒有任何東西需要等
   */
  function nextDueChange(now) {
    now = now || new Date();
    var any = false;
    var best = null;

    data.tabs.forEach(function (t) {
      if (t.type !== 'countdown') return;
      (t.items || []).forEach(function (i) {
        if (!i.due) return;
        any = true;
        if (i.done) return;
        var at = dueMoment(i);
        if (at > now && (!best || at < best)) best = at;
      });
    });

    if (!any) return null;

    var midnight = new Date(now.getTime());
    midnight.setHours(24, 0, 0, 0);
    return (!best || midnight < best) ? midnight : best;
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
   * 標記資料已變更：更新時間戳、通知畫面重繪、延遲寫入分頁暫存。
   * 延遲 1 秒是為了避免打字時每按一個鍵就寫一次硬碟。
   */
  /* 「資料變了」的通知，不管要不要重畫都會發。雲端同步掛在這裡。
     以前同步只掛在 onChange 上，而 touch(true)（就地編輯文字、改標題、
     記住高度這些不重畫的變更）不會發 onChange——那些修改就一直沒排上傳，
     關掉分頁時也不算「有沒上傳的變更」（v4.24 修正）。 */
  var dirtyListeners = [];
  function onDirty(fn) { dirtyListeners.push(fn); }

  function touch(skipRender) {
    data.updatedAt = nowIso();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 1000);
    for (var i = 0; i < dirtyListeners.length; i++) dirtyListeners[i]();
    if (!skipRender) notify();
  }

  /* 寫入失敗的通知。以前只在主控台印一行，畫面毫無反應——
     使用者會以為存好了，其實那次的變更沒有落盤，重新整理就沒了。
     由 app.js 掛上處理函式，這一層只負責回報。 */
  var saveErrorFn = null;
  var saveFailed = false;

  function onSaveError(fn) { saveErrorFn = fn; }

  function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
      store().setItem(STORAGE_KEY, JSON.stringify(data));
      saveFailed = false;
    } catch (e) {
      console.error('寫入分頁暫存失敗', e);
      // 每秒都會再試一次，所以只在「從成功變成失敗」的那一刻講一次
      if (!saveFailed) {
        saveFailed = true;
        if (saveErrorFn) {
          try { saveErrorFn(e); } catch (err) { console.error(err); }
        }
      }
    }
  }

  /* 舊版（v4.21 以前）把資料放在 localStorage。第一次跑新版時搬進分頁暫存，
     然後**把 localStorage 那把鍵刪掉**——不搬的話使用者會以為資料不見了，
     不刪的話公用電腦上就還留著一份。搬過一次就永遠不會再遇到。 */
  var legacyMoved = false;

  function legacyMigrated() { return legacyMoved; }

  /**
   * 這個分頁是不是「空白工具」的狀態（剛開、登出清過、還沒同步下來）。
   * 同步的決策表用它判斷「本機空的就直接把雲端拉下來」，所以判斷要保守：
   * 只要有任何內容或保留區的東西就不算空。
   */
  function isEmpty() {
    if ((data.trash || []).length) return false;
    var tabs = data.tabs || [];
    if (tabs.length > 1) return false;
    if (!tabs.length) return true;
    var t = tabs[0];
    if (t.type !== 'quickphrase') return false;
    if ((t.rows || []).length) return false;
    return !t.title || t.title === '未命名';
  }

  function takeLegacy() {
    var raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        localStorage.removeItem(STORAGE_KEY);
        legacyMoved = true;
      }
      // 舊版的同步狀態也一起清掉（新版放在分頁暫存，見 drive.js）
      localStorage.removeItem('stickyNotes.drive.v1');
    } catch (e) { /* 讀不到或刪不掉都不影響下面的流程 */ }
    return raw;
  }

  function load() {
    try {
      var raw = store().getItem(STORAGE_KEY);
      // 這個分頁還沒有資料時，才看看 localStorage 有沒有舊版留下來的
      if (!raw) raw = takeLegacy();
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.categories) {
          data = migrate(parsed);
          // 過期的保留區項目在載入時順手清掉，不排計時器
          purgeTrash();
          if (legacyMoved) saveNow();   // 搬進來的資料要真的落在分頁暫存裡
          return;
        }
      }
    } catch (e) {
      console.error('讀取分頁暫存失敗，改用空白資料', e);
    }
    data = emptyData();
    saveNow();
  }

  /**
   * 清掉這個分頁的資料，回到空白（登出時用）。
   * 分頁暫存本來關掉分頁就會消失，這裡是「不等關分頁，現在就清」。
   */
  function wipeLocal() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { store().removeItem(STORAGE_KEY); } catch (e) { /* 清不掉也要繼續 */ }
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 舊鍵保險再刪一次 */ }
    data = emptyData();
    saveFailed = false;
    notify();
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
      settings: normalizeSettings(src.settings),
      categories: [],
      tabs: [],
      trash: normalizeTrash(src.trash)
    };

    // 保管層原樣搬過去。裡面只有加密後的金鑰包裹，沒有任何明文
    if (src.vault && src.vault.pwd && src.vault.rec) out.vault = src.vault;

    (src.categories || []).forEach(function (c, i) {
      out.categories.push({
        id: c.id || uid(),
        name: c.name || '未命名',
        shortLabel: c.shortLabel || firstChar(c.name),
        order: typeof c.order === 'number' ? c.order : i,
        color: isPaletteKey(c.color) ? c.color : null
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
      settings: normalizeSettings(null),
      categories: [],
      tabs: []
    };

    (src.Categories || []).forEach(function (c, i) {
      out.categories.push({
        id: c.Id || uid(),
        name: c.Name || '未命名',
        shortLabel: c.ShortLabel || firstChar(c.Name),
        order: typeof c.Order === 'number' ? c.Order : i,
        color: null
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
        collapsed: false,
        color: null,
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
        tab.items = normalizeNoteItems(null, t.Content || '');
      } else if (tab.type === 'todo') {
        tab.items = (t.Items || []).map(function (x, j) {
          return { id: x.Id || uid(), text: x.Text || '', done: !!x.Done, order: j };
        });
      } else if (tab.type === 'link') {
        tab.links = (t.Links || []).map(normalizeLink);
      } else if (tab.type === 'countdown') {
        tab.items = normalizeDueItems((t.Items || []).map(function (x, j) {
          return { id: x.Id || uid(), text: x.Text || '', done: !!x.Done, order: j };
        }), (t.DueDate || '').slice(0, 10));
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

  /* ============================================================
     編碼卡（codegen）
     ------------------------------------------------------------
     這裡只有機制，沒有任何內容：選項名稱、文案、欄位標籤全部是使用者
     自己建的資料。程式碼裡看得到的只有「產生隨機碼」「取字串尾段」
     「代入模板」這幾件事，看不出用途（見 README 的說明）。

     模板裡認得三種記號：
       【代碼】 換成這一次的隨機碼
       【方式】 換成第二組選到的那個選項名稱
       〔…〕   可省略的段落。選到「不需要來源字串」的選項時整段刪掉，
                否則只把括號去掉。這樣「沒有來源時要刪哪一段」由使用者
                自己決定，不必把任何句子寫死在程式碼裡。
     ============================================================ */

  var GEN_CODE_TOKEN = '【代碼】';
  var GEN_WAY_TOKEN = '【方式】';

  var GEN_LABEL_DEFAULTS = {
    fill: '填寫',
    out: '產出',
    g1: '項目',
    g2: '方式',
    src: '貼上完整資訊',
    srcHint: '貼上完整資訊',
    result: '結果'
  };

  /* srcHint（輸入欄裡的淡字）刻意不進資料檔：它沒有編輯介面，
     存進去只會讓建立卡片當下的那句話永遠留在使用者的檔案裡，
     之後改了程式也換不掉。改成每次都從這裡拿。 */
  var GEN_LABEL_KEYS = Object.keys(GEN_LABEL_DEFAULTS).filter(function (k) {
    return k !== 'srcHint';
  });

  function defaultGenLabels() {
    var o = {};
    GEN_LABEL_KEYS.forEach(function (k) {
      o[k] = GEN_LABEL_DEFAULTS[k];
    });
    return o;
  }

  /** 某個標籤的出廠文字。使用者把名稱清空時回到這個值——
      預設字都是中性的，久沒用時可以靠它認出這一欄原本是幹嘛的。 */
  function genLabelDefault(k) {
    return GEN_LABEL_DEFAULTS[k] || '';
  }

  /** 標籤只接受字串，不認得的鍵一律丟掉（資料檔可能被動過手腳）。 */
  function normalizeGenLabels(src) {
    var o = defaultGenLabels();
    if (!src || typeof src !== 'object') return o;
    GEN_LABEL_KEYS.forEach(function (k) {
      if (typeof src[k] === 'string' && src[k].trim()) o[k] = src[k].trim();
    });
    return o;
  }

  function normalizeGenG1(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(function (x) {
      x = x || {};
      return {
        id: x.id || uid(),
        name: String(x.name || '').trim() || '未命名',
        tpl: typeof x.tpl === 'string' ? x.tpl : ''
      };
    });
  }

  function normalizeGenG2(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(function (x) {
      x = x || {};
      return {
        id: x.id || uid(),
        name: String(x.name || '').trim() || '未命名',
        // 這個選項不需要來源字串，此時隨機碼改長版
        noSrc: !!x.noSrc,
        // 取到的尾段全是英文字母時，把隨機碼最後一碼換成數字
        needDigit: !!x.needDigit
      };
    });
  }

  var GEN_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var GEN_LOWER = 'abcdefghijklmnopqrstuvwxyz';
  var GEN_DIGIT = '0123456789';

  function pick(set) {
    return set.charAt(Math.floor(Math.random() * set.length));
  }

  /**
   * 隨機碼：兩個大寫加兩個小寫。
   * 不需要來源字串時再接八位數字，因為那時候這串就是最終結果。
   */
  function genRandomCode(long) {
    var s = pick(GEN_UPPER) + pick(GEN_UPPER) + pick(GEN_LOWER) + pick(GEN_LOWER);
    if (long) {
      for (var i = 0; i < 8; i++) s += pick(GEN_DIGIT);
    }
    return s;
  }

  /** 把最後一碼換成數字。長度不變，這是使用者選的做法（不是接在後面）。 */
  function genApplyDigit(code) {
    if (!code) return code;
    return code.slice(0, -1) + pick(GEN_DIGIT);
  }

  /** 取尾段。貼進來的通常是一整串，只取尾巴。 */
  function genLast8(raw) {
    return String(raw || '').trim().slice(-8);
  }

  /** 尾段湊滿而且全是英文字母時，結果裡一個數字都沒有。 */
  function genAllLetters(last8) {
    return last8.length === 8 && /^[A-Za-z]+$/.test(last8);
  }

  /**
   * 把模板代成最後的文案。
   * @param {string} tpl 使用者自己填的模板
   * @param {string} wayName 第二組選到的選項名稱
   * @param {string} code 這一次的隨機碼
   * @param {boolean} dropOptional 〔…〕的段落要不要整段刪掉
   */
  function genBuildText(tpl, wayName, code, dropOptional) {
    var s = String(tpl || '');
    s = dropOptional
      ? s.replace(/〔[^〕]*〕/g, '')
      : s.replace(/[〔〕]/g, '');
    return s.split(GEN_WAY_TOKEN).join(wayName || '')
            .split(GEN_CODE_TOKEN).join(code || '');
  }

  /** 輸入欄的標籤也是樣板，跟著選到的方式變。 */
  function genSrcLabel(label, wayName) {
    return String(label || '').split(GEN_WAY_TOKEN).join(wayName || '');
  }

  /* ============================================================
     表單卡（form）
     ------------------------------------------------------------
     跟編碼卡同一個想法：規則在程式裡，名詞全部是資料。

     兩個模式各寫一整份模板，也各有一份自己的選項清單（cats／catsOne），
     連那一排的標籤字都各自一份——改一邊不會動到另一邊。

     雙向的記號：【來源】【對象A】【對象B】【類別A】【類別B】【數值】，
     【類別A】【類別B】代入那個選項的前段與後段顯示字（留空用名稱）。
     單向的記號：【來源】【對象】【類別】【數值】【附註】，
     單向只有一段，所以顯示字也只有一格（留空用名稱）。
     ============================================================ */

  /* 單向模式的記號 */
  var FORM_TOKENS = {
    src: '【來源】',
    obj: '【對象】',
    cat: '【類別】',
    amount: '【數值】',
    note: '【附註】'
  };

  /* 雙向模式的記號。兩段的對象與類別各有自己的記號，所以使用者是把
     「最後長什麼樣」整個寫出來，而不是寫一段讓程式跑兩次——
     跑兩次那個模型是實作者的結構，不是使用者的（第一版就是這樣錯的）。 */
  var FORM_TOKENS_TWO = {
    src: '【來源】',
    objA: '【對象A】',
    objB: '【對象B】',
    catA: '【類別A】',
    catB: '【類別B】',
    amount: '【數值】'
  };

  var FORM_LABEL_DEFAULTS = {
    fill: '模式',
    out: '產出',
    mode1: '雙向',
    mode2: '單向',
    src: '來源',
    a: '對象 A',
    b: '對象 B',
    one: '對象',
    amount: '數值',
    cats: '類別',
    // 兩個模式各有自己的清單，標籤字也各自一份（改一邊不動另一邊）。
    // 出廠預設同一個中性字，所以剛拆開時看起來跟以前一樣
    catsOne: '類別',
    notes: '附註'
  };

  function defaultFormLabels() {
    var o = {};
    Object.keys(FORM_LABEL_DEFAULTS).forEach(function (k) {
      o[k] = FORM_LABEL_DEFAULTS[k];
    });
    return o;
  }

  function formLabelDefault(k) {
    return FORM_LABEL_DEFAULTS[k] || '';
  }

  function normalizeFormLabels(src) {
    var o = defaultFormLabels();
    if (!src || typeof src !== 'object') return o;
    Object.keys(FORM_LABEL_DEFAULTS).forEach(function (k) {
      if (typeof src[k] === 'string' && src[k].trim()) o[k] = src[k].trim();
    });
    return o;
  }

  function normalizeFormCats(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(function (x) {
      x = x || {};
      return {
        id: x.id || uid(),
        name: String(x.name || '').trim() || '未命名',
        // 前段與後段可以顯示成不同的字；留空就用名稱
        pre: typeof x.pre === 'string' ? x.pre : '',
        post: typeof x.post === 'string' ? x.post : '',
        // 選到這個類別時接在最後的一句話，不填就沒有
        extra: typeof x.extra === 'string' ? x.extra : ''
      };
    });
  }

  /**
   * 單向模式的選項清單。只有一段，所以顯示字只有一格。
   * 跟雙向那份完全獨立：改一邊不會動到另一邊。
   */
  function normalizeFormCatsOne(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(function (x) {
      x = x || {};
      return {
        id: x.id || uid(),
        name: String(x.name || '').trim() || '未命名',
        // 產出時代進【類別】的字；留空就用名稱
        show: typeof x.show === 'string' ? x.show : '',
        extra: typeof x.extra === 'string' ? x.extra : ''
      };
    });
  }

  /**
   * 舊資料只有一份清單（兩個模式共用）。拆成兩份時複製一份當單向的起點，
   * 顯示字留空——留空就是用名稱，跟拆開前單向的產出一模一樣。
   */
  function formCatsOneFrom(cats) {
    return (cats || []).map(function (c) {
      return { id: uid(), name: c.name, show: '', extra: c.extra || '' };
    });
  }

  function normalizeFormNotes(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(function (x) {
      x = x || {};
      return {
        id: x.id || uid(),
        name: String(x.name || '').trim() || '未命名',
        // 實際代進【附註】的字；留空就用名稱本身
        text: typeof x.text === 'string' ? x.text : ''
      };
    });
  }

  /**
   * 雙向的模板。舊版分成「開頭」與「每段」兩欄（每段會跑兩次），
   * 那個模型換掉了；舊資料把兩欄接起來當成雙向模板的起點，
   * 使用者只要把裡面的記號改成 A／B 版就好，不必整個重打。
   */
  function normalizeFormTpl(tplTwo, head, seg) {
    if (typeof tplTwo === 'string') return tplTwo;
    var parts = [];
    if (typeof head === 'string' && head.trim()) parts.push(head);
    if (typeof seg === 'string' && seg.trim()) parts.push(seg);
    return parts.join('\n');
  }

  function formRender(tokens, tpl, vals) {
    var s = String(tpl || '');
    Object.keys(tokens).forEach(function (k) {
      s = s.split(tokens[k]).join(vals[k] == null ? '' : vals[k]);
    });
    return s;
  }

  /** 模板裡實際用到哪些記號。用來決定哪些欄位是必填的。 */
  function formUsedTokens(tab, two) {
    var tpl = String((two ? tab.tplTwo : tab.tplOne) || '');
    var tokens = two ? FORM_TOKENS_TWO : FORM_TOKENS;
    var out = {};
    Object.keys(tokens).forEach(function (k) {
      if (tpl.indexOf(tokens[k]) >= 0) out[k] = true;
    });
    return out;
  }

  /**
   * 組出最後要複製的整段文字。
   * @param {object} tab 卡片
   * @param {object} v { two, src, a, b, one, amount, note, catId }
   * @returns {string} 沒辦法組出來時回空字串
   */
  function formBuildText(tab, v) {
    // 兩個模式各看各的清單
    var list = (v.two ? tab.cats : tab.catsOne) || [];
    var cat = list.filter(function (c) { return c.id === v.catId; })[0];
    if (!cat) return '';

    var tpl = v.two ? tab.tplTwo : tab.tplOne;
    if (!String(tpl || '').trim()) return '';

    var text = v.two
      ? formRender(FORM_TOKENS_TWO, tpl, {
          src: v.src, objA: v.a, objB: v.b,
          catA: cat.pre || cat.name, catB: cat.post || cat.name,
          amount: v.amount
        })
      : formRender(FORM_TOKENS, tpl, {
          src: v.src, obj: v.one, cat: cat.show || cat.name,
          amount: v.amount, note: v.note
        });

    // 附加句接在最後，兩種模式都適用
    if (cat.extra && cat.extra.trim()) text += '\n' + cat.extra;
    return text;
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
      // 收合是版面偏好，跟著資料檔走（換電腦、匯入之後仍然收著）
      collapsed: !!t.collapsed,
      color: normalizeTabColor(t.color),
      createdAt: t.createdAt || nowIso(),
      updatedAt: t.updatedAt || nowIso()
    };
    if (tab.type === 'note') {
      tab.items = normalizeNoteItems(t.items, t.content);
      // 版面偏好，跟著資料走。整張卡片共用一個高度，不是每一筆各記一份
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
    if (tab.type === 'countdown') tab.items = normalizeDueItems(t.items, t.dueDate);
    if (tab.type === 'table') { tab.columns = t.columns || []; tab.rows = t.rows || []; }
    if (tab.type === 'codegen') {
      tab.labels = normalizeGenLabels(t.labels);
      tab.g1 = normalizeGenG1(t.g1);
      tab.g2 = normalizeGenG2(t.g2);
    }
    if (tab.type === 'form') {
      tab.labels = normalizeFormLabels(t.labels);
      tab.tplTwo = normalizeFormTpl(t.tplTwo, t.head, t.seg);
      tab.tplOne = typeof t.tplOne === 'string' ? t.tplOne : '';
      tab.cats = normalizeFormCats(t.cats);
      tab.catsOne = Array.isArray(t.catsOne)
        ? normalizeFormCatsOne(t.catsOne)
        : formCatsOneFrom(tab.cats);
      tab.notes = normalizeFormNotes(t.notes);
      // 附註選項多的時候可以整排收起來。跟卡片收合一樣是版面偏好，跟著資料走
      tab.notesFold = !!t.notesFold;
    }
    if (tab.type === 'private') {
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
      order: data.categories.length,
      color: null
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
    var cat = data.categories.filter(function (c) { return c.id === id; })[0];
    if (cat) {
      pushTrash({ kind: 'category', category: cat, tabs: tabsOf(id),
                  categoryId: id, categoryName: cat.name });
    }
    data.categories = data.categories.filter(function (c) { return c.id !== id; });
    data.tabs = data.tabs.filter(function (t) { return t.categoryId !== id; });
    reorderCategories();
    touch();
    dropUnusedVault();
  }

  /** 只清空底下的卡片，分類本身留著。 */
  function clearCategory(id) {
    var list = tabsOf(id);
    if (list.length) {
      pushTrash({ kind: 'clear', tabs: list,
                  categoryId: id, categoryName: catName(id) });
    }
    data.tabs = data.tabs.filter(function (t) { return t.categoryId !== id; });
    touch();
    dropUnusedVault();
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

  /* 刪卡片或取消加密之後，如果一張加密卡片都不剩，主密碼就該一起消失。
     留著只會讓下次新建卡片沿用一組早就忘了的舊密碼。 */
  function dropUnusedVault() {
    if (window.Vault && Vault.dropMasterIfUnused) Vault.dropMasterIfUnused();
  }

  function deleteTab(id) {
    var tab = findTab(id);
    if (tab) {
      pushTrash({ kind: 'tab', tab: tab,
                  categoryId: tab.categoryId, categoryName: catName(tab.categoryId) });
    }
    data.tabs = data.tabs.filter(function (t) { return t.id !== id; });
    touch();
    dropUnusedVault();
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
   * 把卡片搬到另一個分類。
   *
   * 兩件事必須在搬過去的當下處理掉，不然會留下違反規則的狀態：
   * 1. 釘選上限是「同一分類、同一類型最多三個」。目標分類已經滿了就
   *    自動取消這張的釘選——擋著不給搬沒有道理，使用者要的是換位置，
   *    不是釘選。
   * 2. 複製鍵的唯一範圍是分類（見 findHotkeyConflict）。搬過去撞到的
   *    鍵只清掉「搬過去這張」的，原分類其他卡片一個都不動。
   *
   * @returns {Object|null} null = 沒搬（找不到或本來就在那個分類）；
   *          否則 { unpinned: boolean, clearedKeys: number }
   */
  function moveTabToCategory(tabId, toCategoryId) {
    var tab = findTab(tabId);
    var cat = findCategory(toCategoryId);
    if (!tab || !cat || tab.categoryId === toCategoryId) return null;

    var report = { unpinned: false, clearedKeys: 0 };

    if (tab.pinned && pinnedCount(toCategoryId, tab.type) >= PIN_LIMIT) {
      tab.pinned = false;
      report.unpinned = true;
    }

    if (tab.type === 'quickphrase') {
      (tab.rows || []).forEach(function (r) {
        var key = normalizeHotkey(r.hotkey);
        if (!key) return;
        // 這張卡片還沒搬過去，所以查到的一定是目標分類原有的卡片
        if (findHotkeyConflict(toCategoryId, key, r.id)) {
          r.hotkey = '';
          report.clearedKeys++;
        }
      });
    }

    // 排到目標分類的最後面。要在改 categoryId 之前算，不然會把自己算進去
    var tail = tabsOf(toCategoryId).length;
    tab.categoryId = toCategoryId;
    tab.order = tail;
    tab.updatedAt = nowIso();
    touch();
    return report;
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

  /* ============================================================
     最近刪除（保留區）
     ------------------------------------------------------------
     刪掉的卡片、分類、以及「清除分類內容」清掉的那批卡片先放這裡，
     保留兩天或三十筆，先滿的先算。到期與超量在載入時與每次刪除時
     順手清掉——沒有東西在等的時候不排計時器（11.28）。

     只收「整張卡片」與「整個分類」這種一次損失很大的東西；卡片裡的
     單一一筆不收，那重打的成本低，收進來反而讓保留區很快被佔滿。
     ============================================================ */

  var TRASH_DAYS = 2;
  var TRASH_MAX = 30;

  function trashCutoff() {
    return Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000;
  }

  /** 資料檔可能被動過手腳：認不得的項目一律丟掉，不讓它流進畫面。 */
  function normalizeTrash(arr) {
    if (!Array.isArray(arr)) return [];
    var out = [];
    arr.forEach(function (x) {
      if (!x || typeof x !== 'object') return;
      if (x.kind !== 'tab' && x.kind !== 'category' && x.kind !== 'clear') return;
      var at = typeof x.deletedAt === 'string' ? x.deletedAt : '';
      if (!at || isNaN(Date.parse(at))) return;

      var e = {
        id: x.id || uid(),
        kind: x.kind,
        deletedAt: at,
        categoryId: typeof x.categoryId === 'string' ? x.categoryId : '',
        categoryName: String(x.categoryName || '')
      };
      if (x.kind === 'tab') {
        if (!x.tab || typeof x.tab !== 'object') return;
        e.tab = normalizeTab(x.tab, 0);
      } else {
        if (x.kind === 'category') {
          if (!x.category || typeof x.category !== 'object') return;
          e.category = {
            id: x.category.id || uid(),
            name: x.category.name || '未命名',
            shortLabel: x.category.shortLabel || firstChar(x.category.name),
            order: typeof x.category.order === 'number' ? x.category.order : 0,
            color: isPaletteKey(x.category.color) ? x.category.color : null
          };
        }
        if (!Array.isArray(x.tabs)) return;
        e.tabs = x.tabs.map(function (t, i) { return normalizeTab(t, i); });
      }
      out.push(e);
    });
    return out.slice(0, TRASH_MAX);
  }

  /** 清掉過期與超量的。回傳有沒有真的清掉東西。 */
  function purgeTrash() {
    if (!Array.isArray(data.trash)) { data.trash = []; return false; }
    var cut = trashCutoff();
    var before = data.trash.length;
    data.trash = data.trash.filter(function (e) {
      return Date.parse(e.deletedAt) >= cut;
    });
    // 滿了就把最舊的擠掉：保留區的體積因此有天花板
    if (data.trash.length > TRASH_MAX) data.trash = data.trash.slice(0, TRASH_MAX);
    return data.trash.length !== before;
  }

  function pushTrash(entry) {
    if (!Array.isArray(data.trash)) data.trash = [];
    entry.id = uid();
    entry.deletedAt = nowIso();
    data.trash.unshift(entry);
    purgeTrash();
  }

  function catName(id) {
    var c = data.categories.filter(function (x) { return x.id === id; })[0];
    return c ? c.name : '';
  }

  /** 給畫面用的清單，最近刪的排最前面。 */
  function trashList() {
    purgeTrash();
    return data.trash.map(function (e) {
      return {
        id: e.id,
        kind: e.kind,
        deletedAt: e.deletedAt,
        categoryName: e.categoryName,
        name: e.kind === 'tab' ? (e.tab.title || '未命名')
          : (e.kind === 'category' ? (e.category.name || '未命名') : e.categoryName),
        count: e.kind === 'tab' ? 1 : (e.tabs || []).length,
        type: e.kind === 'tab' ? e.tab.type : ''
      };
    });
  }

  function trashCount() {
    purgeTrash();
    return data.trash.length;
  }

  /**
   * 還原一筆。
   * @param {string} id 保留區項目的 id
   * @param {string} fallbackCategoryId 原分類已經不在時要放哪裡
   * @returns {object|null} { kind, name, movedTo }；movedTo 有值代表換了分類
   */
  function restoreTrash(id, fallbackCategoryId) {
    purgeTrash();
    var i = -1;
    data.trash.forEach(function (e, j) { if (e.id === id) i = j; });
    if (i < 0) return null;
    var e = data.trash[i];
    var res = { kind: e.kind, name: '', movedTo: null };

    if (e.kind === 'category') {
      var exists = data.categories.some(function (c) { return c.id === e.category.id; });
      if (!exists) {
        data.categories.push(e.category);
        reorderCategories();
      }
      (e.tabs || []).forEach(function (t) {
        t.categoryId = e.category.id;
        data.tabs.push(t);
      });
      reorderTabs(e.category.id);
      res.name = e.category.name;
      res.count = (e.tabs || []).length;
    } else {
      var list = e.kind === 'tab' ? [e.tab] : (e.tabs || []);
      var target = e.categoryId;
      if (!data.categories.some(function (c) { return c.id === target; })) {
        target = fallbackCategoryId ||
          (data.categories[0] ? data.categories[0].id : '');
        res.movedTo = catName(target);
      }
      if (!target) return null;
      list.forEach(function (t) {
        t.categoryId = target;
        data.tabs.push(t);
      });
      reorderTabs(target);
      res.name = e.kind === 'tab' ? (e.tab.title || '未命名') : e.categoryName;
      res.count = list.length;
    }

    data.trash.splice(i, 1);
    touch();
    return res;
  }

  /** 永久刪掉保留區裡的一筆。 */
  function purgeTrashItem(id) {
    purgeTrash();
    var before = data.trash.length;
    data.trash = data.trash.filter(function (e) { return e.id !== id; });
    if (data.trash.length !== before) {
      touch();
      dropUnusedVault();
    }
  }

  /** 整個保留區清空。 */
  function clearTrash() {
    if (!Array.isArray(data.trash) || !data.trash.length) return;
    data.trash = [];
    touch();
    dropUnusedVault();
  }

  /** 保留區裡有沒有加密的私人卡片（決定主密碼能不能丟）。 */
  function trashHasEncrypted() {
    return (data.trash || []).some(function (e) {
      var list = e.kind === 'tab' ? [e.tab] : (e.tabs || []);
      return list.some(function (t) {
        return t && t.type === 'private' && t.encrypted;
      });
    });
  }

  /** 同一個分類裡的卡片重新編號，避免還原回來的排序跟別人撞在一起。 */
  function reorderTabs(categoryId) {
    tabsOf(categoryId).forEach(function (t, i) { t.order = i; });
  }

  /* ---------- 瀏覽器儲存空間 ---------- */

  /* 實測 Chrome 的上限是 5,242,880 個「字」，中文與英文各算一個
     （用中文與英文各寫到爆確認過，數字相同）。分頁暫存與 localStorage
     各自有自己的額度，所以現在算的是**這個分頁**用掉多少。 */
  var STORAGE_LIMIT = 5 * 1024 * 1024;

  function storageUsage() {
    var used = 0;
    try {
      var s = store();
      for (var i = 0; i < s.length; i++) {
        var k = s.key(i);
        var v = s.getItem(k);
        used += (k ? k.length : 0) + (v ? v.length : 0);
      }
    } catch (e) {
      return null;      // 讀不到就不顯示，總比顯示一個假數字好
    }
    var pct = used / STORAGE_LIMIT * 100;
    return {
      used: used,
      limit: STORAGE_LIMIT,
      // 0.1% 的解析度就夠了，再細只是讓數字一直跳
      percent: Math.min(100, Math.round(pct * 10) / 10)
    };
  }

  /**
   * 誰佔掉了空間。用來在快滿的時候直接告訴使用者要刪哪一張，
   * 不必自己一張張猜。只在跳提醒時算一次，不進一般流程。
   */
  function storageBreakdown(topN) {
    var out = { tabs: [], trash: 0, other: 0 };
    var own = 0;
    try {
      own = (store().getItem(STORAGE_KEY) || '').length;
      var u = storageUsage();
      out.other = u ? Math.max(0, u.used - own - STORAGE_KEY.length) : 0;
    } catch (e) { /* 讀不到就當 0，不要因此整段失敗 */ }

    out.trash = JSON.stringify(data.trash || []).length;
    out.tabs = data.tabs.map(function (t) {
      return {
        id: t.id,
        title: t.title || '未命名',
        type: t.type,
        chars: JSON.stringify(t).length
      };
    }).sort(function (a, b) { return b.chars - a.chars; })
      .slice(0, topN || 5);
    return out;
  }

  /* ---------- 編碼卡與表單卡的選項順序 ---------- */

  /** 一組選項的實際陣列。兩張卡片各有幾組，名字就是資料欄位名。 */
  function genOptionList(tab, which) {
    if (!tab) return null;
    if (tab.type === 'codegen') {
      if (which === 'g1') return tab.g1;
      if (which === 'g2') return tab.g2;
      return null;
    }
    if (tab.type === 'form') {
      if (which === 'cats') return tab.cats;
      if (which === 'catsOne') return tab.catsOne;
      if (which === 'notes') return tab.notes;
    }
    return null;
  }

  /**
   * 把一個選項移到另一個選項的位置。
   * 這些清單沒有 order 欄位——陣列順序就是畫面順序，所以直接搬陣列。
   */
  function moveGenOption(tabId, which, fromId, toId) {
    var tab = findTab(tabId);
    var list = genOptionList(tab, which);
    if (!list || !fromId || fromId === toId) return;

    var from = -1, to = -1;
    list.forEach(function (x, i) {
      if (x.id === fromId) from = i;
      if (x.id === toId) to = i;
    });
    if (from < 0 || to < 0) return;

    list.splice(to, 0, list.splice(from, 1)[0]);
    tab.updatedAt = nowIso();
    touch();
  }

  /* ---------- 顏色與主題操作 ---------- */

  /** v 可以是色票名、'none'（中性）、null（跟隨類型）。 */
  function setTabColor(tabId, v) {
    var tab = findTab(tabId);
    if (!tab) return;
    tab.color = normalizeTabColor(v);
    touch();
  }

  /** v 是色票名或 null（中性）。 */
  function setCategoryColor(catId, v) {
    var c = findCategory(catId);
    if (!c) return;
    c.color = isPaletteKey(v) ? v : null;
    touch();
  }

  function theme() {
    if (!data.settings || !data.settings.theme) data.settings = normalizeSettings(data.settings);
    return data.settings.theme;
  }

  function setTheme(patch) {
    var th = theme();
    // 不認得的值一律回到預設（亮色），與載入時的正規化同一套規則
    if (patch.mode) th.mode = patch.mode === 'dark' ? 'dark' : 'light';
    if (patch.cardStyle) th.cardStyle = patch.cardStyle === 'full' ? 'full' : 'line';
    touch();
  }

  function themeCustom(mode) {
    var th = theme();
    if (!th.custom) th.custom = { dark: {}, light: {} };
    if (!th.custom[mode]) th.custom[mode] = {};
    return th.custom[mode];
  }

  /**
   * 設定一項自訂配色；value 為 null 代表恢復預設。
   * 只存檔不重繪：顏色全在 CSS 變數裡，重繪整個畫面沒有必要，
   * 而且會讓正在拖的取色器、正在打的色碼失去焦點。
   */
  function setThemeCustom(mode, key, value) {
    var c = themeCustom(mode);
    var v = value === null ? null : cleanCustomValue(key, value);
    if (v === null) delete c[key];
    else c[key] = v;
    touch(true);
  }

  function resetThemeCustom(mode) {
    theme().custom[mode] = {};
    touch(true);
  }

  /* ---------- 配色套組操作 ---------- */

  function copyCustom(c) { return JSON.parse(JSON.stringify(c || {})); }

  function sameCustom(a, b) {
    a = a || {}; b = b || {};
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(function (k) { return JSON.stringify(a[k]) === JSON.stringify(b[k]); });
  }

  function slots() {
    var th = theme();
    if (!Array.isArray(th.slots) || th.slots.length !== SLOT_COUNT) th.slots = normalizeSlots(th.slots);
    return th.slots;
  }

  function slotName(i) {
    var s = slots()[i];
    return (s && s.name) || ('套組 ' + (i + 1));
  }

  /** 把目前的外觀存進第 i 格，並把它設成使用中 */
  function saveSlot(i) {
    var th = theme(), list = slots();
    var old = list[i];
    list[i] = {
      name: old ? old.name : '',
      mode: th.mode,
      cardStyle: th.cardStyle,
      custom: copyCustom(themeCustom(th.mode))
    };
    th.activeSlot = i;
    touch(true);
  }

  /** 套用第 i 格：亮暗、上色方式、顏色一起換 */
  function applySlot(i) {
    var th = theme(), s = slots()[i];
    if (!s) return;
    th.mode = s.mode;
    th.cardStyle = s.cardStyle;
    themeCustom(s.mode);
    th.custom[s.mode] = copyCustom(s.custom);
    th.activeSlot = i;
    touch();
  }

  /** 預設亮色／預設暗色：只清掉那個主題的自訂顏色，細線或滿版維持目前設定 */
  function applyFactory(mode) {
    var th = theme();
    th.mode = mode === 'light' ? 'light' : 'dark';
    th.custom[th.mode] = {};
    th.activeSlot = null;
    touch();
  }

  function renameSlot(i, name) {
    var s = slots()[i];
    if (!s) return;
    s.name = String(name || '').trim().slice(0, 12);
    touch(true);
  }

  function clearSlot(i) {
    var th = theme();
    slots()[i] = null;
    if (th.activeSlot === i) th.activeSlot = null;
    touch(true);
  }

  /** 使用中的套組被改過、還沒存回去 */
  function slotModified() {
    var th = theme(), a = th.activeSlot;
    if (a === null || a === undefined || !slots()[a]) return false;
    var s = slots()[a];
    return s.mode !== th.mode || s.cardStyle !== th.cardStyle || !sameCustom(s.custom, themeCustom(th.mode));
  }

  /**
   * 目前的外觀有沒有「存不回來」的東西：
   * 有使用中的套組 → 看它有沒有被改過；
   * 沒有 → 目前主題只要有自訂顏色，就是還沒存。
   */
  function hasUnsavedLook() {
    var th = theme();
    if (th.activeSlot !== null && th.activeSlot !== undefined && slots()[th.activeSlot]) return slotModified();
    return Object.keys(themeCustom(th.mode)).length > 0;
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

  /* ---------- 收合 ---------- */

  /** 切換單張卡片的收合。 */
  function toggleCollapse(tabId) {
    var tab = findTab(tabId);
    if (!tab) return;
    tab.collapsed = !tab.collapsed;
    tab.updatedAt = nowIso();
    touch();
  }

  /** 切換表單卡「附註」那一排的收合。選項多的時候整排收掉，卡片不會被撐長。 */
  function toggleNotesFold(tabId) {
    var tab = findTab(tabId);
    if (!tab || tab.type !== 'form') return;
    tab.notesFold = !tab.notesFold;
    tab.updatedAt = nowIso();
    touch();
  }

  /** 這個分類裡還有沒有展開的卡片（決定選單要寫「全部收合」還是「全部展開」）。 */
  function categoryAnyExpanded(categoryId) {
    return data.tabs.some(function (t) {
      return t.categoryId === categoryId && !t.collapsed;
    });
  }

  /** 整個分類一起收合或展開。 */
  function collapseAll(categoryId, collapsed) {
    var changed = false;
    data.tabs.forEach(function (t) {
      if (t.categoryId !== categoryId || !!t.collapsed === !!collapsed) return;
      t.collapsed = !!collapsed;
      t.updatedAt = nowIso();
      changed = true;
    });
    if (changed) touch();
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

  /* ---------- 置頂小視窗 ---------- */

  function pipSize() {
    return normalizePipSize(data.settings && data.settings.pipSize);
  }

  function setPipSize(w, h) {
    var next = normalizePipSize({ w: w, h: h });
    var cur = pipSize();
    if (cur.w === next.w && cur.h === next.h) return;
    data.settings.pipSize = next;
    // skipRender：只是記住視窗大小，畫面沒有任何東西需要跟著重畫
    touch(true);
  }

  /* ---------- 匯出／匯入 ---------- */

  function exportJson() {
    purgeTrash();
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
    moveTabToCategory: moveTabToCategory,
    pipSize: pipSize,
    setPipSize: setPipSize,
    ZOOM_STEPS: ZOOM_STEPS,
    uiZoom: uiZoom,
    setUiZoom: setUiZoom,
    normalizeDue: normalizeDue,
    normalizeTime: normalizeTime,
    dueInfo: dueInfo,
    categoryHasDue: categoryHasDue,
    tabHasDue: tabHasDue,
    nextDueChange: nextDueChange,
    toggleCollapse: toggleCollapse,
    toggleNotesFold: toggleNotesFold,
    categoryAnyExpanded: categoryAnyExpanded,
    collapseAll: collapseAll,
    GEN_CODE_TOKEN: GEN_CODE_TOKEN,
    GEN_WAY_TOKEN: GEN_WAY_TOKEN,
    genRandomCode: genRandomCode,
    genApplyDigit: genApplyDigit,
    genLast8: genLast8,
    genAllLetters: genAllLetters,
    genBuildText: genBuildText,
    genSrcLabel: genSrcLabel,
    genLabelDefault: genLabelDefault,
    formLabelDefault: formLabelDefault,
    FORM_TOKENS: FORM_TOKENS,
    FORM_TOKENS_TWO: FORM_TOKENS_TWO,
    formBuildText: formBuildText,
    formUsedTokens: formUsedTokens,
    moveRow: moveRow,
    genOptionList: genOptionList,
    moveGenOption: moveGenOption,
    onSaveError: onSaveError,
    storageUsage: storageUsage,
    storageBreakdown: storageBreakdown,
    STORAGE_LIMIT: STORAGE_LIMIT,
    trashList: trashList,
    trashCount: trashCount,
    restoreTrash: restoreTrash,
    purgeTrashItem: purgeTrashItem,
    clearTrash: clearTrash,
    trashHasEncrypted: trashHasEncrypted,
    TRASH_DAYS: TRASH_DAYS,
    TRASH_MAX: TRASH_MAX,
    moveNoteItem: moveNoteItem,
    moveItem: moveItem,
    onDirty: onDirty,
    noteFieldsParse: noteFieldsParse,
    noteFieldsText: noteFieldsText,
    noteFormText: noteFormText,
    CARD_TYPES: CARD_TYPES,
    typeOrder: typeOrder,
    moveType: moveType,
    moveLink: moveLink,
    wipeLocal: wipeLocal,
    memoryOnly: memoryOnly,
    legacyMigrated: legacyMigrated,
    isEmpty: isEmpty,
    togglePin: togglePin,
    pinnedCount: pinnedCount,
    PIN_LIMIT: PIN_LIMIT,
    normalizeHotkey: normalizeHotkey,
    findHotkeyConflict: findHotkeyConflict,
    exportJson: exportJson,
    importJson: importJson,
    PALETTE: PALETTE,
    paletteName: paletteName,
    TYPE_COLOR: TYPE_COLOR,
    tabColor: tabColor,
    setTabColor: setTabColor,
    setCategoryColor: setCategoryColor,
    theme: theme,
    setTheme: setTheme,
    themeCustom: themeCustom,
    SLOT_COUNT: SLOT_COUNT,
    slots: slots,
    slotName: slotName,
    saveSlot: saveSlot,
    applySlot: applySlot,
    applyFactory: applyFactory,
    renameSlot: renameSlot,
    clearSlot: clearSlot,
    slotModified: slotModified,
    hasUnsavedLook: hasUnsavedLook,
    setThemeCustom: setThemeCustom,
    resetThemeCustom: resetThemeCustom
  };
})();
