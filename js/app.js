/* ============================================================
   app.js — 進入點：側欄、卡片區重繪、搜尋、數字鍵複製、選單、彈窗
   ============================================================ */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    currentCategoryId: null,
    search: '',
    hotkeys: {}   // 複製鍵 → 常用語列的對照表，每次重繪都重建
  };

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

  function confirmModal(title, message, okText, onOk, danger) {
    showModal({
      title: title,
      body: '<div style="line-height:1.7;color:var(--text-dim)">' + message + '</div>',
      buttons: [
        { text: '取消', onClick: closeModal },
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

  function renderSidebar() {
    var list = $('categoryList');
    list.innerHTML = '';

    DB.categories().forEach(function (cat) {
      var el = document.createElement('div');
      el.className = 'cat' + (cat.id === state.currentCategoryId ? ' active' : '');
      el.draggable = true;
      el.dataset.catId = cat.id;

      var short = document.createElement('span');
      short.className = 'short';
      short.textContent = cat.shortLabel || cat.name.charAt(0);
      el.appendChild(short);

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = cat.name;
      name.title = cat.name;
      el.appendChild(name);

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
        Array.prototype.forEach.call(
          list.querySelectorAll('.cat'),
          function (x) { x.classList.remove('drop-target'); }
        );
      });
      el.addEventListener('dragover', function (e) {
        e.preventDefault();
        if (dragCatId && dragCatId !== cat.id) el.classList.add('drop-target');
      });
      el.addEventListener('dragleave', function () {
        el.classList.remove('drop-target');
      });
      el.addEventListener('drop', function (e) {
        e.preventDefault();
        el.classList.remove('drop-target');
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
          '將刪除「' + cat.name + '」底下的所有卡片，分類本身會保留。<br><br>此動作無法復原。',
          '確定清除', function () { DB.clearCategory(cat.id); }, true);
      }],
      ['刪除整個分類', function () {
        closeModal();
        confirmModal('刪除分類',
          '將刪除「' + cat.name + '」以及底下的所有卡片。<br><br>此動作無法復原。',
          '確定刪除', function () {
            DB.deleteCategory(cat.id);
            if (state.currentCategoryId === cat.id) state.currentCategoryId = null;
            render();
          }, true);
      }]
    ];

    acts.forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'type-opt';
      b.style.width = '100%';
      b.style.marginBottom = '6px';
      b.textContent = a[0];
      b.addEventListener('click', a[1]);
      wrap.appendChild(b);
    });

    showModal({
      title: '分類：' + cat.name,
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
    urlInput.placeholder = 'https://tw.yahoo.com\nhttps://www.yahoo.com';

    var hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = '只填一條就是一般連結。填多條代表備援網址，每次開啟時隨機挑一條。';

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
      confirmDeletePrivate(tab, '取消加密',
        '「' + (tab.title || '未命名') + '」的內容會改成<strong>明文</strong>存放，' +
        '任何能打開這個瀏覽器的人都看得到，匯出檔裡也會是明文。',
        function () {
          // 驗過身分後仍要真的解開才拿得到明文
          openCard(tab, function () {
            var list = Vault.getPlain(tab.id) || [];
            tab.entries = list;
            tab.encrypted = false;
            tab.enc = null;
            tab.vault = null;
            Vault.lockCard(tab.id);
            DB.touch();
            Clip.toast('已改為不加密');
            render();
          });
        });
      return;
    }

    confirmModal('加上密碼保護',
      '「' + (tab.title || '未命名') + '」的內容會被加密，之後要輸入主密碼才看得到。',
      '繼續', function () {
        tab.encrypted = true;
        var list = tab.entries || [];
        openCard(tab, function () {
          Vault.setPlain(tab.id, list);
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

      Vault.unlockCard(tab.id, tab.vault, key.value, AUTO_LOCK_MINUTES).then(function () {
        return Vault.changePassword(Vault.normalizeRecoveryKey(key.value), p1.value, cards);
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
        err.textContent = '主密碼不正確';
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
  function confirmDeletePrivate(tab, title, message, onOk) {
    // 不加密的卡片沒有東西可驗，走一般確認
    if (!tab || !tab.encrypted || !tab.vault || !Vault.available()) {
      return confirmModal(title, message + '<br><br>此動作無法復原。', '確定刪除', onOk, true);
    }

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
        confirmModal(title, message + '<br><br>此動作無法復原。', '確定刪除', onOk, true);
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

  function clearRowDropMarks() {
    Array.prototype.forEach.call(
      document.querySelectorAll('.qp-row.row-drop-target'),
      function (r) { r.classList.remove('row-drop-target'); }
    );
  }

  function clearDropMarks() {
    Array.prototype.forEach.call(
      document.querySelectorAll('.card.drop-target'),
      function (c) { c.classList.remove('drop-target'); }
    );
  }

  /* ============================================================
     卡片區
     ============================================================ */

  function matchText(s) {
    if (!state.search) return true;
    return (s || '').toLowerCase().indexOf(state.search) >= 0;
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
    if (tab.type === 'note') return matchText(tab.content);
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

  function renderContent() {
    var grid = $('cardGrid');
    grid.innerHTML = '';
    state.hotkeys = {};

    var cat = DB.findCategory(state.currentCategoryId);
    $('currentCategoryName').textContent = cat ? cat.name : '—';
    $('btnAddTab').disabled = !cat;

    if (!cat) {
      $('emptyHint').hidden = false;
      $('emptyHint').textContent = '左邊還沒有分類，點側欄下方的 ＋ 新增一個。';
      return;
    }

    var ctx = {
      matchRow: function (row) {
        if (!state.search) return true;
        return matchText(row.label) || matchText(row.content);
      },
      // 每次重繪都重建對照表，鍵是正規化後的字串（'A'、'ALT+A'）
      registerHotkey: function (key, row, el) {
        state.hotkeys[key] = { row: row, el: el };
      },
      // 所有刪除一律走這裡，確保每個 ✕ 都有二次確認
      confirmDelete: function (title, message, onOk) {
        confirmModal(title, message + '<br><br>此動作無法復原。', '確定刪除', onOk, true);
      },
      // 私人卡片與其中的每一筆，刪除前要先驗主密碼或復原金鑰
      confirmDeletePrivate: confirmDeletePrivate,
      privateEntries: privateEntries,
      setPrivateEntries: setPrivateEntries,
      convertPrivate: convertPrivate,
      togglePin: function (tab) {
        var err = DB.togglePin(tab.id);
        if (err) Clip.toast(err, true);
      },
      attachDrag: attachCardDrag,
      attachRowDrag: attachRowDrag,
      editPhrase: editPhrase,
      editLink: editLink,
      openLinks: openLinks,
      showPopupHelp: function () { showPopupHelp(null); },
      openCard: function (tab) { openCard(tab, null); },
      lockCard: lockCard,
      savePrivate: savePrivate,
      editPrivate: editPrivate
    };

    var tabs = DB.tabsOf(cat.id).filter(matchTab);

    tabs.forEach(function (tab) {
      grid.appendChild(Tabs.renderCard(tab, ctx));
    });

    var hint = $('emptyHint');
    if (!tabs.length) {
      hint.hidden = false;
      hint.textContent = state.search
        ? '沒有符合「' + state.search + '」的內容。'
        : '這個分類還沒有卡片。點右上角「＋ 新增卡片」開始。';
    } else {
      hint.hidden = true;
    }
  }

  function render() {
    var cats = DB.categories();
    if (!state.currentCategoryId || !DB.findCategory(state.currentCategoryId)) {
      state.currentCategoryId = cats.length ? cats[0].id : null;
    }
    $('appTitle').textContent = DB.raw().appTitle || '便籤／常用語';
    renderSidebar();
    renderContent();
  }

  /* ============================================================
     新增卡片
     ============================================================ */

  var TYPES = [
    ['quickphrase', '常用語', '雙欄清單，點一下複製內容'],
    ['note', '便籤', '一段自由文字'],
    ['todo', '待辦清單', '可勾選的任務'],
    ['countdown', '倒數提醒', '顯示距離某天還有幾天'],
    ['link', '連結收藏', '常用網址清單'],
    ['private', '私人', '加密保存，需要主密碼才看得到'],
    ['table', '表格／參考清單', '（尚未實作）']
  ];

  function openAddTab() {
    if (!state.currentCategoryId) return;

    var grid = document.createElement('div');
    grid.className = 'type-grid';

    TYPES.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'type-opt';
      b.innerHTML = '<strong>' + t[1] + '</strong><small>' + t[2] + '</small>';
      if (t[0] === 'table') {
        b.disabled = true;
      } else {
        b.addEventListener('click', function () {
          closeModal();
          if (t[0] === 'private') { askPrivateMode(); return; }
          promptModal('新增' + t[1], '卡片標題', t[1], function (title) {
            DB.addTab(t[0], state.currentCategoryId, title);
          });
        });
      }
      grid.appendChild(b);
    });

    showModal({
      title: '選擇卡片類型',
      body: grid,
      buttons: [{ text: '取消', onClick: closeModal }]
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
      if (t === $('searchBox')) { $('searchBox').value = ''; state.search = ''; render(); }
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

  function handleMenu(act) {
    $('menuPanel').hidden = true;

    if (act === 'export') {
      /* 只有存在「加密」卡片才需要驗身分。全部都是不加密卡片時
         匯出完全不會被打斷——分享給同事的人多半是這種情況。 */
      var locked = DB.raw().tabs.filter(function (t) {
        return t.type === 'private' && t.encrypted && t.vault && !Vault.isCardUnlocked(t.id);
      });
      var doExport = function () {
        DB.saveNow();
        download('便籤資料_' + stamp() + '.json', DB.exportJson());
        Clip.toast('已匯出');
      };
      // 匯出檔裡的加密內容是密文，但仍先驗一次身分才放行
      if (locked.length) confirmDeletePrivate(locked[0], '匯出資料',
        '這份資料裡有加密卡片，匯出前請先確認身分。匯出檔中的加密內容仍然是密文。',
        doExport);
      else doExport();
    }

    if (act === 'import') {
      confirmModal('匯入資料',
        '匯入會<strong>覆蓋目前所有內容</strong>。<br><br>' +
        '建議先做一次「匯出資料」留底再繼續。',
        '選擇檔案', function () { $('importFile').click(); }, true);
    }

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
          '• 點常用語的任一列 → 內容進剪貼簿，到客服系統按 Ctrl+V 貼上<br>' +
          '• 沒有在打字時，按數字鍵 <strong>1～9</strong> 可直接複製對應的第幾條<br>' +
          '• 標題、標籤、內容都是點一下就能改，點別處或按 Esc 結束編輯<br>' +
          '• 多行內容用 Ctrl+Enter 存檔，直接按 Enter 是換行<br><br>' +
          '<strong style="color:var(--text)">目前的資料存在哪</strong><br>' +
          '存在這台電腦的瀏覽器裡。<strong>還沒接上 Google Drive</strong>，' +
          '所以換電腦、或影子系統還原之後資料不會跟著走——' +
          '這個階段請養成用「匯出資料」留底的習慣。<br><br>' +
          '<strong style="color:var(--text)">尚未實作</strong><br>' +
          'Google 登入與雲端同步、鎖定功能、置頂小視窗、表格／參考清單、簡繁互轉。' +
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
    DB.onChange(render);

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

    $('searchBox').addEventListener('input', function (e) {
      state.search = e.target.value.trim().toLowerCase();
      renderContent();
    });

    $('appTitle').addEventListener('click', function () { handleMenu('rename'); });

    $('btnMenu').addEventListener('click', function (e) {
      e.stopPropagation();
      $('menuPanel').hidden = !$('menuPanel').hidden;
    });

    $('menuPanel').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b) handleMenu(b.dataset.act);
    });

    document.addEventListener('click', function (e) {
      if (!$('menuPanel').hidden && !e.target.closest('#menuPanel') && e.target !== $('btnMenu')) {
        $('menuPanel').hidden = true;
      }
    });

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
