// Performance profiler for QRAM Tools.
// Activate by appending ?perf=1 to the URL — zero overhead otherwise.
// Include via: <script src="./libs/qram-perf.js"></script>
// Access via: window.qramPerf
//
// API:
//   qramPerf.start(label)              — begin timing a synchronous section
//   qramPerf.end(label)                — end timing, record sample
//   qramPerf.timeAsync(label, asyncFn) — time an async function, returns its result
//   qramPerf.report()                  — console.table of calls/min/mean/p50/p95/p99/max
//   qramPerf.download()                — download JSON report via qramUtils.downloadJson
//   qramPerf.reset()                   — clear all collected samples
//   qramPerf.isEnabled                 — true when ?perf=1 is active
window.qramPerf = (() => {
  const enabled = new URLSearchParams(location.search).get('perf') === '1';

  if (!enabled) {
    const noop = () => {};
    const noopAsync = (_label, fn) => fn();
    return { isEnabled: false, start: noop, end: noop, timeAsync: noopAsync, report: noop, download: noop, reset: noop };
  }

  const MAX_SAMPLES = 1000;   // ring buffer cap per label to bound memory use
  const _data   = {};         // { label: { samples: Float64Array, head, count } }
  const _active = {};         // { label: startTime (performance.now) }

  function _bucket(label) {
    return _data[label] ??= { samples: new Float64Array(MAX_SAMPLES), head: 0, count: 0 };
  }

  function start(label) {
    _active[label] = performance.now();
  }

  function end(label) {
    const t = _active[label];
    if (t === undefined) return;
    const elapsed = performance.now() - t;
    delete _active[label];
    const d = _bucket(label);
    d.samples[d.head % MAX_SAMPLES] = elapsed;
    d.head++;
    d.count++;
  }

  async function timeAsync(label, fn) {
    start(label);
    try   { return await fn(); }
    finally { end(label); }
  }

  function _stats(d) {
    const n = Math.min(d.count, MAX_SAMPLES);
    if (!n) return null;
    const s = d.samples.slice(0, n).sort();
    const sum = s.reduce((a, b) => a + b, 0);
    const r = v => +v.toFixed(3);
    return {
      calls: d.count,
      min:   r(s[0]),
      mean:  r(sum / n),
      p50:   r(s[Math.floor(n * 0.50)]),
      p95:   r(s[Math.floor(n * 0.95)]),
      p99:   r(s[Math.floor(n * 0.99)]),
      max:   r(s[n - 1]),
    };
  }

  function report() {
    const rows = Object.fromEntries(
      Object.entries(_data).map(([k, d]) => [k, _stats(d)])
    );
    console.log('[qramPerf] Performance Report (all times in ms)');
    console.table(rows);
    return rows;
  }

  function download() {
    const rows = Object.fromEntries(
      Object.entries(_data).map(([k, d]) => [k, _stats(d)])
    );
    const json = JSON.stringify({ timestamp: new Date().toISOString(), stats: rows }, null, 2);
    const ts   = window.qramUtils?.getTimestampStr?.() ?? Date.now();
    if (window.qramUtils?.downloadJson) {
      qramUtils.downloadJson(json, `qram-perf-${ts}.json`);
    } else {
      const a = document.createElement('a');
      a.href = 'data:application/json,' + encodeURIComponent(json);
      a.download = `qram-perf-${ts}.json`;
      a.click();
    }
  }

  function reset() {
    for (const k of Object.keys(_data))   delete _data[k];
    for (const k of Object.keys(_active)) delete _active[k];
  }

  console.log('[qramPerf] enabled — collecting timing data. Call qramPerf.report() anytime.');
  return { isEnabled: true, start, end, timeAsync, report, download, reset };
})();
