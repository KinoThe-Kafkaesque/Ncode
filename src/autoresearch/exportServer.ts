/**
 * HTTP/SSE export server for the autoresearch browser dashboard.
 *
 * Serves the live experiment state over a small Bun.serve HTTP server so a
 * browser tab can mirror the terminal dashboard while an experiment runs.
 * Routes:
 *   GET /            inline single-file HTML dashboard (dark, monospace)
 *   GET /api/state   JSON snapshot of runtime + experiment state
 *   GET /api/events  SSE stream pushing a state snapshot every 2s
 */

import { getAutoresearchRuntime } from './index.js'
import { buildExperimentState } from './state.js'
import type { AutoresearchRuntime, ExperimentState } from './types.js'

/** Handle returned by `startExportServer`. */
export interface ExportServerHandle {
  url: string
  close: () => void
}

let server: ExportServerHandle | null = null

/**
 * Start the export server on the given port (0 = random free port).
 * Returns a handle with the resolved URL and a `close()` that stops the server.
 * Calling this while a server is already running first stops the previous one.
 */
export function startExportServer(workDir: string, port = 0): ExportServerHandle {
  stopExportServer()

  const httpServer = Bun.serve({
    port,
    fetch(req: Request) {
      const url = new URL(req.url)
      switch (url.pathname) {
        case '/':
          return new Response(DASHBOARD_HTML, {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        case '/api/state':
          return handleState(workDir)
        case '/api/events':
          return handleEvents(workDir, req)
        default:
          return new Response('not found', { status: 404 })
      }
    },
  })

  const handle: ExportServerHandle = {
    url: `http://localhost:${httpServer.port}`,
    close: () => {
      try {
        httpServer.stop()
      } finally {
        if (server === handle) server = null
      }
    },
  }
  server = handle
  return handle
}

/** Stop the running export server, if any. */
export function stopExportServer(): void {
  if (server) {
    server.close()
    server = null
  }
}

// === Route handlers ==========================================================

interface StatePayload {
  runtime: AutoresearchRuntime
  state: ExperimentState
  timestamp: number
}

function handleState(workDir: string): Response {
  try {
    const payload: StatePayload = {
      runtime: getAutoresearchRuntime(),
      state: buildExperimentState(workDir),
      timestamp: Date.now(),
    }
    return new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
    })
  } catch {
    return new Response(JSON.stringify({ error: 'no active session' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

function handleEvents(workDir: string, req: Request): Response {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      let closed = false

      const push = () => {
        if (closed) return
        let chunk: string
        try {
          const payload: StatePayload = {
            runtime: getAutoresearchRuntime(),
            state: buildExperimentState(workDir),
            timestamp: Date.now(),
          }
          chunk = `event: state\ndata: ${JSON.stringify(JSON.stringify(payload))}\n\n`
        } catch {
          chunk = `event: state\ndata: ${JSON.stringify(JSON.stringify({ error: 'no active session' }))}\n\n`
        }
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          clearInterval(timer)
        }
      }

      // Send an immediate snapshot, then every 2s. Assign the timer first so
      // the push() closure can safely clear it if enqueue throws.
      const timer = setInterval(push, 2000)
      push()

      // Abort on client disconnect.
      req.signal?.addEventListener('abort', () => {
        closed = true
        clearInterval(timer)
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
    },
  })

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  })
}

// === Dashboard HTML ==========================================================

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>autoresearch dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #0d1117;
    color: #c9d1d9;
    font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.5;
    padding: 24px;
  }
  h1 { font-size: 18px; margin: 0 0 4px; color: #f0f6fc; }
  .goal { color: #8b949e; margin: 0 0 20px; }
  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }
  .card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 12px 14px;
  }
  .card .label { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .card .value { color: #f0f6fc; font-size: 18px; margin-top: 4px; }
  .value.good { color: #3fb950; }
  .value.bad { color: #f85149; }
  .value.muted { color: #8b949e; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  td.status-keep { color: #3fb950; }
  td.status-discard { color: #8b949e; }
  td.status-crash, td.status-checks_failed { color: #f85149; }
  .flag { color: #d29922; }
  .indicator {
    position: fixed; top: 16px; right: 16px;
    display: flex; align-items: center; gap: 6px;
    color: #8b949e; font-size: 11px;
  }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #3fb950; animation: pulse 1.5s infinite;
  }
  .dot.polling { background: #d29922; }
  .dot.off { background: #6e7681; animation: none; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .error { color: #f85149; }
  .empty { color: #6e7681; font-style: italic; }
  .meta { color: #8b949e; font-size: 11px; margin-top: 16px; }
</style>
</head>
<body>
  <div class="indicator"><span class="dot off" id="dot"></span><span id="ind-text">connecting…</span></div>
  <h1 id="name">autoresearch</h1>
  <p class="goal" id="goal"></p>
  <div class="metrics" id="metrics"></div>
  <table>
    <thead>
      <tr>
        <th>#</th><th>status</th><th>metric</th><th>confidence</th>
        <th>commit</th><th>description</th><th>flags</th>
      </tr>
    </thead>
    <tbody id="runs"></tbody>
  </table>
  <div class="meta" id="meta"></div>

<script>
  var dot = document.getElementById('dot');
  var indText = document.getElementById('ind-text');
  var useSSE = false;

  function fmt(n) {
    if (n === null || n === undefined) return '—';
    if (typeof n !== 'number') return String(n);
    return Math.abs(n) >= 1000 || (n % 1 !== 0) ? n.toFixed(3) : String(n);
  }
  function short(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : (s || ''); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function render(p) {
    if (p.error) {
      document.getElementById('name').textContent = 'autoresearch';
      document.getElementById('goal').textContent = '';
      document.getElementById('metrics').innerHTML = '<div class="card"><div class="label">status</div><div class="value error">' + esc(p.error) + '</div></div>';
      document.getElementById('runs').innerHTML = '';
      document.getElementById('meta').textContent = '';
      return;
    }
    var s = p.state, r = p.runtime;
    document.getElementById('name').textContent = esc(s.name || 'autoresearch');
    document.getElementById('goal').textContent = esc(s.goal || '');

    var baseline = null, best = s.bestMetric;
    for (var i = 0; i < s.results.length; i++) {
      if (s.results[i].runNumber === 0 || s.results[i].runNumber === null && s.results[i].segment === s.currentSegment) {
        if (baseline === null) baseline = s.results[i].metric;
      }
    }
    var improvement = (best !== null && baseline !== null && baseline !== 0)
      ? (((best - baseline) / Math.abs(baseline)) * 100).toFixed(1) + '%' : '—';
    var dirArrow = s.bestDirection === 'lower' ? '↓' : '↑';

    var cards = [
      { label: 'primary metric', value: esc(s.metricName || '—') },
      { label: 'best (' + dirArrow + ')', value: fmt(best), cls: 'good' },
      { label: 'baseline', value: fmt(baseline), cls: 'muted' },
      { label: 'improvement', value: improvement, cls: improvement !== '—' && improvement.charAt(0) !== '-' ? 'good' : 'muted' },
      { label: 'confidence', value: fmt(s.confidence), cls: 'muted' },
      { label: 'runs', value: String(s.results.length) + (s.maxExperiments ? ' / ' + s.maxExperiments : '') },
    ];
    if (r && r.runningExperiment) {
      cards.push({ label: 'running', value: 'since ' + new Date(r.runningExperiment.startedAt).toLocaleTimeString(), cls: 'muted' });
    }
    document.getElementById('metrics').innerHTML = cards.map(function (c) {
      return '<div class="card"><div class="label">' + c.label + '</div><div class="value ' + (c.cls || '') + '">' + c.value + '</div></div>';
    }).join('');

    var rows = s.results.slice().sort(function (a, b) {
      var an = a.runNumber == null ? -1 : a.runNumber;
      var bn = b.runNumber == null ? -1 : b.runNumber;
      return an - bn;
    });
    if (!rows.length) {
      document.getElementById('runs').innerHTML = '<tr><td colspan="7" class="empty">no runs yet</td></tr>';
    } else {
      document.getElementById('runs').innerHTML = rows.map(function (row) {
        var flag = row.flagged ? '<span class="flag" title="' + esc(row.flaggedReason || '') + '">⚑</span>' : '';
        return '<tr>'
          + '<td>' + (row.runNumber == null ? '—' : row.runNumber) + '</td>'
          + '<td class="status-' + row.status + '">' + esc(row.status) + '</td>'
          + '<td>' + fmt(row.metric) + '</td>'
          + '<td>' + fmt(row.confidence) + '</td>'
          + '<td>' + esc(short(row.commit, 8)) + '</td>'
          + '<td>' + esc(short(row.description, 60)) + '</td>'
          + '<td>' + flag + '</td>'
          + '</tr>';
      }).join('');
    }

    var meta = [];
    if (s.branch) meta.push('branch: ' + s.branch);
    if (s.baselineCommit) meta.push('baseline: ' + short(s.baselineCommit, 8));
    if (s.scopePaths && s.scopePaths.length) meta.push('scope: ' + s.scopePaths.length + ' paths');
    if (s.constraints && s.constraints.length) meta.push('constraints: ' + s.constraints.length);
    document.getElementById('meta').textContent = meta.join('  ·  ');
  }

  function setIndicator(state) {
    dot.className = 'dot ' + state;
    indText.textContent = state === 'off' ? 'disconnected' : (useSSE ? 'live (SSE)' : 'live (poll)');
  }

  function fetchState() {
    return fetch('/api/state').then(function (r) { return r.json(); }).then(function (p) {
      render(p);
      if (!useSSE) setIndicator('');
    }).catch(function () { setIndicator('off'); });
  }

  // Try SSE first; fall back to 3s polling.
  function connectSSE() {
    try {
      var es = new EventSource('/api/events');
      es.addEventListener('state', function (e) {
        try {
          var p = JSON.parse(e.data);
          render(p);
          useSSE = true;
          setIndicator('');
        } catch (err) { /* ignore parse error */ }
      });
      es.onerror = function () {
        useSSE = false;
        es.close();
        setIndicator('polling');
        startPolling();
      };
    } catch (e) {
      startPolling();
    }
  }

  var pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(fetchState, 3000);
    fetchState();
  }

  connectSSE();
  fetchState();
</script>
</body>
</html>`
