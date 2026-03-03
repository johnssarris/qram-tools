// Performance profiler for QRAM Tools.
// Activate by appending ?perf=1 to the URL — zero overhead otherwise.
// Include via: <script src="./libs/qram-perf.js"></script>
// Access via: window.qramPerf
//
// API:
//   qramPerf.sessionStart(type, settings) — begin a named transfer session
//   qramPerf.sessionEnd(result)           — close session, log stats, push to history
//   qramPerf.start(label)                 — begin timing a synchronous section
//   qramPerf.end(label)                   — end timing, record sample
//   qramPerf.timeAsync(label, asyncFn)    — time an async function, returns its result
//   qramPerf.report()                     — console.table of all completed sessions
//   qramPerf.download()                   — download JSON of all sessions via qramUtils
//   qramPerf.reset()                      — clear all sessions and current state
//   qramPerf.isEnabled                    — true when ?perf=1 is active
window.qramPerf = (() => {
  const enabled = new URLSearchParams(location.search).get('perf') === '1';

  if (!enabled) {
    const noop = () => {};
    const noopAsync = (_l, fn) => fn();
    return { isEnabled: false, start: noop, end: noop, timeAsync: noopAsync,
             sessionStart: noop, sessionEnd: noop, report: noop, download: noop, reset: noop };
  }

  const MAX_SAMPLES = 1000;   // ring buffer cap per label to bound memory
  const _sessions = [];       // completed: { index, type, startedAt, endedAt, settings, result, durationMs, stats }
  let   _current  = null;     // in-progress: { type, settings, startedAt, startTime, data }
  const _active   = {};       // label → performance.now() start time

  function _bucket(label) {
    if (!_current) return { samples: new Float64Array(MAX_SAMPLES), head: 0, count: 0 };
    return _current.data[label] ??= { samples: new Float64Array(MAX_SAMPLES), head: 0, count: 0 };
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

  function sessionStart(type, settings) {
    _current = { type, settings, startedAt: new Date().toISOString(),
                 startTime: performance.now(), data: {} };
  }

  function sessionEnd(result = {}) {
    if (!_current) return;
    const durationMs = +(performance.now() - _current.startTime).toFixed(1);
    const stats = Object.fromEntries(
      Object.entries(_current.data).map(([k, d]) => [k, _stats(d)])
    );
    const session = {
      index:      _sessions.length + 1,
      type:       _current.type,
      startedAt:  _current.startedAt,
      endedAt:    new Date().toISOString(),
      settings:   _current.settings,
      result,
      durationMs,
      stats,
    };
    _sessions.push(session);
    _current = null;
    console.log(`[qramPerf] Session ${session.index} (${session.type}) — ${durationMs}ms`);
    console.table(stats);
  }

  function report() {
    if (!_sessions.length) { console.log('[qramPerf] No completed sessions yet.'); return; }
    for (const s of _sessions) {
      console.group(`[qramPerf] Session ${s.index} — ${s.type} (${s.durationMs}ms)`);
      console.log('settings:', s.settings);
      console.log('result:',   s.result);
      console.table(s.stats);
      console.groupEnd();
    }
  }

  function download() {
    const json = JSON.stringify({ exportedAt: new Date().toISOString(), sessions: _sessions }, null, 2);
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
    _sessions.length = 0;
    _current = null;
    for (const k of Object.keys(_active)) delete _active[k];
  }

  console.log('[qramPerf] enabled — collecting timing data. Call qramPerf.report() anytime.');
  return { isEnabled: true, start, end, timeAsync, sessionStart, sessionEnd, report, download, reset };
})();
