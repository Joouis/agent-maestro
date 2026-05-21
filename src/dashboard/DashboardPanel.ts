import * as vscode from "vscode";

import {
  MetricsCollector,
  MetricsSnapshot,
} from "../server/metrics/MetricsCollector";
import { logger } from "../utils/logger";

const REFRESH_MS = 1000;

export class DashboardPanel {
  private static current: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer?: NodeJS.Timeout;

  static show(
    context: vscode.ExtensionContext,
    collector: MetricsCollector,
    proxyUrl: string,
  ) {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "agentMaestroDashboard",
      "Agent Maestro Dashboard",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
      },
    );
    DashboardPanel.current = new DashboardPanel(panel, collector, proxyUrl);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly collector: MetricsCollector,
    private readonly proxyUrl: string,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.renderHtml();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg: { type: string }) => {
        if (msg.type === "reset") {
          this.collector.reset();
          this.push();
        } else if (msg.type === "ready") {
          this.push();
        }
      },
      null,
      this.disposables,
    );

    this.refreshTimer = setInterval(() => this.push(), REFRESH_MS);
  }

  private push() {
    const snapshot = this.collector.snapshot();
    void this.panel.webview.postMessage({
      type: "snapshot",
      snapshot,
    } satisfies { type: "snapshot"; snapshot: MetricsSnapshot });
  }

  private dispose() {
    DashboardPanel.current = undefined;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    while (this.disposables.length) {
      const d = this.disposables.pop();
      try {
        d?.dispose();
      } catch (e) {
        logger.error("Dashboard dispose error:", e as Error);
      }
    }
  }

  private renderHtml(): string {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `style-src 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Agent Maestro Dashboard</title>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border, rgba(128,128,128,0.3));
    --accent: var(--vscode-textLink-foreground);
    --good: #2ea043;
    --warn: #d29922;
    --bad: #f85149;
    --card-bg: var(--vscode-editorWidget-background, rgba(127,127,127,0.06));
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--fg);
    background: var(--bg);
    margin: 0;
    padding: 16px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }
  header h1 { font-size: 18px; margin: 0; }
  header .meta { color: var(--muted); font-size: 12px; }
  button {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--border);
    padding: 4px 10px;
    cursor: pointer;
    border-radius: 4px;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 16px;
  }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
  }
  .card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .card .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
  .card .sub { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .section { margin-bottom: 20px; }
  .section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); margin: 0 0 8px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  td.num, th.num { text-align: center; font-variant-numeric: tabular-nums; }
  .bar { height: 6px; background: var(--accent); border-radius: 3px; }
  .badge { padding: 2px 6px; border-radius: 3px; font-size: 11px; }
  .badge.ok { background: rgba(46,160,67,0.18); color: var(--good); }
  .badge.err { background: rgba(248,81,73,0.18); color: var(--bad); }
  .badge.warn { background: rgba(210,153,34,0.18); color: var(--warn); }
  .table-scroll { max-height: 360px; overflow: auto; }
  .table-scroll thead th { position: sticky; top: 0; background: var(--card-bg); z-index: 1; }
  .recent td { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .empty { color: var(--muted); padding: 16px; text-align: center; font-size: 12px; }
  .pill {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 8px;
    background: rgba(127,127,127,0.18);
    font-size: 10px;
    margin-right: 4px;
  }
  .recent tr.request-row { cursor: pointer; }
  .recent tr.request-row:hover { background: rgba(127,127,127,0.08); }
  .detail-row pre {
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--fg);
  }
  .detail-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .detail-title { color: var(--muted); font-size: 10px; text-transform: uppercase; margin-bottom: 4px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Agent Maestro Dashboard</h1>
    <div class="meta" id="meta">Proxy: ${escapeHtml(this.proxyUrl)}</div>
  </div>
  <div>
    <button id="resetBtn">Reset metrics</button>
  </div>
</header>

<div class="grid">
  <div class="card"><div class="label">Active</div><div class="value" id="kpiActive">0</div><div class="sub">in-flight</div></div>
  <div class="card"><div class="label">Output tokens / sec</div><div class="value" id="kpiTps">—</div><div class="sub">avg (5m)</div></div>
  <div class="card"><div class="label">TTFT</div><div class="value" id="kpiTtft">—</div><div class="sub">avg (5m)</div></div>
  <div class="card"><div class="label">Success rate (5m)</div><div class="value" id="kpiSuccess">—</div><div class="sub" id="kpiSuccessSub">rolling window</div></div>
</div>

<div class="grid">
  <div class="card"><div class="label">Requests (total)</div><div class="value" id="kpiTotal">0</div></div>
  <div class="card"><div class="label">Errors (total)</div><div class="value" id="kpiErrors">0</div></div>
  <div class="card"><div class="label">Input tokens (total)</div><div class="value" id="kpiInput">0</div></div>
  <div class="card"><div class="label">Output tokens (total)</div><div class="value" id="kpiOutput">0</div></div>
</div>

<div class="section">
  <h2>Latency percentiles (5m)</h2>
  <div class="row">
    <div class="card">
      <table>
        <tr><th>P50</th><td class="num" id="p50">—</td></tr>
        <tr><th>P95</th><td class="num" id="p95">—</td></tr>
        <tr><th>P99</th><td class="num" id="p99">—</td></tr>
      </table>
    </div>
    <div class="card">
      <div class="label" style="color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Status codes</div>
      <div id="statusBars"></div>
    </div>
  </div>
</div>

<div class="section">
  <h2>By endpoint</h2>
  <div class="card"><table id="endpointTable">
    <thead><tr><th>Endpoint</th><th class="num">Requests</th><th class="num">Errors</th><th class="num">Input tok</th><th class="num">Output tok</th></tr></thead>
    <tbody></tbody>
  </table></div>
</div>

<div class="section">
  <h2>By model</h2>
  <div class="card"><table id="modelTable">
    <thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Input tok</th><th class="num">Output tok</th></tr></thead>
    <tbody></tbody>
  </table></div>
</div>

<div class="section">
  <h2>Recent requests</h2>
  <div class="card table-scroll"><table class="recent" id="recentTable">
    <thead><tr><th>Time</th><th>Endpoint</th><th>Path</th><th>Status</th><th class="num">Dur ms</th><th class="num">TTFT</th><th class="num">Input</th><th class="num">Output</th><th class="num">out/s</th><th>Model</th></tr></thead>
    <tbody></tbody>
  </table></div>
</div>

<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();

  function fmt(n) { return n === undefined || n === null ? '—' : Number(n).toLocaleString(); }
  function fmtCompact(n) {
    if (n === undefined || n === null) return '—';
    const value = Number(n);
    if (value >= 1_000_000_000) return (value / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
    if (value >= 1_000_000) return (value / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (value >= 1_000) return (value / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    return value.toLocaleString();
  }
  function fmtPct(n) { return (n * 100).toFixed(1) + '%'; }
  function fmtDuration(ms) {
    if (!ms) return '—';
    return ms >= 1000 ? (ms / 1000).toFixed(2).replace(/\.00$/, '') + ' s' : Math.round(ms) + ' ms';
  }
  function badgeForStatus(s) {
    if (s >= 500) return 'err';
    if (s >= 400) return 'warn';
    if (s >= 200) return 'ok';
    return '';
  }

  const expandedRequestIds = new Set();

  function render(snap) {
    document.getElementById('kpiActive').textContent = snap.activeRequests;
    document.getElementById('kpiTps').textContent = snap.rolling.avgTokensPerSecond ? snap.rolling.avgTokensPerSecond.toFixed(1) : '—';
    document.getElementById('kpiTtft').textContent = fmtDuration(snap.rolling.avgTtftMs);
    document.getElementById('kpiSuccess').textContent = snap.rolling.requests ? fmtPct(snap.rolling.successRate) : '—';
    document.getElementById('kpiSuccessSub').textContent = snap.rolling.requests + ' req / ' + snap.rolling.errors + ' err';

    document.getElementById('kpiTotal').textContent = fmt(snap.totals.requests);
    document.getElementById('kpiErrors').textContent = fmt(snap.totals.errors);
    document.getElementById('kpiInput').textContent = fmtCompact(snap.totals.inputTokens);
    document.getElementById('kpiOutput').textContent = fmtCompact(snap.totals.outputTokens);

    document.getElementById('p50').textContent = fmtDuration(snap.rolling.p50DurationMs);
    document.getElementById('p95').textContent = fmtDuration(snap.rolling.p95DurationMs);
    document.getElementById('p99').textContent = fmtDuration(snap.rolling.p99DurationMs);

    const statusEl = document.getElementById('statusBars');
    const total = Object.values(snap.statusCounts).reduce((a,b)=>a+b,0) || 1;
    statusEl.innerHTML = Object.entries(snap.statusCounts).sort().map(([k,v]) => {
      const pct = (v/total)*100;
      const klass = k.startsWith('2') ? 'ok' : k.startsWith('4') ? 'warn' : k.startsWith('5') ? 'err' : '';
      return '<div style="margin-bottom:6px"><span class="badge ' + klass + '">' + k + '</span> <span style="color:var(--muted);font-size:11px">' + v + '</span><div class="bar" style="width:' + pct + '%; margin-top:3px; background: ' + (klass==='err'?'var(--bad)':klass==='warn'?'var(--warn)':'var(--good)') + '"></div></div>';
    }).join('') || '<div class="empty">No data</div>';

    const epBody = document.querySelector('#endpointTable tbody');
    epBody.innerHTML = Object.entries(snap.byEndpoint)
      .filter(([_,v]) => v.requests > 0)
      .map(([k,v]) => '<tr><td>' + k + '</td><td class="num">' + fmt(v.requests) + '</td><td class="num">' + fmt(v.errors) + '</td><td class="num">' + fmtCompact(v.inputTokens) + '</td><td class="num">' + fmtCompact(v.outputTokens) + '</td></tr>')
      .join('') || '<tr><td colspan="5" class="empty">No requests yet</td></tr>';

    const modelBody = document.querySelector('#modelTable tbody');
    const modelEntries = Object.entries(snap.byModel).sort((a,b)=>b[1].requests - a[1].requests);
    modelBody.innerHTML = modelEntries.length
      ? modelEntries.map(([k,v]) => '<tr><td>' + escapeHtml(k) + '</td><td class="num">' + fmt(v.requests) + '</td><td class="num">' + fmtCompact(v.inputTokens) + '</td><td class="num">' + fmtCompact(v.outputTokens) + '</td></tr>').join('')
      : '<tr><td colspan="4" class="empty">No model usage tracked</td></tr>';

    const recentBody = document.querySelector('#recentTable tbody');
    const rows = snap.recent.slice().reverse().slice(0, 50);
    const visibleRequestIds = new Set(rows.map(r => r.id));
    expandedRequestIds.forEach((id) => {
      if (!visibleRequestIds.has(id)) {
        expandedRequestIds.delete(id);
      }
    });
    recentBody.innerHTML = rows.length
      ? rows.map(r => renderRequestRow(r)).join('')
      : '<tr><td colspan="10" class="empty">No requests yet — send a request to your proxy</td></tr>';
  }

  function renderRequestRow(r) {
    const expanded = expandedRequestIds.has(r.id);
    const startedAtTime = new Date(r.startedAt).toLocaleTimeString();
    const badge = badgeForStatus(r.status);
    const detail = {
      id: r.id,
      method: r.method,
      path: r.path,
      endpoint: r.endpoint,
      status: r.status,
      duration: fmtDuration(r.durationMs),
      ttft: r.ttftMs ? fmtDuration(r.ttftMs) : null,
      model: r.model ?? null,
      streaming: r.streaming,
      inputTokens: r.inputTokens ?? null,
      outputTokens: r.outputTokens ?? null,
      error: r.error ?? null,
      requestHeaders: r.details?.requestHeaders ?? {},
      responseHeaders: r.details?.responseHeaders ?? {},
    };
    return '<tr class="request-row" data-request-id="' + escapeHtml(r.id) + '">' +
      '<td>' + startedAtTime + '</td>' +
      '<td>' + r.endpoint + (r.streaming ? ' <span class="pill">stream</span>' : '') + '</td>' +
      '<td>' + escapeHtml(r.path) + '</td>' +
      '<td><span class="badge ' + badge + '">' + r.status + '</span></td>' +
      '<td class="num">' + fmtDuration(r.durationMs) + '</td>' +
      '<td class="num">' + (r.ttftMs ? fmtDuration(r.ttftMs) : '—') + '</td>' +
      '<td class="num">' + (r.inputTokens ? fmtCompact(r.inputTokens) : '—') + '</td>' +
      '<td class="num">' + (r.outputTokens ? fmtCompact(r.outputTokens) : '—') + '</td>' +
      '<td class="num">' + (r.tokensPerSecond ? r.tokensPerSecond.toFixed(1) : '—') + '</td>' +
      '<td>' + (r.model ? escapeHtml(r.model) : '—') + '</td>' +
    '</tr><tr class="detail-row" data-detail-for="' + escapeHtml(r.id) + '"' + (expanded ? '' : ' hidden') + '><td colspan="10"><div class="detail-grid">' +
      '<div><div class="detail-title">Summary</div><pre>' + escapeHtml(JSON.stringify(detail, null, 2)) + '</pre></div>' +
      '<div><div class="detail-title">Safe headers</div><pre>' + escapeHtml(JSON.stringify({ request: detail.requestHeaders, response: detail.responseHeaders }, null, 2)) + '</pre></div>' +
    '</div></td></tr>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'snapshot') render(msg.snapshot);
  });

  document.getElementById('recentTable').addEventListener('click', (event) => {
    const row = event.target.closest('.request-row');
    if (!row) return;
    const requestId = row.dataset.requestId;
    if (!requestId) return;
    if (expandedRequestIds.has(requestId)) {
      expandedRequestIds.delete(requestId);
    } else {
      expandedRequestIds.add(requestId);
    }
    const detail = document.querySelector('[data-detail-for="' + requestId + '"]');
    if (detail) {
      detail.hidden = !expandedRequestIds.has(requestId);
    }
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'reset' });
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
