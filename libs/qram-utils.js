// Shared utilities for QRAM tools
// Include via: <script src="./libs/qram-utils.js"></script>
// Access via: qramUtils.formatBytes(n)
window.qramUtils = (() => {
  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  return { formatBytes };
})();
