/**
 * The /admin dashboard, served as one self-contained document: inline CSS,
 * inline SVG charts, no external requests and no third-party script. Modelled
 * on landing.ts, which vendors its assets the same way.
 *
 * Charts are hand-rolled SVG rather than a charting library, so `ws` stays the
 * only production dependency.
 *
 * Colours are the validated categorical palette (8 slots, both modes checked
 * for lightness band, chroma floor, CVD separation and normal-vision floor).
 * Three light-mode slots sit below 3:1 against the light surface, so the
 * relief rule applies: every chart ships a legend, series are directly
 * labelled, and a table view is one click away.
 */
export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Relay admin</title>
<style>
:root {
  color-scheme: light;
  --surface-1: #fcfcfb;
  --page: #f9f9f7;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #898781;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11,11,11,0.10);
  --good: #0ca30c;
  --warning: #fab219;
  --critical: #d03b3b;
  --series-1: #2a78d6;
  --series-2: #eb6834;
  --series-3: #1baf7a;
  --series-4: #eda100;
  --series-5: #e87ba4;
  --series-6: #008300;
  --series-7: #4a3aa7;
  --series-8: #e34948;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --page: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --border: rgba(255,255,255,0.10);
    --series-1: #3987e5;
    --series-2: #d95926;
    --series-3: #199e70;
    --series-4: #c98500;
    --series-5: #d55181;
    --series-6: #008300;
    --series-7: #9085e9;
    --series-8: #e66767;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--page);
  color: var(--text-primary);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.5;
}
.wrap { max-width: 1180px; margin: 0 auto; padding: 24px 20px 64px; }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; justify-content: space-between; margin-bottom: 4px; }
h1 { font-size: 20px; margin: 0; font-weight: 600; }
.sub { color: var(--text-secondary); font-size: 13px; margin: 0 0 20px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 20px; }
button {
  font: inherit; font-size: 13px; color: var(--text-secondary);
  background: var(--surface-1); border: 1px solid var(--border);
  border-radius: 7px; padding: 5px 11px; cursor: pointer;
}
button:hover { color: var(--text-primary); }
button[aria-pressed="true"] { background: var(--series-1); border-color: var(--series-1); color: #fff; }
.spacer { flex: 1 1 auto; }
.status { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--good); flex: none; }
.dot.paused { background: var(--warning); }
.dot.bad { background: var(--critical); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 22px; }
.tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 11px 13px; }
.tile .label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); }
.tile .value { font-size: 23px; font-weight: 600; margin-top: 2px; }
.tile .note { font-size: 11px; color: var(--text-muted); }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(430px, 1fr)); gap: 14px; }
.card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 14px 15px 10px; }
.card h2 { font-size: 13px; margin: 0 0 1px; font-weight: 600; }
.card .hint { font-size: 11px; color: var(--text-muted); margin: 0 0 8px; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 6px; font-size: 12px; color: var(--text-secondary); }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
.plot { position: relative; }
svg { display: block; width: 100%; height: auto; overflow: visible; }
.tip {
  position: absolute; pointer-events: none; opacity: 0; transition: opacity .1s;
  background: var(--surface-1); border: 1px solid var(--border); border-radius: 7px;
  padding: 6px 9px; font-size: 12px; white-space: nowrap; z-index: 5;
  box-shadow: 0 2px 10px rgba(0,0,0,.14); color: var(--text-primary);
}
.tip .when { color: var(--text-muted); margin-bottom: 3px; }
.tip div span { color: var(--text-secondary); }
.empty { color: var(--text-muted); font-size: 12px; padding: 24px 0; text-align: center; }
table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 4px 7px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th { color: var(--text-muted); font-weight: 500; }
.tablewrap { overflow-x: auto; max-height: 460px; overflow-y: auto; }
.banner {
  background: var(--surface-1); border: 1px solid var(--border); border-left: 3px solid var(--warning);
  border-radius: 8px; padding: 9px 13px; font-size: 12px; color: var(--text-secondary); margin-bottom: 16px;
}
.links { margin-top: 26px; font-size: 12px; color: var(--text-muted); }
.links a { color: var(--text-secondary); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Relay admin</h1>
    <div class="status"><span class="dot" id="dot"></span><span id="statusText">connecting</span></div>
  </header>
  <p class="sub">Aggregate counters only. This surface carries no slot ids, no IP addresses and no traffic content, so it cannot show a session list.</p>

  <div id="banners"></div>

  <div class="controls">
    <span style="font-size:12px;color:var(--text-muted)">Range</span>
    <button data-range="3600000">1h</button>
    <button data-range="21600000">6h</button>
    <button data-range="172800000">48h</button>
    <button data-range="2592000000">30d</button>
    <button data-range="31536000000">1y</button>
    <span class="spacer"></span>
    <button id="tableToggle" aria-pressed="false">Table view</button>
  </div>

  <div class="tiles" id="tiles"></div>
  <div class="grid2" id="charts"></div>
  <div id="tableView" hidden></div>

  <p class="links">
    Host CPU, disk, bandwidth and egress billing live in the Hetzner console; edge requests, WebSocket
    connections and blocked traffic live in the Cloudflare dashboard. This page deliberately does not
    duplicate either.
  </p>
</div>
<script>
(function () {
  "use strict";

  var RANGES = { 3600000: "1h", 21600000: "6h", 172800000: "48h", 2592000000: "30d", 31536000000: "1y" };
  var POLL_MS = 5000;
  var MAX_PLOT_POINTS = 400;

  var state = { rangeMs: 21600000, cursorMs: 0, rows: [], live: null, meta: null, table: false, timer: null, failures: 0 };

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function seriesColor(n) { return css("--series-" + n); }

  function fmtCount(v) {
    if (v === null || v === undefined || !isFinite(v)) return "n/a";
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + "B";
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + "k";
    return String(Math.round(v * 10) / 10);
  }
  function fmtBytes(v) {
    if (v === null || v === undefined || !isFinite(v)) return "n/a";
    var units = ["B", "KiB", "MiB", "GiB", "TiB"], i = 0, n = v;
    while (Math.abs(n) >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (Math.round(n * 10) / 10) + " " + units[i];
  }
  function fmtBytesRate(v) { return fmtBytes(v) + "/s"; }
  function fmtPercent(v) { return v === null || v === undefined ? "n/a" : (Math.round(v * 10) / 10) + "%"; }
  function fmtMs(v) { return v === null || v === undefined ? "n/a" : (Math.round(v * 10) / 10) + " ms"; }
  function fmtDuration(seconds) {
    if (seconds === null || seconds === undefined) return "n/a";
    var d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  }
  function fmtTime(ms) {
    var d = new Date(ms);
    if (state.rangeMs > 172800000) return d.toLocaleDateString();
    if (state.rangeMs > 21600000) return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function perSecond(row, key) {
    var w = row.windowMs > 0 ? row.windowMs / 1000 : 1;
    return row[key] / w;
  }

  // Buckets to at most MAX_PLOT_POINTS, keeping the maximum in each bucket so a
  // spike survives downsampling. Matches how the server aggregates gauges.
  function downsample(rows, valueFns) {
    if (rows.length <= MAX_PLOT_POINTS) {
      return rows.map(function (r) {
        return { t: r.timestampMs, restart: r.restartCount > 0, values: valueFns.map(function (f) { return f(r); }) };
      });
    }
    var size = Math.ceil(rows.length / MAX_PLOT_POINTS), out = [];
    for (var i = 0; i < rows.length; i += size) {
      var chunk = rows.slice(i, i + size), restart = false, values = [];
      for (var s = 0; s < valueFns.length; s++) {
        var best = null;
        for (var c = 0; c < chunk.length; c++) {
          var v = valueFns[s](chunk[c]);
          if (v !== null && v !== undefined && isFinite(v) && (best === null || v > best)) best = v;
        }
        values.push(best);
      }
      for (var c2 = 0; c2 < chunk.length; c2++) if (chunk[c2].restartCount > 0) restart = true;
      out.push({ t: chunk[0].timestampMs, restart: restart, values: values });
    }
    return out;
  }

  var W = 760, H = 190, PAD_L = 46, PAD_R = 12, PAD_T = 10, PAD_B = 22;

  function buildChart(card, spec) {
    var pts = downsample(state.rows, spec.series.map(function (s) { return s.value; }));
    var plot = card.querySelector(".plot");
    if (!pts.length) { plot.innerHTML = '<p class="empty">No history in this range yet.</p>'; return; }

    var maxValue = 0;
    for (var i = 0; i < pts.length; i++) {
      for (var s = 0; s < spec.series.length; s++) {
        var v = pts[i].values[s];
        if (v !== null && isFinite(v) && v > maxValue) maxValue = v;
      }
    }
    if (maxValue <= 0) maxValue = 1;
    var top = maxValue * 1.12;

    function xAt(i) { return PAD_L + (pts.length === 1 ? 0 : (i / (pts.length - 1)) * (W - PAD_L - PAD_R)); }
    function yAt(v) { return PAD_T + (1 - v / top) * (H - PAD_T - PAD_B); }

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(spec.title) + '">';
    for (var g = 0; g <= 3; g++) {
      var gv = (top / 3) * g, gy = yAt(gv);
      svg += '<line x1="' + PAD_L + '" y1="' + gy + '" x2="' + (W - PAD_R) + '" y2="' + gy + '" stroke="' + css("--grid") + '" stroke-width="1"/>';
      svg += '<text x="' + (PAD_L - 6) + '" y="' + (gy + 3.5) + '" text-anchor="end" font-size="10" fill="' + css("--text-muted") + '">' + esc(spec.format(gv)) + '</text>';
    }
    // Restart markers: a deploy is a counter reset, not a dip in traffic.
    for (var r = 0; r < pts.length; r++) {
      if (!pts[r].restart) continue;
      svg += '<line x1="' + xAt(r) + '" y1="' + PAD_T + '" x2="' + xAt(r) + '" y2="' + (H - PAD_B) + '" stroke="' + css("--text-muted") + '" stroke-width="1" stroke-dasharray="3 3"/>';
    }
    svg += '<line x1="' + PAD_L + '" y1="' + (H - PAD_B) + '" x2="' + (W - PAD_R) + '" y2="' + (H - PAD_B) + '" stroke="' + css("--axis") + '" stroke-width="1"/>';

    for (var si = 0; si < spec.series.length; si++) {
      var d = "", open = false;
      for (var p = 0; p < pts.length; p++) {
        var val = pts[p].values[si];
        if (val === null || val === undefined || !isFinite(val)) { open = false; continue; }
        d += (open ? "L" : "M") + xAt(p).toFixed(1) + " " + yAt(val).toFixed(1) + " ";
        open = true;
      }
      if (d) svg += '<path d="' + d + '" fill="none" stroke="' + spec.series[si].color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    }

    svg += '<text x="' + PAD_L + '" y="' + (H - 6) + '" font-size="10" fill="' + css("--text-muted") + '">' + esc(fmtTime(pts[0].t)) + '</text>';
    svg += '<text x="' + (W - PAD_R) + '" y="' + (H - 6) + '" text-anchor="end" font-size="10" fill="' + css("--text-muted") + '">' + esc(fmtTime(pts[pts.length - 1].t)) + '</text>';
    // A class, not an id: several charts share this document, and duplicate
    // ids would be invalid markup even though the subtree query still works.
    svg += '<line class="cross" x1="0" y1="' + PAD_T + '" x2="0" y2="' + (H - PAD_B) + '" stroke="' + css("--axis") + '" stroke-width="1" opacity="0"/>';
    svg += "</svg>";

    plot.innerHTML = svg + '<div class="tip"></div>';

    var svgEl = plot.querySelector("svg"), tip = plot.querySelector(".tip"), cross = plot.querySelector(".cross");
    svgEl.addEventListener("mousemove", function (event) {
      var box = svgEl.getBoundingClientRect();
      var x = ((event.clientX - box.left) / box.width) * W;
      var idx = Math.round(((x - PAD_L) / (W - PAD_L - PAD_R)) * (pts.length - 1));
      if (idx < 0) idx = 0;
      if (idx > pts.length - 1) idx = pts.length - 1;
      cross.setAttribute("x1", xAt(idx));
      cross.setAttribute("x2", xAt(idx));
      cross.setAttribute("opacity", "1");
      var html = '<div class="when">' + esc(fmtTime(pts[idx].t)) + (pts[idx].restart ? " &middot; restart" : "") + "</div>";
      for (var k = 0; k < spec.series.length; k++) {
        var value = pts[idx].values[k];
        html += '<div><span>' + esc(spec.series[k].label) + ":</span> " + esc(value === null || value === undefined ? "n/a" : spec.format(value)) + "</div>";
      }
      tip.innerHTML = html;
      tip.style.opacity = "1";
      var left = (xAt(idx) / W) * box.width + 12;
      if (left > box.width - 150) left -= 165;
      tip.style.left = left + "px";
      tip.style.top = "6px";
    });
    svgEl.addEventListener("mouseleave", function () { tip.style.opacity = "0"; cross.setAttribute("opacity", "0"); });
  }

  function chartCard(spec) {
    var card = document.createElement("div");
    card.className = "card";
    var legend = "";
    // A legend is always present for two or more series, so identity is never
    // carried by colour alone.
    if (spec.series.length > 1) {
      legend = '<div class="legend">';
      for (var i = 0; i < spec.series.length; i++) {
        legend += '<span><i class="swatch" style="background:' + spec.series[i].color + '"></i>' + esc(spec.series[i].label) + "</span>";
      }
      legend += "</div>";
    }
    card.innerHTML = "<h2>" + esc(spec.title) + "</h2>" + (spec.hint ? '<p class="hint">' + esc(spec.hint) + "</p>" : "") + '<div class="plot"></div>' + legend;
    return card;
  }

  function activeSeries(pick, labels) {
    var out = [], slot = 0;
    for (var i = 0; i < labels.length; i++) {
      var key = labels[i].key, any = false;
      for (var r = 0; r < state.rows.length; r++) { if (pick(state.rows[r], key)) { any = true; break; } }
      if (!any) continue;
      slot++;
      if (slot > 8) break;
      out.push({ label: labels[i].label, color: seriesColor(slot), key: key,
        value: (function (k) { return function (row) { return pick(row, k) || 0; }; })(key) });
    }
    return out;
  }

  var CAUSES = [
    { key: "peerClosed", label: "peer closed" }, { key: "backpressure", label: "backpressure" },
    { key: "parkedOverflow", label: "parked overflow" }, { key: "heartbeat", label: "heartbeat" },
    { key: "parkTimeout", label: "park timeout" }, { key: "sessionByteCap", label: "session byte cap" },
    { key: "sessionTimeCap", label: "session time cap" }
  ];

  function specs() {
    var list = [
      { title: "Connections", hint: "Live gauges, sampled once per interval.", format: fmtCount, series: [
        { label: "active", color: seriesColor(1), value: function (r) { return r.activeConnections.maximum; } },
        { label: "waiting slots", color: seriesColor(2), value: function (r) { return r.waitingSlots.maximum; } },
        { label: "paired slots", color: seriesColor(3), value: function (r) { return r.pairedSlots.maximum; } }
      ] },
      { title: "Frames forwarded", hint: "Rate, derived from per-interval deltas.", format: function (v) { return fmtCount(v) + "/s"; }, series: [
        { label: "frames/s", color: seriesColor(1), value: function (r) { return perSecond(r, "framesForwardedDelta"); } }
      ] },
      { title: "Bytes forwarded", hint: "Payload only. Real egress runs roughly 1.1 to 1.3x higher.", format: fmtBytesRate, series: [
        { label: "bytes/s", color: seriesColor(2), value: function (r) { return perSecond(r, "bytesForwardedDelta"); } }
      ] },
      { title: "New connections and sessions", hint: "Per-interval deltas.", format: fmtCount, series: [
        { label: "connections", color: seriesColor(1), value: function (r) { return r.connectionsDelta; } },
        { label: "sessions paired", color: seriesColor(3), value: function (r) { return r.sessionsDelta; } }
      ] }
    ];

    var causeSeries = activeSeries(function (row, key) { return row.closedByCause[key]; }, CAUSES);
    if (causeSeries.length) {
      list.push({ title: "Teardowns by cause",
        hint: "Mixed units: peer closed, backpressure and the session caps count pair teardowns (two sockets each); parked overflow, heartbeat and park timeout count single sockets.",
        format: fmtCount, series: causeSeries });
    }

    var reasonKeys = {};
    for (var i = 0; i < state.rows.length; i++) {
      for (var k in state.rows[i].rejectsByReasonDelta) reasonKeys[k] = true;
    }
    var reasonLabels = Object.keys(reasonKeys).sort().map(function (k) { return { key: k, label: k.replace(/_/g, " ") }; });
    var reasonSeries = activeSeries(function (row, key) { return row.rejectsByReasonDelta[key]; }, reasonLabels);
    if (reasonSeries.length) {
      list.push({ title: "Rejections by reason", hint: "Per-interval deltas. Absent reasons are not drawn.", format: fmtCount, series: reasonSeries });
    }

    list.push({ title: "Process CPU", hint: "Percent of one core. Above 100 is possible and real: this counts every thread.", format: fmtPercent, series: [
      { label: "cpu", color: seriesColor(1), value: function (r) { return r.cpuPercent ? r.cpuPercent.maximum : null; } }
    ] });
    list.push({ title: "Event loop delay p99", hint: "Worst tail per interval. Aggregated buckets keep the maximum.", format: fmtMs, series: [
      { label: "p99", color: seriesColor(2), value: function (r) { return r.eventLoopLagP99Ms; } }
    ] });
    list.push({ title: "Resident memory", hint: "Against the container limit, when one is discoverable.", format: fmtPercent, series: [
      { label: "rss", color: seriesColor(3), value: function (r) { return r.rssPercent; } }
    ] });
    return list;
  }

  function renderTiles() {
    var live = state.live;
    if (!live) return;
    var tiles = [
      { label: "Active connections", value: fmtCount(live.activeConnections) },
      { label: "Waiting / paired", value: fmtCount(live.waitingSlots) + " / " + fmtCount(live.pairedSlots) },
      { label: "Sessions total", value: fmtCount(live.sessionsTotal), note: "since restart" },
      { label: "Bytes forwarded", value: fmtBytes(live.bytesForwardedTotal), note: "since restart" },
      { label: "Uptime", value: fmtDuration(live.uptimeSeconds) },
      { label: "CPU", value: fmtPercent(live.cpuPercent), note: "of one core" },
      { label: "Event loop p99", value: fmtMs(live.eventLoopLagP99Ms) },
      { label: "Memory", value: live.rssPercent === null ? fmtBytes(live.rssBytes) : fmtPercent(live.rssPercent), note: fmtBytes(live.rssBytes) }
    ];
    var html = "";
    for (var i = 0; i < tiles.length; i++) {
      html += '<div class="tile"><div class="label">' + esc(tiles[i].label) + '</div><div class="value">' + esc(tiles[i].value) + "</div>" +
        (tiles[i].note ? '<div class="note">' + esc(tiles[i].note) + "</div>" : "") + "</div>";
    }
    document.getElementById("tiles").innerHTML = html;
  }

  function renderBanners() {
    var meta = state.meta, out = "";
    if (!meta) { document.getElementById("banners").innerHTML = ""; return; }
    if (meta.historyPersistence === "memory") {
      out += '<div class="banner">History is memory only: METRICS_HISTORY_PATH is unset, so the last ' +
        Math.round((meta.ringCapacity * meta.intervalMs) / 60000) + ' minutes are shown and nothing survives a restart.</div>';
    }
    if (meta.recorderHealthy === false) {
      out += '<div class="banner">The history file could not be written, so recording has fallen back to memory. Check the relay logs and the volume mount.</div>';
    }
    if (meta.truncated) out += '<div class="banner">This range exceeded the response row cap, so the oldest rows are not shown. Narrow the range for a complete view.</div>';
    if (meta.skippedLineCount > 0) out += '<div class="banner">' + meta.skippedLineCount + " unreadable row(s) were skipped in this range.</div>";
    document.getElementById("banners").innerHTML = out;
  }

  function renderTable() {
    var host = document.getElementById("tableView");
    host.hidden = !state.table;
    if (!state.table) return;
    var rows = state.rows.slice(-500).reverse();
    var html = '<div class="card"><h2>Table view</h2><p class="hint">Most recent 500 sampled intervals, newest first. Rates are derived from each row\\u2019s own window.</p><div class="tablewrap"><table><thead><tr>' +
      "<th>Time</th><th>Active</th><th>Waiting</th><th>Paired</th><th>Frames/s</th><th>Bytes/s</th><th>Conns</th><th>Sessions</th><th>CPU %</th><th>Loop p99</th><th>RSS %</th><th>Restart</th></tr></thead><tbody>";
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      html += "<tr><td>" + esc(fmtTime(r.timestampMs)) + "</td><td>" + fmtCount(r.activeConnections.maximum) + "</td><td>" + fmtCount(r.waitingSlots.maximum) +
        "</td><td>" + fmtCount(r.pairedSlots.maximum) + "</td><td>" + fmtCount(perSecond(r, "framesForwardedDelta")) + "</td><td>" + esc(fmtBytes(perSecond(r, "bytesForwardedDelta"))) +
        "</td><td>" + fmtCount(r.connectionsDelta) + "</td><td>" + fmtCount(r.sessionsDelta) + "</td><td>" + (r.cpuPercent ? fmtCount(r.cpuPercent.maximum) : "n/a") +
        "</td><td>" + (r.eventLoopLagP99Ms === null ? "n/a" : fmtCount(r.eventLoopLagP99Ms)) + "</td><td>" + (r.rssPercent === null ? "n/a" : fmtCount(r.rssPercent)) +
        "</td><td>" + (r.restartCount > 0 ? "yes" : "") + "</td></tr>";
    }
    document.getElementById("tableView").innerHTML = html + "</tbody></table></div></div>";
  }

  function render() {
    renderBanners();
    renderTiles();
    var host = document.getElementById("charts");
    host.hidden = state.table;
    if (!state.table) {
      host.innerHTML = "";
      var list = specs();
      for (var i = 0; i < list.length; i++) {
        var card = chartCard(list[i]);
        host.appendChild(card);
        buildChart(card, list[i]);
      }
    }
    renderTable();
  }

  function setStatus(text, cls) {
    document.getElementById("statusText").textContent = text;
    document.getElementById("dot").className = "dot" + (cls ? " " + cls : "");
  }

  function apply(payload, replace) {
    state.live = payload.live;
    state.meta = payload.meta;
    if (replace) state.rows = payload.rows;
    else if (payload.rows.length) state.rows = state.rows.concat(payload.rows);
    var oldest = payload.meta.serverTimeMs - state.rangeMs;
    state.rows = state.rows.filter(function (r) { return r.timestampMs >= oldest; });
    if (payload.cursorMs) state.cursorMs = payload.cursorMs;
    render();
  }

  async function load(replace) {
    var url = replace ? "/admin/data?range=" + state.rangeMs : "/admin/data?since=" + state.cursorMs;
    try {
      var response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      apply(await response.json(), replace);
      state.failures = 0;
      setStatus("live", "");
    } catch (error) {
      state.failures++;
      setStatus("disconnected (" + state.failures + ")", "bad");
    }
  }

  function startPolling() {
    stopPolling();
    state.timer = setInterval(function () { load(false); }, POLL_MS);
  }
  function stopPolling() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

  // Polling stops entirely while the tab is hidden, so an open-but-unwatched
  // dashboard costs the relay nothing.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { stopPolling(); setStatus("paused", "paused"); }
    else { load(false); startPolling(); }
  });

  var buttons = document.querySelectorAll("button[data-range]");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function (event) {
      state.rangeMs = Number(event.target.getAttribute("data-range"));
      for (var b = 0; b < buttons.length; b++) buttons[b].setAttribute("aria-pressed", buttons[b] === event.target ? "true" : "false");
      load(true);
    });
    if (Number(buttons[i].getAttribute("data-range")) === state.rangeMs) buttons[i].setAttribute("aria-pressed", "true");
  }
  document.getElementById("tableToggle").addEventListener("click", function (event) {
    state.table = !state.table;
    event.target.setAttribute("aria-pressed", state.table ? "true" : "false");
    render();
  });

  load(true).then(startPolling);
})();
</script>
</body>
</html>
`;
