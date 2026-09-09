/* ============================================================
   vault.js — 加密保管層
   ------------------------------------------------------------
   設計要點：

   1. 主密碼「不直接加密資料」。真正加密資料的是隨機產生的
      資料金鑰（DEK）。主密碼只用來鎖住 DEK。

   2. 【v4.2 起】每張加密卡片各有自己的一把 DEK，各自被包裹兩次：

        卡片 DEK ──用主密碼 + 該卡專屬 salt 包裹──→ tab.vault.pwd
                 └─用主金鑰包裹───────────────────→ tab.vault.rec

      主金鑰（master）存在全域 vault，被主密碼與復原金鑰各包一次。

      重點：**用主密碼解開 A 卡，只推導出 A 卡的包裹金鑰，拿不到主金鑰，
      也就碰不到 B 卡。** 每張卡片各自解鎖、各自計時鎖定。

      舊版是全部卡片共用一把 DEK，只要解開任何一張，其他張的內容在
      主控台上就解得出來——那只是把畫面遮住，不是真的分開。

   3. 復原金鑰是唯一能一次打開全部的路徑（復原金鑰 → 主金鑰 → 任一張卡）。
      那是忘記主密碼時的破窗路徑，本來就該有這個能力。

   4. 明文永遠不寫進 localStorage。解鎖後的內容放在這裡的記憶體 Map，
      鎖定時清空。刻意不掛在 tab 物件上，否則存檔時會被序列化寫進硬碟。

   5. 沒有加密的私人卡片完全不經過這個模組，內容以明文存在 tab.entries。
   ============================================================ */

