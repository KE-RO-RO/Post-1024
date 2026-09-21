/* ============================================================
   clipboard.js — 複製到剪貼簿 + 視覺回饋
   ------------------------------------------------------------
   這是整個瀏覽器版取代桌面版「熱鍵發送」的核心機制。
   複製成功後由使用者自行按 Ctrl+V 貼到要用的程式（網頁版或桌面版都可以，
   因為剪貼簿是作業系統層級的）。
   ============================================================ */

(function () {
  'use strict';

  /* 置頂小視窗（Document PiP）是另一份文件，有自己的 body 與焦點狀態。
     複製與提示都必須發生在「使用者正在看的那份文件」上：
     主視窗沒有焦點時，navigator.clipboard 會被拒絕，execCommand 的暫存欄位
     也選取不到；提示跑到主視窗更是完全看不到。
     所以下面每一個函式都接受 doc，沒給就從事件元素身上推。 */

  function docOf(el, doc) {
    return doc || (el && el.ownerDocument) || document;
  }

  function toast(msg, isError, doc) {
    var el = docOf(null, doc).getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = isError ? 'err' : '';
    el.hidden = false;
    if (el.toastTimer) clearTimeout(el.toastTimer);
    // 計時器掛在元素上，每份文件各自一個，不會互相取消
    el.toastTimer = setTimeout(function () { el.hidden = true; }, 1600);
  }

  /**
   * 舊版備援路徑。
   * navigator.clipboard 需要安全內容環境（HTTPS 或 localhost），
   * 如果使用者是直接用檔案總管點開 index.html（file://），
   * 新版 API 可能不給用，這時候退回 execCommand。
   */
  function legacyCopy(text, doc) {
    doc = doc || document;
    var ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // 放在畫面外，但不能用 display:none，那樣選取不到內容
    ta.style.position = 'fixed';
    ta.style.top = '-2000px';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    var ok = false;
    try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
    doc.body.removeChild(ta);
    return ok;
  }

  /**
   * 複製文字。
   * @param {string} text  要複製的內容
   * @param {Element} el   複製成功時要短暫變色的元素（可省略）
   * @param {string} label 提示訊息裡顯示的名稱（可省略）
   */
  function copy(text, el, label, doc) {
    doc = docOf(el, doc);
    if (!text) {
      toast('這一條沒有內容可以複製', true, doc);
      return;
    }

    function success() {
      toast(label ? '已複製：' + label : '已複製', false, doc);
      if (el) {
        el.classList.add('copied');
        setTimeout(function () { el.classList.remove('copied'); }, 600);
      }
    }

    function failed(reason) {
      toast('複製失敗' + (reason ? '：' + reason : ''), true, doc);
    }

    var nav = (doc.defaultView && doc.defaultView.navigator) || navigator;

    if (nav.clipboard && nav.clipboard.writeText) {
      nav.clipboard.writeText(text).then(success, function (err) {
        // 常見失敗原因是文件沒有焦點，這時候備援路徑通常還是能成功
        if (legacyCopy(text, doc)) success();
        else failed(err && err.message);
      });
    } else {
      if (legacyCopy(text, doc)) success();
      else failed('這個瀏覽器不支援，或需要 HTTPS');
    }
  }

  window.Clip = { copy: copy, toast: toast };
})();
