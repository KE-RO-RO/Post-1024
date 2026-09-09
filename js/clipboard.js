/* ============================================================
   clipboard.js — 複製到剪貼簿 + 視覺回饋
   ------------------------------------------------------------
   這是整個瀏覽器版取代桌面版「熱鍵發送」的核心機制。
   複製成功後由使用者自行按 Ctrl+V 貼到客服系統（網頁版或桌面版都可以，
   因為剪貼簿是作業系統層級的）。
   ============================================================ */

(function () {
  'use strict';

  var toastEl = null;
  var toastTimer = null;

  function toast(msg, isError) {
    if (!toastEl) toastEl = document.getElementById('toast');
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = isError ? 'err' : '';
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 1600);
  }

  /**
   * 舊版備援路徑。
   * navigator.clipboard 需要安全內容環境（HTTPS 或 localhost），
   * 如果使用者是直接用檔案總管點開 index.html（file://），
   * 新版 API 可能不給用，這時候退回 execCommand。
   */
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // 放在畫面外，但不能用 display:none，那樣選取不到內容
    ta.style.position = 'fixed';
    ta.style.top = '-2000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  /**
   * 複製文字。
   * @param {string} text  要複製的內容
   * @param {Element} el   複製成功時要短暫變色的元素（可省略）
   * @param {string} label 提示訊息裡顯示的名稱（可省略）
   */
  function copy(text, el, label) {
    if (!text) {
      toast('這一條沒有內容可以複製', true);
      return;
    }

    function success() {
      toast(label ? '已複製：' + label : '已複製');
      if (el) {
        el.classList.add('copied');
        setTimeout(function () { el.classList.remove('copied'); }, 600);
      }
    }

    function failed(reason) {
      toast('複製失敗' + (reason ? '：' + reason : ''), true);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(success, function (err) {
        // 常見失敗原因是文件沒有焦點，這時候備援路徑通常還是能成功
        if (legacyCopy(text)) success();
        else failed(err && err.message);
      });
    } else {
      if (legacyCopy(text)) success();
      else failed('這個瀏覽器不支援，或需要 HTTPS');
    }
  }

  window.Clip = { copy: copy, toast: toast };
})();
