/* ============================================================
   vault.js — 加密保管層
   ------------------------------------------------------------
   設計要點：

   1. 主密碼「不直接加密資料」。真正加密資料的是一把隨機產生的
      資料金鑰（DEK）。主密碼只用來鎖住這把 DEK。

   2. 同一把 DEK 被鎖兩次：一次用主密碼、一次用復原金鑰。
      兩把鑰匙開同一個保險箱，所以忘記主密碼時可以用復原金鑰
      解開、重設新主密碼，而資料完全不必重新加密。

   3. 明文永遠不寫進 localStorage。解鎖後的內容放在這裡的
      記憶體 Map，鎖定時清空。刻意不掛在 tab 物件上，
      否則存檔時會被一起序列化寫進硬碟。

   4. crypto.subtle 只在安全環境（HTTPS / localhost）存在。
      用檔案總管直接開的 file:// 沒有這個 API，這個模組會停用。
   ============================================================ */

(function () {
  'use strict';

  var KDF_ITERATIONS = 310000;      // 提高單次嘗試成本，拖慢離線暴力破解
  var RECOVERY_GROUPS = 6;
  var RECOVERY_GROUP_LEN = 4;
  // 去掉 I O 0 1 這些容易抄錯的字
  var RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

  var subtle = (window.crypto && window.crypto.subtle) ? window.crypto.subtle : null;

  var dek = null;          // 解鎖後的資料金鑰，鎖定時設回 null
  var plain = {};          // tabId → 明文陣列，只存在記憶體
  var lockTimer = null;
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

  /* ---------- 金鑰推導 ---------- */

  /** 用密碼字串推導出一把用來包裹 DEK 的金鑰。 */
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

  /** 用某個密碼把 DEK 包起來，回傳可以直接存進 JSON 的結構。 */
  function wrapDek(key, password) {
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
  function unwrapDek(blob, password) {
    return deriveKey(password, fromB64(blob.salt)).then(function (wrapper) {
      return subtle.unwrapKey(
        'raw', fromB64(blob.key), wrapper,
        { name: 'AES-GCM', iv: fromB64(blob.iv) },
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );
    });
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

  /* ---------- 自動鎖定 ---------- */

  /**
   * 解鎖後固定 N 分鐘就鎖，計時不會因為操作而重置——
   * 這是使用者選的「嚴格」模式。
   */
  function startLockTimer(minutes) {
    clearLockTimer();
    lockTimer = setTimeout(function () {
      lock();
      if (onLockCallback) onLockCallback('auto');
    }, minutes * 60000);
  }

  function clearLockTimer() {
    if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
  }

  /* ---------- 對外 ---------- */

  function available() { return !!subtle; }

  function exists() {
    var v = DB.raw().vault;
    return !!(v && v.pwd && v.rec);
  }

  function isUnlocked() { return !!dek; }

  /** 建立保管層。回傳復原金鑰，只在這一刻出現一次。 */
  function setup(password, autoLockMinutes) {
    if (!subtle) return Promise.reject(new Error('這個環境不支援加密'));
    var recovery = makeRecoveryKey();
    var key;

    return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
      .then(function (k) {
        key = k;
        return Promise.all([
          wrapDek(k, password),
          wrapDek(k, normalizeRecoveryKey(recovery))
        ]);
      })
      .then(function (pair) {
        DB.raw().vault = { v: 1, iterations: KDF_ITERATIONS, pwd: pair[0], rec: pair[1] };
        dek = key;
        startLockTimer(autoLockMinutes);
        DB.touch();
        return recovery;
      });
  }

  function unlock(password, autoLockMinutes) {
    if (!subtle) return Promise.reject(new Error('這個環境不支援加密'));
    var v = DB.raw().vault;
    if (!v) return Promise.reject(new Error('尚未建立'));
    return unwrapDek(v.pwd, password).then(function (k) {
      dek = k;
      startLockTimer(autoLockMinutes);
      return true;
    });
  }

  function unlockWithRecovery(recoveryKey, autoLockMinutes) {
    if (!subtle) return Promise.reject(new Error('這個環境不支援加密'));
    var v = DB.raw().vault;
    if (!v) return Promise.reject(new Error('尚未建立'));
    return unwrapDek(v.rec, normalizeRecoveryKey(recoveryKey)).then(function (k) {
      dek = k;
      startLockTimer(autoLockMinutes);
      return true;
    });
  }

  /**
   * 換主密碼。只重新包裹 DEK，既有內容一個位元組都不用動——
   * 這正是「密碼不直接加密資料」這個設計換來的好處。
   */
  function changePassword(newPassword) {
    if (!dek) return Promise.reject(new Error('尚未解鎖'));
    return wrapDek(dek, newPassword).then(function (blob) {
      DB.raw().vault.pwd = blob;
      DB.touch();
      return true;
    });
  }

  function lock() {
    dek = null;
    plain = {};
    clearLockTimer();
  }

  function onLock(fn) { onLockCallback = fn; }

  /** 加密一段 JSON 可序列化的資料。 */
  function encrypt(value) {
    if (!dek) return Promise.reject(new Error('尚未解鎖'));
    var iv = randomBytes(12);
    return subtle.encrypt({ name: 'AES-GCM', iv: iv }, dek, utf8(JSON.stringify(value)))
      .then(function (buf) {
        return { iv: toB64(iv), data: toB64(buf) };
      });
  }

  function decrypt(blob) {
    if (!dek) return Promise.reject(new Error('尚未解鎖'));
    if (!blob || !blob.data) return Promise.resolve([]);
    return subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, dek, fromB64(blob.data))
      .then(function (buf) {
        return JSON.parse(fromUtf8(buf));
      });
  }

  /* ---------- 明文暫存（只在記憶體） ---------- */

  function getPlain(tabId) { return plain[tabId] || null; }
  function setPlain(tabId, entries) { plain[tabId] = entries; }

  /** 主密碼與復原金鑰都遺失時的唯一出路：全部清掉重來。 */
  function reset() {
    lock();
    var data = DB.raw();
    delete data.vault;
    data.tabs = data.tabs.filter(function (t) { return t.type !== 'private'; });
    DB.touch();
  }

  window.Vault = {
    available: available,
    exists: exists,
    isUnlocked: isUnlocked,
    setup: setup,
    unlock: unlock,
    unlockWithRecovery: unlockWithRecovery,
    changePassword: changePassword,
    lock: lock,
    onLock: onLock,
    encrypt: encrypt,
    decrypt: decrypt,
    getPlain: getPlain,
    setPlain: setPlain,
    reset: reset,
    makeRecoveryKey: makeRecoveryKey,
    normalizeRecoveryKey: normalizeRecoveryKey
  };
})();
