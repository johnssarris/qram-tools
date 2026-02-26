// Shared utilities for QRAM tools
// Include via: <script src="./libs/qram-utils.js"></script>
// Access via: qramUtils.formatBytes(n), qramUtils.sha256hex(data), etc.
window.qramUtils = (() => {
  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function getTimestampStr() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}`;
  }

  async function sha256hex(data) {
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  /** Trigger a browser download of a Blob. */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Trigger a browser download of a JSON string. */
  function downloadJson(jsonStr, filename) {
    downloadBlob(new Blob([jsonStr], { type: 'application/json' }), filename);
  }

  /**
   * Copy text to clipboard, with execCommand fallback.
   * Optionally updates a button with a "Copied!" confirmation.
   * @param {string} text
   * @param {HTMLElement} [btn]       Button element to update
   * @param {string}      [origLabel] Label to restore after timeout (defaults to btn.textContent)
   * @param {string}      [doneLabel] Confirmation label (default: 'Copied!')
   * @param {number}      [delay]     Restore delay in ms (default: 2500)
   */
  async function copyToClipboard(text, btn, origLabel, doneLabel = 'Copied!', delay = 2500) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    if (btn) {
      const orig = origLabel ?? btn.textContent;
      btn.textContent = doneLabel;
      setTimeout(() => { btn.textContent = orig; }, delay);
    }
  }

  return { formatBytes, getTimestampStr, sha256hex, escapeHtml, downloadBlob, downloadJson, copyToClipboard };
})();