(function () {
  'use strict';

  var KDF_ITERATIONS = 310000;      // 提高單次嘗試成本，拖慢離線暴力破解
  var RECOVERY_GROUPS = 6;
  var RECOVERY_GROUP_LEN = 4;
  // 去掉 I O 0 1 這些容易抄錯的字
  var RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

  var subtle = (window.crypto && window.crypto.subtle) ? window.crypto.subtle : null;

  var cardKeys = {};       // tabId → 該卡片的 DEK，只在解鎖期間存在
  var plain = {};          // tabId → 明文陣列，只存在記憶體
  var timers = {};         // tabId → 自動鎖定計時器，各卡片分開計時
  var onLockCallback = null;

  /* ---------- 編碼工具 ---------- */

  function toB64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function fromB64(b64) {
    var s = atob(b64), bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  function randomBytes(n) {
    return window.crypto.getRandomValues(new Uint8Array(n));
  }

  function utf8(str) { return new TextEncoder().encode(str); }
  function fromUtf8(buf) { return new TextDecoder().decode(buf); }

  /* ---------- 金鑰推導與包裹 ---------- */

  function deriveKey(password, salt) {
    return subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return subtle.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['wrapKey', 'unwrapKey']
        );
      });
  }

  /* 主金鑰是拿來「包裹別的金鑰」的，卡片 DEK 是拿來「加解密內容」的，
     兩者的 usages 不同。WebCrypto 對此很嚴格，給錯會在 wrapKey 當下才報錯。 */
  var DATA_USAGES = ['encrypt', 'decrypt'];
  var WRAP_USAGES = ['wrapKey', 'unwrapKey'];

  function newKey(usages) {
    return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, usages);
  }

  /** 用密碼推導出的金鑰包裹一把 DEK。每次都用新的隨機 salt 與 iv。 */
  function wrapWithPassword(key, password) {
    var salt = randomBytes(16);
    var iv = randomBytes(12);
    return deriveKey(password, salt).then(function (wrapper) {
      return subtle.wrapKey('raw', key, wrapper, { name: 'AES-GCM', iv: iv });
    }).then(function (wrapped) {
      return { salt: toB64(salt), iv: toB64(iv), key: toB64(wrapped) };
    });
  }

  /**
   * 用密碼解開包裹。密碼錯誤時 AES-GCM 的驗證會失敗並丟出例外，
   * 所以不需要另外存一份「驗證用」的資料。
   */
  function unwrapWithPassword(blob, password, usages) {
    return deriveKey(password, fromB64(blob.salt)).then(function (wrapper) {
      return subtle.unwrapKey(
        'raw', fromB64(blob.key), wrapper,
        { name: 'AES-GCM', iv: fromB64(blob.iv) },
        { name: 'AES-GCM', length: 256 },
        true,
        usages || DATA_USAGES
      );
    });
  }

  /** 直接用另一把 AES 金鑰（主金鑰）包裹，不經過密碼推導。 */
  function wrapWithKey(key, wrapper) {
    var iv = randomBytes(12);
    return subtle.wrapKey('raw', key, wrapper, { name: 'AES-GCM', iv: iv })
      .then(function (wrapped) {
        return { iv: toB64(iv), key: toB64(wrapped) };
      });
  }

  function unwrapWithKey(blob, wrapper) {
    return subtle.unwrapKey(
      'raw', fromB64(blob.key), wrapper,
      { name: 'AES-GCM', iv: fromB64(blob.iv) },
      { name: 'AES-GCM', length: 256 },
      true,
      DATA_USAGES
    );
  }

  /* ---------- 復原金鑰 ---------- */

  function makeRecoveryKey() {
    var bytes = randomBytes(RECOVERY_GROUPS * RECOVERY_GROUP_LEN);
    var out = [], n = 0;
    for (var g = 0; g < RECOVERY_GROUPS; g++) {
      var group = '';
      for (var i = 0; i < RECOVERY_GROUP_LEN; i++) {
        group += RECOVERY_ALPHABET[bytes[n++] % RECOVERY_ALPHABET.length];
      }
      out.push(group);
    }
    return out.join('-');
  }

  /** 抄寫時的大小寫、空格、有沒有連字號都不該影響結果。 */
  function normalizeRecoveryKey(s) {
    return String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  }

  /* ---------- 自動鎖定（每張卡片分開計時） ---------- */

  /**
   * 解鎖後固定 N 分鐘就鎖，計時不因操作重置——使用者選的嚴格模式。
   * 各卡片各自計時，互不影響。
   */
  function startTimer(tabId, minutes) {
    clearTimer(tabId);
    timers[tabId] = setTimeout(function () {
      lockCard(tabId);
      if (onLockCallback) onLockCallback(tabId, 'auto');
    }, minutes * 60000);
  }

  function clearTimer(tabId) {
    if (timers[tabId]) { clearTimeout(timers[tabId]); delete timers[tabId]; }
  }

  /* ---------- 主金鑰 ---------- */

  function available() { return !!subtle; }

  function masterExists() {
    var v = DB.raw().vault;
    return !!(v && v.pwd && v.rec);
  }

  /**
   * 取得主金鑰。呼叫端拿到之後要盡快用完丟掉，不要留在模組層級——
   * 主金鑰能開任何一張卡片，留著就等於所有卡片一起解鎖。
   */
  function getMasterKey(secret) {
    var v = DB.raw().vault;
    if (!v) return Promise.reject(new Error('尚未建立'));
    return unwrapWithPassword(v.pwd, secret, WRAP_USAGES).catch(function () {
      return unwrapWithPassword(v.rec, normalizeRecoveryKey(secret), WRAP_USAGES);
    });
  }

  /** 第一次使用時建立主金鑰。回傳復原金鑰，只在這一刻出現一次。 */
  function setupMaster(password) {
    if (!subtle) return Promise.reject(new Error('這個環境不支援加密'));
    var recovery = makeRecoveryKey();
    return newKey(WRAP_USAGES).then(function (master) {
      return Promise.all([
        wrapWithPassword(master, password),
        wrapWithPassword(master, normalizeRecoveryKey(recovery))
      ]);
    }).then(function (pair) {
      DB.raw().vault = { v: 2, iterations: KDF_ITERATIONS, pwd: pair[0], rec: pair[1] };
      DB.touch();
      return recovery;
    });
  }

  /* ---------- 單張卡片 ---------- */

  /**
   * 幫一張卡片建立自己的 DEK 與兩個包裹，並直接進入解鎖狀態。
   * 需要主密碼：一個包裹用它推導，另一個包裹要用主金鑰，而主金鑰靠它取出。
   * 用完就把主金鑰丟掉。
   */
  function createCard(tabId, password, autoLockMinutes) {
    if (!subtle) return Promise.reject(new Error('這個環境不支援加密'));
    var cardDek;
    return newKey(DATA_USAGES).then(function (k) {
      cardDek = k;
      return getMasterKey(password);
    }).then(function (master) {
      return Promise.all([
        wrapWithPassword(cardDek, password),
        wrapWithKey(cardDek, master)
      ]);
    }).then(function (pair) {
      cardKeys[tabId] = cardDek;
      startTimer(tabId, autoLockMinutes);
      return { pwd: pair[0], rec: pair[1] };
    });
  }

  /**
   * 解開一張卡片。
   *
   * 先試該卡片自己的密碼包裹——這條路只推導出這張卡的金鑰，拿不到主金鑰，
   * 所以其他卡片仍然鎖著。失敗才退到復原金鑰 → 主金鑰 → 這張卡的 rec 包裹。
   */
  function unlockCard(tabId, tabVault, secret, autoLockMinutes) {
    if (!subtle) return Promise.reject(new Error('這個環境不支援加密'));
    if (!tabVault) return Promise.reject(new Error('這張卡片沒有加密設定'));

    return unwrapWithPassword(tabVault.pwd, secret).catch(function () {
      return getMasterKey(secret).then(function (master) {
        return unwrapWithKey(tabVault.rec, master);
      });
    }).then(function (k) {
      cardKeys[tabId] = k;
      startTimer(tabId, autoLockMinutes);
      return true;
    });
  }

  /**
   * 只驗證，不解鎖。刪除整張卡片或其中一筆時用。
   * 解開的金鑰立刻丟掉，不寫進 cardKeys、不碰明文快取、不啟動計時器，
   * 所以驗證完卡片維持原本的鎖定狀態。
   */
  function verifyCard(tabVault, secret) {
    if (!subtle) return Promise.reject(new Error('這個環境不支援加密'));
    if (!tabVault) return Promise.resolve(true);
    return unwrapWithPassword(tabVault.pwd, secret).then(
      function () { return true; },
      function () {
        return getMasterKey(secret).then(function (master) {
          return unwrapWithKey(tabVault.rec, master).then(function () { return true; });
        });
      }
    );
  }

  function isCardUnlocked(tabId) { return !!cardKeys[tabId]; }

  function lockCard(tabId) {
    delete cardKeys[tabId];
    delete plain[tabId];
    clearTimer(tabId);
  }

  function lockAll() {
    Object.keys(timers).forEach(clearTimer);
    cardKeys = {};
    plain = {};
  }

  function onLock(fn) { onLockCallback = fn; }

  /* ---------- 加解密 ---------- */

  function encryptFor(tabId, value) {
    var k = cardKeys[tabId];
    if (!k) return Promise.reject(new Error('尚未解鎖'));
    var iv = randomBytes(12);
    return subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, utf8(JSON.stringify(value)))
      .then(function (buf) {
        return { iv: toB64(iv), data: toB64(buf) };
      });
  }

  function decryptFor(tabId, blob) {
    var k = cardKeys[tabId];
    if (!k) return Promise.reject(new Error('尚未解鎖'));
    if (!blob || !blob.data) return Promise.resolve([]);
    return subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, k, fromB64(blob.data))
      .then(function (buf) {
        return JSON.parse(fromUtf8(buf));
      });
  }

  /**
   * 把一張已解鎖卡片的明文交出來重新加密用。
   * 轉成不加密卡片時需要，轉回加密時則由 encryptFor 處理。
   */
  function detachCard(tabId) {
    var entries = plain[tabId] || null;
    lockCard(tabId);
    return entries;
  }

  /* ---------- 換主密碼 ---------- */

  /**
   * 換主密碼要重新包裹主金鑰與「每一張」加密卡片的密碼包裹。
   * 內容本身一個位元組都不用重新加密——這正是「密碼不直接加密資料」
   * 換來的好處。
   *
   * cards 是 [{ id, vault }]，由呼叫端從資料層撈出來。
   * 回傳 { master, <tabId>: blob... }，由呼叫端寫回。
   */
  function changePassword(oldPassword, newPassword, cards) {
    if (!subtle) return Promise.reject(new Error('這個環境不支援加密'));
    var out = {};
    return getMasterKey(oldPassword).then(function (master) {
      return wrapWithPassword(master, newPassword);
    }).then(function (blob) {
      out.master = blob;
      return (cards || []).reduce(function (chain, c) {
        return chain.then(function () {
          if (!c.vault) return null;
          return unwrapWithPassword(c.vault.pwd, oldPassword)
            .then(function (k) { return wrapWithPassword(k, newPassword); })
            .then(function (b) { out[c.id] = b; });
        });
      }, Promise.resolve());
    }).then(function () { return out; });
  }

  /* ---------- 明文暫存（只在記憶體） ---------- */

  function getPlain(tabId) { return plain[tabId] || null; }
  function setPlain(tabId, entries) { plain[tabId] = entries; }

  /** 主密碼與復原金鑰都遺失時的唯一出路：把加密的卡片全部清掉重來。 */
  function reset() {
    lockAll();
    var data = DB.raw();
    delete data.vault;
    data.tabs = data.tabs.filter(function (t) {
      return !(t.type === 'private' && t.encrypted);
    });
    DB.touch();
  }

  window.Vault = {
    available: available,
    masterExists: masterExists,
    setupMaster: setupMaster,
    createCard: createCard,
    unlockCard: unlockCard,
    verifyCard: verifyCard,
    isCardUnlocked: isCardUnlocked,
    lockCard: lockCard,
    lockAll: lockAll,
    detachCard: detachCard,
    onLock: onLock,
    encryptFor: encryptFor,
    decryptFor: decryptFor,
    changePassword: changePassword,
    getPlain: getPlain,
    setPlain: setPlain,
    reset: reset,
    makeRecoveryKey: makeRecoveryKey,
    normalizeRecoveryKey: normalizeRecoveryKey
  };
})();
