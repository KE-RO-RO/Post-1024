/* ============================================================
   theme.js — 自訂配色（v4.8）
   ------------------------------------------------------------
   原則：
   1. 預設值只寫在 style.css 裡。這裡啟動時從樣式表「讀」出來，
      不在 JS 另抄一份，避免兩邊改了一邊忘了另一邊。
   2. 資料裡只存使用者改過的項目。沒改的就維持樣式表的手調值，
      不會因為「重新計算」而跑掉。
   3. 改一項基本色時，只重算「跟它有關」的深淺。例如只改強調色，
      底色、文字那一整串完全不動。
   4. 亮暗兩個主題各存一份，面板只調目前正在用的那一個。
   ============================================================ */

(function () {
  'use strict';

  /* ---------- 顏色小工具 ---------- */

  function clamp(n) { return Math.max(0, Math.min(255, Math.round(n))); }

  /** 解析 '#rrggbb'、'rgb(...)'、'rgba(...)'、'r, g, b' 四種寫法 → { r, g, b, a } */
  function parse(str) {
    str = String(str || '').trim();
    var m = /^#([0-9a-f]{6})$/i.exec(str);
    if (m) {
      var n = parseInt(m[1], 16);
      return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255, a: 1 };
    }
    var nums = str.replace(/rgba?\(|\)/g, '').split(',').map(function (x) { return parseFloat(x); });
    if (nums.length >= 3 && nums.every(function (x) { return isFinite(x); })) {
      return { r: nums[0], g: nums[1], b: nums[2], a: nums.length > 3 ? nums[3] : 1 };
    }
    return null;
  }

  function hex(c) {
    return '#' + [c.r, c.g, c.b].map(function (v) {
      return ('0' + clamp(v).toString(16)).slice(-2);
    }).join('');
  }
  function triplet(c) { return clamp(c.r) + ', ' + clamp(c.g) + ', ' + clamp(c.b); }
  function rgba(c, a) { return 'rgba(' + triplet(c) + ', ' + (Math.round(a * 1000) / 1000) + ')'; }

  function mix(a, b, t) {
    return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 };
  }
  /** 半透明的 fg 疊在不透明的 bg 上，得到實際看到的顏色 */
  function over(fg, bg) {
    var a = fg.a === undefined ? 1 : fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }

  function lum(c) {
    function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function contrast(a, b) {
    var x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function isLight(c) { return lum(c) > 0.35; }

  /** CIE76 色差。10 以上一般算一眼分得開 */
  function deltaE(a, b) {
    function lab(c) {
      function f(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
      var r = f(c.r), g = f(c.g), bl = f(c.b);
      var X = (0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047;
      var Y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      var Z = (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883;
      function q(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }
      return [116 * q(Y) - 16, 500 * (q(X) - q(Y)), 200 * (q(Y) - q(Z))];
    }
    var p = lab(a), s = lab(b);
    return Math.sqrt(Math.pow(p[0] - s[0], 2) + Math.pow(p[1] - s[1], 2) + Math.pow(p[2] - s[2], 2));
  }

  /** 把 c 往 toward 混，找到對 bg 剛好達到 target 對比的點；本來就夠就原樣回傳 */
  function reach(c, toward, bg, target) {
    if (contrast(c, bg) >= target) return c;
    for (var t = 0.02; t <= 1.0001; t += 0.02) {
      var m = mix(c, toward, t);
      if (contrast(m, bg) >= target) return m;
    }
    return toward;
  }
  /** 反方向：把 c 往 bg 淡化，淡到對比剛好剩 target（次要文字、提示文字用） */
  function fadeTo(c, bg, target) {
    var best = c;
    for (var t = 0.02; t <= 1.0001; t += 0.02) {
      var m = mix(c, bg, t);
      if (contrast(m, bg) < target) break;
      best = m;
    }
    return best;
  }

  var BLACK = { r: 0, g: 0, b: 0, a: 1 };
  var WHITE = { r: 255, g: 255, b: 255, a: 1 };

  /* ---------- 預設值：從樣式表讀 ---------- */

  var VARS = [
    '--bg', '--bg-deep', '--panel', '--panel-solid', '--panel-hover', '--panel-alt', '--toast-bg',
    '--border', '--border-strong', '--text', '--text-dim', '--text-faint',
    '--accent', '--accent-soft', '--accent-line', '--accent-hover', '--accent-mark', '--accent-glow',
    '--raise-xs', '--raise-sm', '--raise-md', '--sink-soft', '--sink-strong', '--field-bg', '--overlay',
    '--shadow', '--picker-icon',
    '--danger', '--danger-soft', '--danger-fill', '--danger-hover', '--danger-line',
    '--danger-line-strong', '--danger-text', '--danger-text-strong', '--warn',
    '--c-green', '--c-teal', '--c-blue', '--c-pink', '--c-tea', '--c-cocoa',
    '--tint-cat', '--tint-cat-on', '--tint-badge-line', '--tint-head-full', '--tint-badge-full',
    '--cat-on-neutral', '--cat-on-neutral-a'
  ];
  // 背景明暗翻面時，這些要整組換成另一個主題的手調值
  var DIRECTIONAL = ['--raise-xs', '--raise-sm', '--raise-md', '--sink-soft', '--sink-strong',
                     '--field-bg', '--overlay', '--shadow', '--picker-icon'];

  var PRESET = { dark: null, light: null };

  // 面板自己用到的變數，一律固定成預設值（見 open()）
  var SELF_VARS = ['--panel-solid', '--text', '--text-dim', '--text-faint', '--border', '--border-strong',
                   '--field-bg', '--accent', '--accent-soft', '--accent-line', '--danger-text',
                   '--danger-soft', '--danger-line-strong', '--shadow', '--raise-sm', '--panel-hover'];

  /**
   * 啟動時各切一次主題，把樣式表裡的值讀出來當預設。
   * 必須在自訂的 <style> 放上去之前做，否則讀到的會是自訂後的值。
   */
  function readPresets() {
    var root = document.documentElement;
    var keep = root.dataset.theme;
    ['dark', 'light'].forEach(function (mode) {
      root.dataset.theme = mode;
      var cs = getComputedStyle(root);
      var map = {};
      VARS.forEach(function (v) { map[v] = cs.getPropertyValue(v).trim(); });
      PRESET[mode] = map;
    });
    if (keep) root.dataset.theme = keep; else delete root.dataset.theme;
  }

  /* ---------- 計算某個主題的實際值 ---------- */

  /**
   * 回傳 { vars: { '--x': 值字串 }, scheme, info }。
   * vars 只含「跟預設不同」的變數；info 給面板顯示用（實際顏色、對比）。
   */
  function compute(mode, customOverride) {
    var P = PRESET[mode];
    var c = customOverride || DB.themeCustom(mode);
    var out = {};
    function get(v) { return out[v] !== undefined ? out[v] : P[v]; }
    function col(v) { return parse(get(v)); }

    // ---- 底色 ----
    var bg = c.bg ? parse(c.bg) : parse(P['--bg']);
    if (c.bg) {
      out['--bg'] = c.bg;
      out['--bg-deep'] = hex(mix(bg, BLACK, isLight(bg) ? 0.06 : 0.27));
    }

    // ---- 面板 ----
    /* 疊色方向（卡片微亮、滑過、輸入框、日期圖示、原生元件）看的是「面板」的明暗，
       不是底色——那些東西都疊在面板與卡片上。第一版拿底色判斷，
       結果亮色主題調成深底時，淺色面板上的輸入框變成一塊塊灰。 */
    var presetPanel = parse(P['--panel']);
    var panel = c.panel ? parse(c.panel) : presetPanel;
    var light = isLight(panel);
    var flipped = light !== isLight(presetPanel);
    if (flipped) {
      var other = PRESET[mode === 'dark' ? 'light' : 'dark'];
      DIRECTIONAL.forEach(function (v) { out[v] = other[v]; });
    }
    if (c.panel) {
      out['--panel'] = rgba(panel, 0.72);
      out['--panel-solid'] = hex(light ? mix(panel, WHITE, 0.3) : panel);
      out['--panel-alt'] = light ? rgba(panel, 0.72) : rgba(mix(panel, bg, 0.8), 0.72);
      out['--panel-hover'] = rgba(mix(panel, WHITE, light ? 0.5 : 0.1), light ? 0.92 : 0.85);
      out['--toast-bg'] = light ? rgba(mix(panel, WHITE, 0.3), 0.97) : rgba(mix(bg, BLACK, 0.25), 0.95);
    }

    // 卡片實際疊出來的底色：對比一律拿它來算
    var card = over(col('--panel-alt'), over(col('--panel'), bg));

    // ---- 文字 ----
    var text = c.text ? parse(c.text) : parse(P['--text']);
    if (c.text) {
      out['--text'] = c.text;
      out['--text-dim'] = hex(fadeTo(text, card, Math.min(5.3, contrast(text, card))));
      out['--text-faint'] = hex(fadeTo(text, card, Math.min(3.0, contrast(text, card))));
      out['--border'] = rgba(text, light ? 0.14 : 0.13);
      out['--border-strong'] = rgba(text, light ? 0.22 : 0.18);
    }

    // ---- 強調色：各種深淺沿用預設的透明度，只換顏色 ----
    var accent = c.accent ? parse(c.accent) : parse(P['--accent']);
    if (c.accent) {
      out['--accent'] = c.accent;
      ['--accent-soft', '--accent-line', '--accent-hover', '--accent-mark', '--accent-glow'].forEach(function (v) {
        out[v] = rgba(accent, parse(P[v]).a);
      });
      // 暗色的「沒設顏色的分類被選中」預設就是強調色，強調色換了它也跟著換
      if (triplet(parse(P['--cat-on-neutral'])) === triplet(parse(P['--accent']))) {
        out['--cat-on-neutral'] = triplet(accent);
      }
    }

    // ---- 色票 ----
    DB.PALETTE.forEach(function (p) {
      var k = 'c-' + p.key;
      if (c[k]) out['--' + k] = triplet(parse(c[k]));
    });

    // ---- 精選進階（覆寫，優先於上面的衍生值） ----
    if (c.catOnNeutral) {
      out['--cat-on-neutral'] = triplet(parse(c.catOnNeutral.c));
      out['--cat-on-neutral-a'] = String(c.catOnNeutral.a);
    }
    [['tintCat', '--tint-cat'], ['tintCatOn', '--tint-cat-on'], ['tintBadgeLine', '--tint-badge-line'],
     ['tintHeadFull', '--tint-head-full'], ['tintBadgeFull', '--tint-badge-full']].forEach(function (x) {
      if (c[x[0]] !== undefined) out[x[1]] = String(c[x[0]]);
    });
    if (c.border) {
      var bc = parse(c.border.c);
      out['--border'] = rgba(bc, c.border.a);
      out['--border-strong'] = rgba(bc, Math.min(1, c.border.a + 0.08));
    }
    if (c.danger) {
      var d = parse(c.danger);
      out['--danger'] = c.danger;
      ['--danger-soft', '--danger-fill', '--danger-hover', '--danger-line', '--danger-line-strong'].forEach(function (v) {
        out[v] = rgba(d, parse(P[v]).a);
      });
      var toward = light ? BLACK : WHITE;
      out['--danger-text'] = hex(reach(d, toward, card, 4.5));
      out['--danger-text-strong'] = hex(reach(d, toward, card, 5.5));
    }
    if (c.warn) out['--warn'] = c.warn;
    if (c.accentMark) out['--accent-mark'] = rgba(parse(c.accentMark.c), c.accentMark.a);

    return {
      vars: out,
      // 底色明暗跟預設相反時，原生元件（核取方塊、日期欄）也要跟著換
      scheme: flipped ? (light ? 'light' : 'dark') : null,
      card: card,
      get: get,
      col: col
    };
  }

  /* ---------- 套用 ---------- */

  var styleEl = null;

  function apply() {
    if (!PRESET.dark) return;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'customTheme';
      document.head.appendChild(styleEl);
    }
    var css = '';
    ['dark', 'light'].forEach(function (mode) {
      var r = compute(mode);
      var keys = Object.keys(r.vars);
      if (!keys.length && !r.scheme) return;
      // 權重要高過樣式表的 :root 與 :root[data-theme="light"]，而且放在它之後
      css += ':root[data-theme="' + mode + '"] {\n';
      keys.forEach(function (k) { css += '  ' + k + ': ' + r.vars[k] + ';\n'; });
      if (r.scheme) css += '  color-scheme: ' + r.scheme + ';\n';
      css += '}\n';
    });
    styleEl.textContent = css;
  }

  /* ============================================================
     面板
     ============================================================ */

  var MODE_LABEL = { dark: '暗色', light: '亮色' };

  /* 面板上的每一項。kind：
       color       取色器＋色碼
       colorAlpha  取色器＋色碼＋不透明度滑桿
       num         只有滑桿（濃淡）
     check 回傳 { ratio, min, msg }，不足 min 時標紅；只是警告，不擋。 */
  function items(mode) {
    var list = [
      { group: '基本配色', hint: '改一項，相關的深淺自動算' },
      { key: 'bg', label: '底色', kind: 'color', read: function (r) { return r.col('--bg'); } },
      { key: 'panel', label: '面板', kind: 'color', read: function (r) { return r.col('--panel'); } },
      { key: 'text', label: '文字', kind: 'color', read: function (r) { return r.col('--text'); },
        check: function (r, c) { return { ratio: contrast(c, r.card), min: 4.5, msg: '內文需要 4.5:1 以上才好讀' }; } },
      { key: 'accent', label: '強調色', kind: 'color', read: function (r) { return r.col('--accent'); },
        check: function (r, c) { return { ratio: contrast(c, r.card), min: 4.5, msg: '強調色用在按鈕文字、★、連結上，建議 4.5:1 以上' }; } },
      { group: '色票', hint: '卡片與分類共用；對比是對卡片底色' }
    ];
    DB.PALETTE.forEach(function (p) {
      list.push({
        key: 'c-' + p.key, label: DB.paletteName(p.key, mode), kind: 'color', palette: p.key,
        read: function (r) { return r.col('--c-' + p.key); },
        check: function (r, c) {
          var res = { ratio: contrast(c, r.card), min: 2.95, msg: '細線版的色邊會看不清楚，建議 3:1 以上' };
          // 跟其他色票太像的話，卡片會分不出來（米色與卡其色撞色的教訓）
          var near = null;
          DB.PALETTE.forEach(function (q) {
            if (q.key === p.key) return;
            var e = deltaE(c, r.col('--c-' + q.key));
            if (e < 10 && (!near || e < near.e)) near = { e: e, name: DB.paletteName(q.key, mode) };
          });
          if (near) res.extra = '跟「' + near.name + '」太接近（色差 ' + Math.round(near.e) + '），卡片會分不出來';
          return res;
        }
      });
    });
    list.push(
      { group: '進階', hint: '覆寫單一項目；沒改的仍跟著上面走' },
      { sub: '分類' },
      { key: 'catOnNeutral', label: '選中分類', desc: '沒設顏色的分類被選中時', kind: 'colorAlpha',
        read: function (r) { var c = r.col('--cat-on-neutral'); c.a = parseFloat(r.get('--cat-on-neutral-a')); return c; } },
      { key: 'tintCat', label: '分類貼紙濃淡', desc: '有顏色的分類平常的底色', kind: 'num', cssVar: '--tint-cat' },
      { key: 'tintCatOn', label: '選中時的濃淡', desc: '有顏色的分類被選中時', kind: 'num', cssVar: '--tint-cat-on' },
      { sub: '卡片' },
      { key: 'tintBadgeLine', label: '細線版小圓標', desc: '小圓標底色的深淺', kind: 'num', cssVar: '--tint-badge-line' },
      { key: 'tintHeadFull', label: '滿版標題列', desc: '整條標題列的深淺', kind: 'num', cssVar: '--tint-head-full' },
      { key: 'tintBadgeFull', label: '滿版小圓標', desc: '滿版時小圓標的深淺', kind: 'num', cssVar: '--tint-badge-full' },
      { sub: '其他' },
      { key: 'border', label: '框線', desc: '卡片、輸入框的邊', kind: 'colorAlpha',
        read: function (r) { return r.col('--border'); } },
      { key: 'danger', label: '刪除／過期紅', desc: '刪除鈕、過期的倒數', kind: 'color',
        read: function (r) { return r.col('--danger'); },
        check: function (r, c) { return { ratio: contrast(c, r.card), min: 3, msg: '過期的倒數天數用這個顏色，建議 3:1 以上' }; } },
      { key: 'warn', label: '預警琥珀', desc: '倒數三天內', kind: 'color',
        read: function (r) { return r.col('--warn'); },
        check: function (r, c) { return { ratio: contrast(c, r.card), min: 3, msg: '倒數天數用這個顏色，建議 3:1 以上' }; } },
      { key: 'accentMark', label: '搜尋螢光', desc: '搜尋命中的底色', kind: 'colorAlpha',
        read: function (r) { return r.col('--accent-mark'); },
        check: function (r, c) {
          return { ratio: contrast(r.col('--text'), over(c, r.card)), min: 4.5, msg: '螢光上的文字對比偏低', label: '字 ' };
        } }
    );
    return list;
  }

  var drawer = null;       // { el, mode, rows: [{ item, refresh }], slotsEl }

  /* 彈窗、確認框由 app.js 提供（它們在 app.js 裡），啟動時注入 */
  var ui = null;
  function setUI(o) { ui = o; }

  /* ============================================================
     配色套組（v4.8）
     ============================================================ */

  /** 切換前的保護：目前的外觀有沒存的調整時先問一聲 */
  function guard(fn) {
    if (!DB.hasUnsavedLook()) { fn(); return; }
    ui.confirm('切換配色',
      '目前的配色有調整還沒存到套組，切換之後這些調整就不見了。<br><br>要直接切換嗎？',
      '直接切換', fn, false);
  }

  function applySlot(i, after) {
    guard(function () { DB.applySlot(i); if (after) after(); });
  }

  function applyFactory(mode, after) {
    guard(function () { DB.applyFactory(mode); if (after) after(); });
  }

  /** 套組的預覽色：底色、面板、強調色，加上六個色票 */
  function slotColors(slot) {
    var r = compute(slot.mode, slot.custom);
    var list = ['--bg', '--panel', '--accent'].map(function (v) { return hex(r.col(v)); });
    DB.PALETTE.forEach(function (p) { list.push(hex(r.col('--c-' + p.key))); });
    return list;
  }

  function slotAccent(i) {
    var s = DB.slots()[i];
    return s ? hex(compute(s.mode, s.custom).col('--accent')) : null;
  }

  function saveSlot(i) {
    var th = DB.theme(), s = DB.slots()[i];
    var go = function () { DB.saveSlot(i); refresh(); };
    // 存回使用中的那一格不必問；覆蓋別的已存套組才要確認
    if (s && th.activeSlot !== i) {
      ui.confirm('覆蓋套組', '「' + escapeHtml(DB.slotName(i)) + '」已經存了一套配色，要用目前的外觀覆蓋嗎？',
        '覆蓋', go, false);
    } else go();
  }

  function escapeHtml(t) {
    var d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
  }

  /** ✎：改名或清除 */
  function editSlot(i) {
    var wrap = document.createElement('div');
    var l = document.createElement('label');
    l.textContent = '套組名稱';
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 12;
    input.value = DB.slots()[i].name || '';
    input.placeholder = '套組 ' + (i + 1);
    wrap.appendChild(l);
    wrap.appendChild(input);

    function ok() {
      ui.close();
      DB.renameSlot(i, input.value);
      refresh();
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); ok(); }
      e.stopPropagation();
    });

    ui.show({
      title: '編輯套組',
      body: wrap,
      noEscape: true,     // 有正在輸入的內容，Esc 不關（規格書 4.5）
      buttons: [
        { text: '清除這格', cls: 'btn-danger', onClick: function () {
          ui.close();
          ui.confirm('清除套組', '將清除「' + escapeHtml(DB.slotName(i)) + '」這一格的配色。<br><br>此動作無法復原。',
            '確定清除', function () { DB.clearSlot(i); refresh(); }, true);
        } },
        { text: '取消', onClick: ui.close },
        { text: '儲存', cls: 'btn-primary', onClick: ok }
      ]
    });
  }

  function renderSlots() {
    if (!drawer) return;
    var box = drawer.slotsEl;
    var th = DB.theme();
    /* 內容沒變就不重畫。否則「在色碼欄打字 → 直接點存到這格」時，
       色碼欄失去焦點觸發的重畫會在滑鼠按下與放開之間把按鈕換掉，
       這一下點擊就落空了（實測抓到的）。 */
    var sig = JSON.stringify([DB.slots(), th.activeSlot, th.mode, DB.slotModified(),
                              Object.keys(DB.themeCustom('light')).length, Object.keys(DB.themeCustom('dark')).length]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'cz-group';
    head.innerHTML = '<span>配色套組</span><small>點一下套用，整個外觀一起換</small>';
    box.appendChild(head);

    // 預設亮色／預設暗色：不佔三格名額
    var fac = document.createElement('div');
    fac.className = 'cz-factory';
    [['light', '預設亮色'], ['dark', '預設暗色']].forEach(function (f) {
      var b = document.createElement('button');
      b.className = 'btn-plain';
      b.textContent = f[1];
      var on = th.activeSlot === null && th.mode === f[0] && !Object.keys(DB.themeCustom(f[0])).length;
      if (on) b.classList.add('on');
      b.addEventListener('click', function () { applyFactory(f[0]); });
      fac.appendChild(b);
    });
    box.appendChild(fac);

    var grid = document.createElement('div');
    grid.className = 'cz-slot-grid';
    var modified = DB.slotModified();
    DB.slots().forEach(function (slot, i) {
      var card = document.createElement('div');
      card.className = 'cz-slot';

      if (!slot) {
        card.classList.add('empty');
        var e1 = document.createElement('div');
        e1.className = 'cz-slot-name';
        e1.textContent = '空的';
        var e2 = document.createElement('div');
        e2.className = 'cz-slot-meta';
        e2.textContent = '把目前的外觀存進來';
        card.appendChild(e1);
        card.appendChild(e2);
      } else {
        var active = th.activeSlot === i;
        if (active) card.classList.add('on');
        if (active && modified) {
          var mod = document.createElement('span');
          mod.className = 'cz-slot-mod';
          mod.textContent = '已修改';
          card.appendChild(mod);
        }
        var nm = document.createElement('div');
        nm.className = 'cz-slot-name';
        var t = document.createElement('span');
        t.textContent = DB.slotName(i);
        nm.appendChild(t);
        var ed = document.createElement('button');
        ed.className = 'cz-slot-edit';
        ed.textContent = '✎';
        ed.title = '改名或清除';
        ed.addEventListener('click', function (e) { e.stopPropagation(); editSlot(i); });
        nm.appendChild(ed);
        card.appendChild(nm);

        var meta = document.createElement('div');
        meta.className = 'cz-slot-meta';
        meta.textContent = MODE_LABEL[slot.mode] + '・' + (slot.cardStyle === 'full' ? '滿版' : '細線');
        card.appendChild(meta);

        var dots = document.createElement('div');
        dots.className = 'cz-slot-dots';
        slotColors(slot).forEach(function (c) {
          var d = document.createElement('i');
          d.style.background = c;
          dots.appendChild(d);
        });
        card.appendChild(dots);

        // 點卡片本身＝套用。存、改名是分開的按鈕（規格書 11.1）
        card.title = '套用這套配色';
        card.addEventListener('click', function () {
          if (th.activeSlot === i && !modified) return;
          applySlot(i);
        });
      }

      var save = document.createElement('button');
      save.className = 'cz-slot-save';
      save.textContent = '存到這格';
      save.addEventListener('click', function (e) { e.stopPropagation(); saveSlot(i); });
      card.appendChild(save);

      grid.appendChild(card);
    });
    box.appendChild(grid);
  }

  function isOpen() { return !!drawer; }

  function close() {
    if (!drawer) return;
    drawer.el.remove();
    drawer = null;
    document.body.classList.remove('drawer-open');
  }

  function open() {
    close();
    var mode = DB.theme().mode;
    var el = document.createElement('aside');
    el.className = 'cz-drawer';
    el.setAttribute('aria-label', '自訂配色');
    /* 面板本身永遠用這個主題的預設配色。
       否則使用者把文字調成跟面板同色時，連面板都讀不到，就改不回來了。
       CSS 變數會往下繼承，所以只要在面板這一層蓋回預設值即可。 */
    SELF_VARS.forEach(function (v) { el.style.setProperty(v, PRESET[mode][v]); });
    el.style.colorScheme = mode;

    var head = document.createElement('div');
    head.className = 'cz-head';
    head.innerHTML = '<strong>自訂配色（' + MODE_LABEL[mode] + '）</strong>';
    var x = document.createElement('button');
    x.className = 'icon-btn';
    x.textContent = '✕';
    x.title = '關閉';
    x.addEventListener('click', close);
    head.appendChild(x);
    el.appendChild(head);

    var sub = document.createElement('div');
    sub.className = 'cz-sub';
    sub.textContent = '下面的顏色只影響' + MODE_LABEL[mode] + '主題，改了立刻套用。要調' +
      MODE_LABEL[mode === 'dark' ? 'light' : 'dark'] + '，先到「外觀」切換主題，或套用一個' +
      MODE_LABEL[mode === 'dark' ? 'light' : 'dark'] + '的套組。';
    el.appendChild(sub);

    var body = document.createElement('div');
    body.className = 'cz-body';
    el.appendChild(body);

    var slotsEl = document.createElement('div');
    slotsEl.className = 'cz-slots';
    body.appendChild(slotsEl);

    var rows = [];
    items(mode).forEach(function (it) {
      if (it.group) {
        var g = document.createElement('div');
        g.className = 'cz-group';
        g.innerHTML = '<span></span><small></small>';
        g.firstChild.textContent = it.group;
        g.lastChild.textContent = it.hint;
        body.appendChild(g);
        return;
      }
      if (it.sub) {
        var s = document.createElement('div');
        s.className = 'cz-subgroup';
        s.textContent = it.sub;
        body.appendChild(s);
        return;
      }
      var row = buildRow(it, mode);
      body.appendChild(row.el);
      rows.push(row);
    });

    var foot = document.createElement('div');
    foot.className = 'cz-foot';
    var resetAll = document.createElement('button');
    resetAll.className = 'btn-plain';
    resetAll.textContent = '全部恢復預設';
    resetAll.addEventListener('click', function () {
      DB.resetThemeCustom(mode);
      apply();
      refresh();
    });
    foot.appendChild(resetAll);
    var legend = document.createElement('small');
    legend.textContent = '● 表示改過，↺ 單項恢復';
    foot.appendChild(legend);
    el.appendChild(foot);

    document.body.appendChild(el);
    document.body.classList.add('drawer-open');
    drawer = { el: el, mode: mode, rows: rows, slotsEl: slotsEl };
    refresh();
  }

  /** 改了任何一項之後，整個面板的數值、對比、警告都要重算——
      例如改了底色，文字與色票的對比也跟著變。 */
  function refresh() {
    if (!drawer) return;
    var r = compute(drawer.mode);
    var r0 = compute(drawer.mode, {});    // 全部預設時的樣子，給警告當基準
    drawer.rows.forEach(function (row) { row.refresh(r, r0); });
    renderSlots();    // 改了顏色，「已修改」的標記要跟著更新
  }

  function buildRow(it, mode) {
    var el = document.createElement('div');
    el.className = 'cz-row';

    var name = document.createElement('div');
    name.className = 'cz-name';
    name.textContent = it.label;
    if (it.desc) {
      var d = document.createElement('small');
      d.textContent = it.desc;
      name.appendChild(d);
    }
    el.appendChild(name);

    var picker = null, hexIn = null, ratio = null, slider = null, pct = null;

    if (it.kind !== 'num') {
      picker = document.createElement('input');
      picker.type = 'color';
      picker.className = 'cz-picker';
      picker.title = '開啟取色器';
      el.appendChild(picker);

      hexIn = document.createElement('input');
      hexIn.type = 'text';
      hexIn.className = 'cz-hex';
      hexIn.spellcheck = false;
      hexIn.maxLength = 7;
      el.appendChild(hexIn);
    }

    ratio = document.createElement('span');
    ratio.className = 'cz-ratio';
    el.appendChild(ratio);

    var reset = document.createElement('button');
    reset.className = 'cz-reset';
    reset.textContent = '↺';
    reset.title = '恢復預設';
    el.appendChild(reset);

    if (it.kind === 'num' || it.kind === 'colorAlpha') {
      var sl = document.createElement('div');
      sl.className = 'cz-slider';
      var lab = document.createElement('span');
      lab.textContent = it.kind === 'num' ? '濃淡' : '不透明度';
      sl.appendChild(lab);
      slider = document.createElement('input');
      slider.type = 'range';
      slider.min = 0; slider.max = 100; slider.step = 1;
      sl.appendChild(slider);
      pct = document.createElement('span');
      pct.className = 'cz-pct';
      sl.appendChild(pct);
      el.appendChild(sl);
    }

    var warn = document.createElement('div');
    warn.className = 'cz-warn';
    warn.hidden = true;
    el.appendChild(warn);

    /* ---- 寫回資料 ---- */

    function current(r) {
      if (it.kind === 'num') return parseFloat(r.get(it.cssVar));
      return it.read(r);
    }

    function commit(color, alpha) {
      var v;
      if (it.kind === 'color') v = color;
      else if (it.kind === 'num') v = alpha;
      else v = { c: color, a: alpha };
      DB.setThemeCustom(mode, it.key, v);
      apply();
      refresh();
    }

    function alphaNow() { return slider ? Number(slider.value) / 100 : 1; }

    if (picker) {
      // 拖取色器時連續觸發，畫面即時跟著變
      picker.addEventListener('input', function () {
        hexIn.value = picker.value;
        hexIn.classList.remove('bad');
        commit(picker.value, alphaNow());
      });
      hexIn.addEventListener('input', function () {
        var v = hexIn.value.trim();
        if (v && v.charAt(0) !== '#') v = '#' + v;
        if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + v.slice(1).split('').map(function (x) { return x + x; }).join('');
        if (/^#[0-9a-f]{6}$/i.test(v)) {
          hexIn.classList.remove('bad');
          picker.value = v.toLowerCase();
          commit(v.toLowerCase(), alphaNow());
        } else {
          // 打到一半不套用，只標記格式不對；離開欄位時還原成目前的值
          hexIn.classList.add('bad');
        }
      });
      hexIn.addEventListener('blur', function () {
        hexIn.classList.remove('bad');
        refresh();
      });
      hexIn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') hexIn.blur();
        e.stopPropagation();   // 不要觸發常用語的複製鍵
      });
    }
    if (slider) {
      slider.addEventListener('input', function () {
        pct.textContent = slider.value + '%';
        commit(picker ? picker.value : null, alphaNow());
      });
    }
    reset.addEventListener('click', function () {
      DB.setThemeCustom(mode, it.key, null);
      apply();
      refresh();
    });

    /* ---- 從目前的實際值重畫這一列 ---- */

    function paint(r, r0) {
      var modified = DB.themeCustom(mode)[it.key] !== undefined;
      el.classList.toggle('mod', modified);
      reset.style.visibility = modified ? 'visible' : 'hidden';

      var v = current(r);
      if (picker) {
        var h = hex(v);
        picker.value = h;
        if (document.activeElement !== hexIn) hexIn.value = h;
      }
      if (slider) {
        var a = it.kind === 'num' ? v : (v.a === undefined ? 1 : v.a);
        slider.value = Math.round(a * 100);
        pct.textContent = Math.round(a * 100) + '%';
      }

      ratio.textContent = '';
      ratio.classList.remove('bad');
      warn.hidden = true;
      if (it.check) {
        var res = it.check(r, v);
        ratio.textContent = (res.label || '') + res.ratio.toFixed(1) + ':1';
        /* 有些預設值本來就低於建議門檻（例如亮色的綠 1.4:1），那是使用者看過截圖後
           接受的。這種不必一直標紅；只有調得比預設還差時才警告。 */
        var base = it.check(r0, it.kind === 'num' ? parseFloat(r0.get(it.cssVar)) : it.read(r0));
        var msgs = [];
        if (res.ratio < res.min && res.ratio < base.ratio - 0.05) {
          ratio.classList.add('bad');
          msgs.push('對比 ' + res.ratio.toFixed(1) + ':1 偏低：' + res.msg);
        }
        if (res.extra) msgs.push(res.extra);
        if (msgs.length) { warn.textContent = msgs.join('　'); warn.hidden = false; }
      }
    }

    return { el: el, item: it, refresh: paint };
  }

  /** 主題切換或匯入之後呼叫：重新套用，面板若開著就換成目前的主題 */
  function sync() {
    apply();
    if (drawer) {
      if (drawer.mode !== DB.theme().mode) open();
      else refresh();
    }
  }

  function init() {
    readPresets();
    apply();
  }

  window.Theme = {
    init: init,
    apply: apply,
    sync: sync,
    open: open,
    close: close,
    isOpen: isOpen,
    setUI: setUI,
    applySlot: applySlot,
    applyFactory: applyFactory,
    slotAccent: slotAccent,
    // 給測試用
    _compute: compute,
    _contrast: contrast,
    _parse: parse
  };
})();
