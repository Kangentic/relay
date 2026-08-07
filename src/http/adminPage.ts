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
import { BRANDMARK_INLINE_SVG, FAVICON_DATA_URI } from './brand.js';

export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Kangentic Relay - Admin</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">
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
/* The hidden attribute only sets display:none from the UA stylesheet, so any
   author display rule (.grid2 is display:grid) silently beats it and the
   element stays visible. Without this the table toggle shows the table but
   never hides the charts. */
[hidden] { display: none !important; }
body {
  margin: 0;
  background: var(--page);
  color: var(--text-primary);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.5;
}
/* Wide enough for three chart columns on a 2K display. The grid below is
   auto-fit, so the column count falls to two and then one on its own as the
   viewport narrows; this only stops the content stretching indefinitely. */
.wrap { max-width: 1800px; margin: 0 auto; padding: 22px 24px 64px; }
.topbar {
  display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
  justify-content: space-between; padding-bottom: 16px; margin-bottom: 18px;
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 11px; min-width: 0; }
/* overflow:hidden is a backstop: an SVG that ever loses its viewBox again
   should be clipped to the header, not painted across the document. */
.mark { width: 30px; height: 30px; flex: none; display: block; overflow: hidden; }
.mark svg { width: 100%; height: 100%; display: block; }
.brandtext { min-width: 0; }
h1 { font-size: 19px; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
.sub { color: var(--text-muted); font-size: 12.5px; margin: 2px 0 0; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 18px; }
button {
  font: inherit; font-size: 13px; color: var(--text-secondary);
  background: var(--surface-1); border: 1px solid var(--border);
  border-radius: 7px; padding: 5px 11px; cursor: pointer;
  transition: background .12s, color .12s;
}
button:hover { color: var(--text-primary); }
button:focus-visible { outline: 2px solid var(--series-1); outline-offset: 2px; }
/* Segmented control: one bordered track with the buttons inside it, rather
   than six loose pills, so the range reads as a single choice. */
.segmented {
  display: inline-flex; gap: 2px; padding: 2px;
  background: var(--surface-1); border: 1px solid var(--border); border-radius: 9px;
}
.segmented button { border: none; background: transparent; border-radius: 7px; padding: 4px 11px; }
.segmented button:hover { background: var(--page); }
button[aria-pressed="true"], .segmented button[aria-pressed="true"] {
  background: var(--series-1); border-color: var(--series-1); color: #fff;
}
.segmented button[aria-pressed="true"]:hover { background: var(--series-1); }
.spacer { flex: 1 1 auto; }
.status {
  font-size: 12px; color: var(--text-secondary); display: inline-flex; align-items: center;
  gap: 7px; background: var(--surface-1); border: 1px solid var(--border);
  border-radius: 999px; padding: 5px 12px; font-variant-numeric: tabular-nums; flex: none;
}
.dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--good); flex: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--good) 22%, transparent);
  animation: pulse 2.4s ease-in-out infinite;
}
.dot.paused { background: var(--warning); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning) 24%, transparent); animation: none; }
.dot.bad { background: var(--critical); box-shadow: 0 0 0 3px color-mix(in srgb, var(--critical) 24%, transparent); animation: none; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
.tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 18px; }
/* All eight across on a wide display, so the headroom row reads as one glance
   rather than two. */
@media (min-width: 1560px) { .tiles { grid-template-columns: repeat(8, 1fr); } }
@media (max-width: 1040px) { .tiles { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 620px) { .tiles { grid-template-columns: repeat(2, 1fr); } }
.tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 8px 11px; }
.tile .label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); display: flex; align-items: center; justify-content: space-between; gap: 6px; }
/* Status is a percentage first and a colour second, so it survives a
   colour-blind reader, a grayscale print and forced-colors mode. */
.badge { font-size: 10px; font-weight: 600; padding: 0 5px; border-radius: 999px; letter-spacing: 0; }
.badge.good { color: var(--good); background: color-mix(in srgb, var(--good) 14%, transparent); }
.badge.warning { color: var(--warning); background: color-mix(in srgb, var(--warning) 20%, transparent); }
.badge.critical { color: var(--critical); background: color-mix(in srgb, var(--critical) 16%, transparent); }
.tile .value { font-size: 20px; font-weight: 600; margin-top: 1px; line-height: 1.25; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.tile { transition: border-color .12s; }
.tile:hover { border-color: color-mix(in srgb, var(--text-muted) 40%, transparent); }
.tile .note { font-size: 11px; color: var(--text-muted); }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(470px, 1fr)); gap: 14px; }
.card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 14px 15px 10px; }
.card h2 { font-size: 13px; margin: 0 0 1px; font-weight: 600; }
/* Reserve two lines so a one-line hint and a two-line hint still put their
   charts on the same baseline across a row. */
.card .hint { font-size: 11px; color: var(--text-muted); margin: 0 0 8px; min-height: 2.7em; }
.triage li.note { color: var(--text-muted); padding-left: 0; text-indent: 0; margin-bottom: 6px; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 6px; font-size: 12px; color: var(--text-secondary); }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.triage-details { margin-top: 8px; font-size: 11.5px; }
.triage-details summary {
  cursor: pointer; color: var(--text-muted); list-style: none;
  display: inline-flex; align-items: center; gap: 5px; user-select: none;
}
.triage-details summary::-webkit-details-marker { display: none; }
.triage-details summary::before { content: "\\203A"; display: inline-block; transition: transform .12s; font-size: 14px; }
.triage-details[open] summary::before { transform: rotate(90deg); }
.triage-details summary:hover { color: var(--text-primary); }
.triage { list-style: none; margin: 8px 0 2px; padding: 0; font-size: 11.5px; color: var(--text-secondary); }
/* Hanging indent: the swatch and cause name sit in a fixed gutter so wrapped
   explanation lines align under the text, not under the swatch. */
.triage li { padding-left: 17px; text-indent: -17px; margin-bottom: 4px; line-height: 1.45; }
.triage b { color: var(--text-primary); font-weight: 600; }
.triage .swatch { display: inline-block; margin-right: 6px; position: relative; top: -3px; }
/* A short line key, never a filled box: it reads as "this is the line in the
   chart" rather than as a category chip. */
.swatch { width: 11px; height: 2px; border-radius: 999px; flex: none; }
.plot { position: relative; }
svg { display: block; width: 100%; height: auto; overflow: visible; }
/* Page surface, not the card surface: the tooltip floats over raised cards, so
   the card token would melt into its own background. */
.tip {
  position: absolute; pointer-events: none; opacity: 0; transition: opacity .1s;
  background: var(--page); border: 1px solid var(--border); border-radius: 6px;
  padding: 6px 10px; font-size: 12px; white-space: nowrap; z-index: 5;
  box-shadow: 0 4px 16px rgba(0,0,0,.18); color: var(--text-primary);
}
.tip .when { color: var(--text-muted); font-size: 11px; margin-bottom: 3px; }
/* The value leads in primary ink and the label follows muted, so scanning a
   multi-series tooltip reads numbers first. */
.tip .row { display: flex; align-items: center; gap: 6px; }
.tip .key { width: 11px; height: 2px; border-radius: 999px; flex: none; }
.tip .val { font-weight: 500; font-variant-numeric: tabular-nums; }
.tip .lbl { color: var(--text-secondary); }
.empty { color: var(--text-muted); font-size: 12px; padding: 24px 0; text-align: center; }
table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 5px 9px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th {
  color: var(--text-muted); font-weight: 500; position: sticky; top: 0; z-index: 1;
  background: var(--surface-1); border-bottom: 1px solid var(--axis);
}
tbody tr:hover td { background: var(--page); }
/* A restart is the row that explains why the counters around it look odd. */
tr.restart td { border-bottom-color: var(--warning); }
tr.restart td:first-child { box-shadow: inset 3px 0 0 var(--warning); font-weight: 600; }
.tablewrap { overflow-x: auto; max-height: 520px; overflow-y: auto; }
td.zero { color: var(--text-muted); }
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
  <header class="topbar">
    <div class="brand">
      <span class="mark" aria-hidden="true">${BRANDMARK_INLINE_SVG}</span>
      <div class="brandtext">
        <h1>Kangentic Relay</h1>
        <p class="sub">Aggregate counters only: no slot ids, no IP addresses, no traffic content.</p>
      </div>
    </div>
    <div class="status" id="status" role="status">
      <span class="dot" id="dot"></span><span id="statusText">connecting</span>
    </div>
  </header>

  <div id="banners"></div>

  <div class="controls">
    <div class="segmented" role="group" aria-label="Time range">
      <button data-range="0" title="Last 15 minutes, refreshing every 2 seconds">Live</button>
      <button data-range="3600000">1h</button>
      <button data-range="21600000">6h</button>
      <button data-range="86400000">24h</button>
      <button data-range="604800000">7d</button>
      <button data-range="2592000000">30d</button>
      <button data-range="31536000000">1y</button>
    </div>
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

  // 2s. Measured cost of one incremental poll is ~0.3 ms and ~790 bytes, served
  // from the in-memory ring without touching disk, against roughly 2700
  // polls/sec of headroom. The tab stops polling entirely when hidden.
  var POLL_MS = 2000;
  var MAX_PLOT_POINTS = 400;
  var DAY_MS = 86400000;
  /**
   * The Live range is not a shorter history query. The recorder samples once a
   * minute in production, so a 15-minute history view would be fifteen points.
   * Instead the page derives its own series from the poll it is already making
   * every 2 seconds, holding it in memory here. That is a genuinely live view
   * at poll resolution for no extra server work, no extra disk, and no change
   * to the sampling interval. It is ephemeral by nature: a reload starts over.
   */
  var LIVE_RANGE = 0;
  var LIVE_WINDOW_MS = 15 * 60 * 1000;

  // Live by default: the first question on opening an operations page is
  // almost always "what is it doing right now", and the seed below means that
  // view is a full fifteen minutes on first paint rather than a blank chart.
  var state = { rangeMs: LIVE_RANGE, cursorMs: 0, rows: [], live: null, meta: null, table: false, timer: null, failures: 0, instanceId: null, lastUpdateMs: 0, statusText: "connecting", statusClass: "",
    liveRows: [], previousLive: null, previousLiveAtMs: 0 };
  // Loopback only. Under tsx watch the relay restarts on every source edit, and
  // a new instance id is the signal that the page being displayed is stale.
  // Production is served on a real hostname, so this can never fire there.
  var IS_LOCAL = location.hostname === "127.0.0.1" || location.hostname === "localhost";

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
  // Caps are configured values, not measurements: "10,000" is the number
  // someone typed into MAX_CONNECTIONS, "10.0k" is not.
  function fmtInt(v) {
    return v === null || v === undefined || !isFinite(v) ? "n/a" : Math.round(v).toLocaleString();
  }
  function fmtBytesRate(v) { return fmtBytes(v) + "/s"; }
  function fmtPerMinute(v) { return v === null || v === undefined ? "n/a" : fmtCount(v) + "/min"; }
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
    // Seconds only matter on the live view; anywhere else they are noise.
    if (state.rangeMs === LIVE_RANGE) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
    if (state.rangeMs > 7 * DAY_MS) return d.toLocaleDateString([], { month: "short", day: "numeric" });
    if (state.rangeMs > DAY_MS) return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" });
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

  /**
   * Counts have to be normalised before they are plotted, because rows do not
   * all cover the same span. History is tiered (1-minute, then 5-minute, then
   * hourly), and the Live view mixes 60-second history rows with 2-second poll
   * rows. Plotting a raw per-interval count across any of those seams draws a
   * cliff that is purely an artefact of the bucket width: an hourly row holds
   * twelve times the count of a 5-minute row for exactly the same traffic.
   * Per minute reads better than per second for sparse counts like teardowns.
   */
  function perMinute(row, value) {
    var minutes = row.windowMs > 0 ? row.windowMs / 60000 : 1;
    return value / minutes;
  }
  function deltaPerMinute(row, key) { return perMinute(row, row[key]); }

  function readMean(meanFn, row) {
    if (!meanFn) return null;
    var mean = meanFn(row);
    return mean === null || mean === undefined || !isFinite(mean) ? null : mean;
  }

  /**
   * Buckets to at most MAX_PLOT_POINTS. How a bucket collapses depends on what
   * the series MEASURES, which is the part that is easy to get wrong:
   *
   *   sum  - per-interval counts (teardowns, rejects, new connections). Four
   *          one-minute intervals collapsing to one point should report what
   *          happened across all four. Taking the max instead reports the worst
   *          single minute and draws a picket fence.
   *   max  - levels and peaks (connections, queue depth). A spike must survive.
   *   mean - ratios and averages (pairing success, frame size). Neither the sum
   *          nor the peak of a percentage means anything.
   */
  function reduceBucket(chunk, series) {
    var kind = series.reduce || "max";
    var total = 0, count = 0, best = null;
    for (var c = 0; c < chunk.length; c++) {
      var v = series.value(chunk[c]);
      if (v === null || v === undefined || !isFinite(v)) continue;
      count++;
      total += v;
      if (best === null || v > best) best = v;
    }
    if (count === 0) return null;
    if (kind === "sum") return total;
    if (kind === "mean") return total / count;
    return best;
  }

  // Means are carried alongside, because a maximum alone cannot tell "sat at 38
  // all hour" from "idled at 2 and burst once" - which is the difference
  // between needing a bigger box and having had one busy minute.
  function downsample(rows, seriesList) {
    if (rows.length <= MAX_PLOT_POINTS) {
      return rows.map(function (r) {
        return {
          t: r.timestampMs,
          restart: r.restartCount > 0,
          values: seriesList.map(function (s) { return s.value(r); }),
          means: seriesList.map(function (s) { return readMean(s.mean, r); })
        };
      });
    }
    var size = Math.ceil(rows.length / MAX_PLOT_POINTS), out = [];
    for (var i = 0; i < rows.length; i += size) {
      var chunk = rows.slice(i, i + size), restart = false, values = [], means = [];
      for (var s = 0; s < seriesList.length; s++) {
        values.push(reduceBucket(chunk, seriesList[s]));
        var meanTotal = 0, meanCount = 0;
        for (var c = 0; c < chunk.length; c++) {
          var m = readMean(seriesList[s].mean, chunk[c]);
          if (m !== null) { meanTotal += m; meanCount++; }
        }
        means.push(meanCount === 0 ? null : meanTotal / meanCount);
      }
      for (var c2 = 0; c2 < chunk.length; c2++) if (chunk[c2].restartCount > 0) restart = true;
      out.push({ t: chunk[0].timestampMs, restart: restart, values: values, means: means });
    }
    return out;
  }

  var W = 760, H = 240, PAD_L = 56, PAD_R = 14, PAD_T = 12, PAD_B = 28;

  // Ticks land on 1/2/5 times a power of ten, so an axis reads 100 / 200 / 300
  // instead of 98.2 / 196.4 / 294.6. Dividing the raw maximum into equal
  // fractions is the single biggest thing that makes a chart hard to read.
  function niceStep(rawMax, tickTarget) {
    var raw = rawMax / tickTarget;
    if (!isFinite(raw) || raw <= 0) return 1;
    var exponent = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var fraction = raw / exponent;
    var nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
    return nice * exponent;
  }

  function buildChart(card, spec) {
    var pts = downsample(plotRows(), spec.series);
    var plot = card.querySelector(".plot");
    if (!pts.length) {
      plot.innerHTML = '<p class="empty">' +
        (state.rangeMs === LIVE_RANGE ? "Collecting, one point every " + POLL_MS / 1000 + "s..." : "No history in this range yet.") +
        "</p>";
      return;
    }

    // Sparse per-interval counts (teardown causes, reject reasons) read as
    // noise when drawn as overlapping lines; stacked they show both the total
    // and the mix.
    var stacked = spec.stacked === true;
    var maxValue = 0;
    for (var i = 0; i < pts.length; i++) {
      var total = 0;
      for (var s = 0; s < spec.series.length; s++) {
        var v = pts[i].values[s];
        if (v === null || v === undefined || !isFinite(v)) continue;
        if (stacked) total += v;
        else if (v > maxValue) maxValue = v;
      }
      if (stacked && total > maxValue) maxValue = total;
    }
    if (maxValue <= 0) maxValue = 1;
    var step = niceStep(maxValue, 4);
    var tickCount = Math.max(1, Math.ceil(maxValue / step));
    var top = step * tickCount;

    function xAt(i) { return PAD_L + (pts.length === 1 ? 0 : (i / (pts.length - 1)) * (W - PAD_L - PAD_R)); }
    function yAt(v) { return PAD_T + (1 - v / top) * (H - PAD_T - PAD_B); }

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(spec.title) + '">';
    for (var g = 0; g <= tickCount; g++) {
      var gv = step * g, gy = yAt(gv);
      svg += '<line x1="' + PAD_L + '" y1="' + gy + '" x2="' + (W - PAD_R) + '" y2="' + gy + '" stroke="' + css("--grid") + '" stroke-width="1"/>';
      svg += '<text x="' + (PAD_L - 6) + '" y="' + (gy + 3.5) + '" text-anchor="end" font-size="13" fill="' + css("--text-muted") + '">' + esc(spec.format(gv)) + '</text>';
    }
    // Restart markers: a deploy is a counter reset, not a dip in traffic.
    for (var r = 0; r < pts.length; r++) {
      if (!pts[r].restart) continue;
      svg += '<line x1="' + xAt(r) + '" y1="' + PAD_T + '" x2="' + xAt(r) + '" y2="' + (H - PAD_B) + '" stroke="' + css("--text-muted") + '" stroke-width="1" stroke-dasharray="3 3"/>';
    }
    svg += '<line x1="' + PAD_L + '" y1="' + (H - PAD_B) + '" x2="' + (W - PAD_R) + '" y2="' + (H - PAD_B) + '" stroke="' + css("--axis") + '" stroke-width="1"/>';

    if (stacked) {
      var lowerBaseline = [];
      for (var b = 0; b < pts.length; b++) lowerBaseline.push(0);
      for (var sa = 0; sa < spec.series.length; sa++) {
        var upperBaseline = [], area = "";
        for (var u = 0; u < pts.length; u++) {
          var stackValue = pts[u].values[sa];
          if (stackValue === null || stackValue === undefined || !isFinite(stackValue)) stackValue = 0;
          upperBaseline.push(lowerBaseline[u] + stackValue);
        }
        for (var f = 0; f < pts.length; f++) {
          area += (f === 0 ? "M" : "L") + xAt(f).toFixed(1) + " " + yAt(upperBaseline[f]).toFixed(1) + " ";
        }
        for (var back = pts.length - 1; back >= 0; back--) {
          area += "L" + xAt(back).toFixed(1) + " " + yAt(lowerBaseline[back]).toFixed(1) + " ";
        }
        // A hairline in the surface colour separates adjacent bands, so two
        // similar hues do not merge into one shape.
        svg += '<path d="' + area + 'Z" fill="' + spec.series[sa].color + '" fill-opacity="0.85" stroke="' +
          css("--surface-1") + '" stroke-width="0.5"/>';
        lowerBaseline = upperBaseline;
      }
    } else {
      for (var si = 0; si < spec.series.length; si++) {
        var d = "", open = false, firstX = null, lastX = null;
        for (var p = 0; p < pts.length; p++) {
          var val = pts[p].values[si];
          if (val === null || val === undefined || !isFinite(val)) { open = false; continue; }
          var px = xAt(p);
          d += (open ? "L" : "M") + px.toFixed(1) + " " + yAt(val).toFixed(1) + " ";
          if (firstX === null) firstX = px;
          lastX = px;
          open = true;
        }
        if (!d) continue;
        // A wash reads as "volume accumulating up from zero", so it is opt-in
        // and only on throughput. On a level like average frame size or a
        // percentage, zero is not a meaningful floor and the fill becomes a
        // solid block that says nothing.
        if (spec.fill && spec.series.length === 1 && firstX !== null) {
          svg += '<path d="' + d + "L" + lastX.toFixed(1) + " " + yAt(0).toFixed(1) +
            " L" + firstX.toFixed(1) + " " + yAt(0).toFixed(1) + ' Z" fill="' + spec.series[si].color +
            '" fill-opacity="0.14" stroke="none"/>';
        }
        svg += '<path d="' + d + '" fill="none" stroke="' + spec.series[si].color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
      }
    }

    // Four time labels rather than just the endpoints, so a spike can be
    // located without hovering every point.
    var labelCount = Math.min(4, pts.length);
    for (var tick = 0; tick < labelCount; tick++) {
      var at = labelCount === 1 ? 0 : Math.round((tick / (labelCount - 1)) * (pts.length - 1));
      var anchor = tick === 0 ? "start" : tick === labelCount - 1 ? "end" : "middle";
      svg += '<text x="' + xAt(at).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' + anchor +
        '" font-size="13" fill="' + css("--text-muted") + '">' + esc(fmtTime(pts[at].t)) + '</text>';
    }
    // A class, not an id: several charts share this document, and duplicate
    // ids would be invalid markup even though the subtree query still works.
    svg += '<line class="cross" x1="0" y1="' + PAD_T + '" x2="0" y2="' + (H - PAD_B) + '" stroke="' + css("--axis") + '" stroke-width="1" opacity="0"/>';
    svg += '<g class="dots"></g>';
    svg += "</svg>";

    plot.innerHTML = svg + '<div class="tip"></div>';

    var svgEl = plot.querySelector("svg"), tip = plot.querySelector(".tip");
    var cross = plot.querySelector(".cross"), dotsEl = plot.querySelector(".dots");
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
        var value = pts[idx].values[k], meanValue = pts[idx].means[k];
        var shown = value === null || value === undefined ? "n/a" : spec.format(value);
        // Only worth showing once a bucket covers more than one sample and the
        // average actually differs from the peak.
        if (meanValue !== null && value !== null && Math.abs(meanValue - value) > 0.05) {
          shown += " (avg " + spec.format(meanValue) + ")";
        }
        html += '<div class="row"><i class="key" style="background:' + spec.series[k].color + '"></i>' +
          '<span class="val">' + esc(shown) + '</span><span class="lbl">' + esc(spec.series[k].label) + "</span></div>";
      }
      tip.innerHTML = html;

      // A dot on the active point, ringed in the surface colour so it stays
      // legible where two series cross. Stacked bands have no single line to
      // sit on, so they get the crosshair only.
      var dots = "";
      if (!stacked) {
        for (var dk = 0; dk < spec.series.length; dk++) {
          var dotValue = pts[idx].values[dk];
          if (dotValue === null || dotValue === undefined || !isFinite(dotValue)) continue;
          dots += '<circle cx="' + xAt(idx).toFixed(1) + '" cy="' + yAt(dotValue).toFixed(1) +
            '" r="3" fill="' + spec.series[dk].color + '" stroke="' + css("--surface-1") + '" stroke-width="2"/>';
        }
      }
      dotsEl.innerHTML = dots;
      tip.style.opacity = "1";
      var left = (xAt(idx) / W) * box.width + 12;
      if (left > box.width - 150) left -= 165;
      tip.style.left = left + "px";
      tip.style.top = "6px";
    });
    svgEl.addEventListener("mouseleave", function () {
      tip.style.opacity = "0";
      cross.setAttribute("opacity", "0");
      dotsEl.innerHTML = "";
    });
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
    card.innerHTML = "<h2>" + esc(spec.title) + "</h2>" + (spec.hint ? '<p class="hint">' + esc(spec.hint) + "</p>" : "") +
      '<div class="plot"></div>' + legend + (spec.footnote || "");
    return card;
  }

  function activeSeries(pick, labels) {
    var out = [], slot = 0, rows = plotRows();
    for (var i = 0; i < labels.length; i++) {
      var key = labels[i].key, any = false;
      for (var r = 0; r < rows.length; r++) { if (pick(rows[r], key)) { any = true; break; } }
      if (!any) continue;
      slot++;
      if (slot > 8) break;
      out.push({ label: labels[i].label, color: seriesColor(slot), key: key, reduce: "max",
        value: (function (k) { return function (row) { return perMinute(row, pick(row, k) || 0); }; })(key) });
    }
    return out;
  }

  // The triage table from infra/README, on the page rather than in a file
  // nobody opens mid-incident. Only causes that actually fired are shown.
  var CAUSES = [
    { key: "peerClosed", label: "peer closed",
      meaning: "Normal. One side hung up; this should dominate." },
    { key: "backpressure", label: "backpressure",
      meaning: "Slow consumers hitting the buffer cap, or a saturated uplink. Check bandwidth before raising MAX_BUFFERED_BYTES." },
    { key: "parkedOverflow", label: "parked overflow",
      meaning: "A peer sent hard before its partner arrived. Client bug or abuse; correlate with rate_limit_slot." },
    { key: "heartbeat", label: "heartbeat",
      meaning: "Phones vanishing without a FIN. Normal at low rates; a spike suggests a network path problem." },
    { key: "parkTimeout", label: "park timeout",
      meaning: "Pairings started and abandoned. Client-side pairing UX, or slot scanning." },
    { key: "sessionByteCap", label: "session byte cap",
      meaning: "Real users hitting the byte cap. Revisit the cap if these are legitimate rather than abuse." },
    { key: "sessionTimeCap", label: "session time cap",
      meaning: "Should always read zero: production leaves MAX_SESSION_MS disabled. Non-zero means the deploy changed." }
  ];

  function specs() {
    var list = [
      { title: "Connections", hint: "Point samples, one per interval. Line is the peak; hover for the average on aggregated buckets.", format: fmtCount, series: [
        { label: "active", color: seriesColor(1), reduce: "max",
          value: function (r) { return r.activeConnections.maximum; },
          mean: function (r) { return r.activeConnections.mean; } },
        { label: "waiting slots", color: seriesColor(2), reduce: "max",
          value: function (r) { return r.waitingSlots.maximum; },
          mean: function (r) { return r.waitingSlots.mean; } },
        { label: "paired slots", color: seriesColor(3), reduce: "max",
          value: function (r) { return r.pairedSlots.maximum; },
          mean: function (r) { return r.pairedSlots.mean; } }
      ] },
      { title: "Frames forwarded", hint: "Rate, derived from per-interval deltas.", format: function (v) { return fmtCount(v) + "/s"; }, fill: true, series: [
        { label: "frames/s", color: seriesColor(1), reduce: "max", value: function (r) { return perSecond(r, "framesForwardedDelta"); } }
      ] },
      { title: "Bytes forwarded", hint: "Payload only. Real egress runs roughly 1.1 to 1.3x higher.", format: fmtBytesRate, fill: true, series: [
        { label: "bytes/s", color: seriesColor(2), reduce: "max", value: function (r) { return perSecond(r, "bytesForwardedDelta"); } }
      ] },
      { title: "New connections and sessions", hint: "Rate per minute, so tiers and the live view stay comparable.", format: fmtPerMinute, series: [
        { label: "connections", color: seriesColor(1), reduce: "max", value: function (r) { return deltaPerMinute(r, "connectionsDelta"); } },
        { label: "sessions paired", color: seriesColor(3), reduce: "max", value: function (r) { return deltaPerMinute(r, "sessionsDelta"); } }
      ] },
      { title: "Outbound queue depth",
        hint: "Peak bytes waiting to flush to the slowest consumer. A growing queue means that peer is behind; the tunnel is torn down at the buffer cap.",
        format: fmtBytes, fill: true, series: [
        { label: "peak queue", color: seriesColor(2), reduce: "max", value: function (r) { return r.maxOutboundBufferBytes; } }
      ] },
      { title: "Pairing success",
        hint: "Share of new connections that found a partner. Sustained below 100% means clients are arriving and failing to pair.",
        format: fmtPercent, series: [
        { label: "paired", color: seriesColor(3), reduce: "mean", value: function (r) {
          if (!r.connectionsDelta) return null;
          return Math.min(100, (r.sessionsDelta * 2 / r.connectionsDelta) * 100);
        } }
      ] },
      { title: "Average frame size",
        hint: "Bytes per forwarded frame. A step change means the traffic changed shape rather than volume.",
        format: fmtBytes, series: [
        { label: "mean frame", color: seriesColor(7), reduce: "mean", value: function (r) {
          return r.framesForwardedDelta > 0 ? r.bytesForwardedDelta / r.framesForwardedDelta : null;
        } }
      ] }
    ];

    function pickCause(row, key) { return row.closedByCause[key]; }
    function triageFor(series) {
      var meanings = "";
      for (var ci = 0; ci < series.length; ci++) {
        for (var cj = 0; cj < CAUSES.length; cj++) {
          if (CAUSES[cj].key !== series[ci].key) continue;
          meanings += '<li><i class="swatch" style="background:' + series[ci].color + '"></i><b>' +
            esc(CAUSES[cj].label) + "</b> " + esc(CAUSES[cj].meaning) + "</li>";
        }
      }
      // Collapsed by default. The explanations are what make the chart
      // actionable, but left open they add more height than the chart itself
      // and knock the card out of line with its neighbour.
      return meanings
        ? '<details class="triage-details"><summary>What these mean</summary><ul class="triage">' +
            '<li class="note">Units differ by cause: backpressure and the session caps count pair ' +
            'teardowns (two sockets each); parked overflow, heartbeat and park timeout count single sockets.</li>' +
            meanings + "</ul></details>"
        : "";
    }

    // Split deliberately. peer closed is the normal ending and is supposed to
    // dominate, so stacking it with the failures buries exactly the thing you
    // opened this page to find.
    var normalSeries = activeSeries(pickCause, CAUSES.filter(function (c) { return c.key === "peerClosed"; }));
    if (normalSeries.length) {
      list.push({ title: "Sessions ended normally", fill: true,
        hint: "One side hung up, counted once per pair, as a rate per minute. Should dominate; a fall with steady connections means sessions are ending some other way.",
        format: fmtPerMinute, series: normalSeries });
    }

    var abnormalSeries = activeSeries(pickCause, CAUSES.filter(function (c) { return c.key !== "peerClosed"; }));
    if (abnormalSeries.length) {
      list.push({ title: "Abnormal teardowns", stacked: true,
        hint: "Everything that ended a tunnel other than a peer hanging up, as a rate per minute.",
        footnote: triageFor(abnormalSeries),
        format: fmtPerMinute, series: abnormalSeries });
    }

    var reasonKeys = {}, reasonRows = plotRows();
    for (var i = 0; i < reasonRows.length; i++) {
      for (var k in reasonRows[i].rejectsByReasonDelta) reasonKeys[k] = true;
    }
    var reasonLabels = Object.keys(reasonKeys).sort().map(function (k) { return { key: k, label: k.replace(/_/g, " ") }; });
    var reasonSeries = activeSeries(function (row, key) { return row.rejectsByReasonDelta[key]; }, reasonLabels);
    if (reasonSeries.length) {
      list.push({ title: "Rejections by reason", stacked: true,
        hint: "Stacked rate per minute. Reasons that never fired are not drawn.", format: fmtPerMinute, series: reasonSeries });
    }

    list.push({ title: "Process CPU", hint: "Percent of one core. Above 100 is possible and real: this counts every thread.", format: fmtPercent, series: [
      { label: "cpu", color: seriesColor(1),
        value: function (r) { return r.cpuPercent ? r.cpuPercent.maximum : null; },
        mean: function (r) { return r.cpuPercent ? r.cpuPercent.mean : null; } }
    ] });
    list.push({ title: "Event loop delay p99", hint: "Worst tail per interval. Aggregated buckets keep the maximum.", format: fmtMs, series: [
      { label: "p99", color: seriesColor(2), value: function (r) { return r.eventLoopLagP99Ms; } }
    ] });
    list.push({ title: "Resident memory", hint: "Against the container limit, when one is discoverable.", format: fmtPercent, series: [
      { label: "rss", color: seriesColor(3), value: function (r) { return r.rssPercent; } }
    ] });
    return list;
  }

  /** Which series the charts and table draw from. */
  function plotRows() {
    return state.rangeMs === LIVE_RANGE ? state.liveRows : state.rows;
  }

  function latestRow() {
    var rows = state.rows;
    return rows.length ? rows[rows.length - 1] : null;
  }

  function subtractMaps(current, previous) {
    var out = {};
    for (var key in current) {
      var difference = current[key] - (previous[key] || 0);
      if (difference > 0) out[key] = difference;
    }
    return out;
  }

  /**
   * Builds one history-shaped row from two consecutive live snapshots, so every
   * chart, the tooltip and the table view all work against the live series
   * without knowing it came from anywhere different.
   *
   * Counters reset when the relay restarts, which shows up as uptime going
   * backwards; deltas clamp at zero so a restart never draws as a negative.
   */
  function synthesizeLiveRow(previous, current, previousAtMs, nowMs) {
    function delta(key) { return Math.max(0, current[key] - previous[key]); }
    function level(value) { return { maximum: value, mean: null }; }
    var closedByCause = subtractMaps(current.closedByCause, previous.closedByCause);
    return {
      timestampMs: nowMs,
      resolutionSeconds: 60,
      windowMs: Math.max(1, nowMs - previousAtMs),
      restartCount: current.uptimeSeconds < previous.uptimeSeconds ? 1 : 0,
      sourceRowCount: 1,
      connectionsDelta: delta("connectionsTotal"),
      sessionsDelta: delta("sessionsTotal"),
      framesForwardedDelta: delta("framesForwardedTotal"),
      bytesForwardedDelta: delta("bytesForwardedTotal"),
      peerClosedDelta: closedByCause.peerClosed || 0,
      pongTimeoutsDelta: closedByCause.heartbeat || 0,
      rejectsByReasonDelta: subtractMaps(current.rejectsByReason, previous.rejectsByReason),
      closedByCause: closedByCause,
      activeConnections: level(current.activeConnections),
      waitingSlots: level(current.waitingSlots),
      pairedSlots: level(current.pairedSlots),
      cpuPercent: current.cpuPercent === null ? null : level(current.cpuPercent),
      eventLoopLagP99Ms: current.eventLoopLagP99Ms,
      rssBytes: current.rssBytes,
      rssPercent: current.rssPercent,
      // Queue depth is only sampled on the recorder tick, so the live series
      // has nothing to say about it. Null draws a gap rather than a
      // reassuring zero.
      maxOutboundBufferBytes: null,
      backloggedConnections: null,
      maxParkedBufferBytes: null
    };
  }

  // Headroom, not raw values. "1240 connections" is a number; "31% of the way
  // to refusing new ones" is an answer. Thresholds are deliberately generous:
  // this should nag before it is urgent, not after.
  function statusOf(fraction) {
    if (fraction === null || fraction === undefined || !isFinite(fraction)) return "";
    if (fraction >= 0.8) return "critical";
    if (fraction >= 0.6) return "warning";
    return "good";
  }

  function renderTiles() {
    var live = state.live, meta = state.meta;
    if (!live || !meta) return;
    var caps = meta.capacity || {};
    var row = latestRow();
    var buffered = row && row.maxOutboundBufferBytes !== null ? row.maxOutboundBufferBytes : null;
    var backlogged = row && row.backloggedConnections !== null ? row.backloggedConnections : null;

    var connectionFraction = caps.maxConnections ? live.activeConnections / caps.maxConnections : null;
    var memoryFraction = live.rssPercent === null ? null : live.rssPercent / 100;
    var bufferFraction = buffered === null || !caps.maxBufferedBytes ? null : buffered / caps.maxBufferedBytes;

    var tiles = [
      { label: "Connections", value: fmtInt(live.activeConnections) + " / " + fmtInt(caps.maxConnections),
        note: "cap refuses new sockets at 100%", fraction: connectionFraction },
      { label: "Live sessions", value: fmtInt(live.pairedSlots),
        note: fmtInt(live.waitingSlots) + " waiting to pair" },
      { label: "Slowest consumer", value: buffered === null ? "n/a" : fmtBytes(buffered),
        note: backlogged === null ? "queue depth, sampled" : fmtInt(backlogged) + " connection(s) backing up",
        fraction: bufferFraction },
      { label: "Memory", value: fmtBytes(live.rssBytes),
        note: caps.memoryLimitBytes ? "of " + fmtBytes(caps.memoryLimitBytes) : "no container limit found",
        fraction: memoryFraction },
      { label: "CPU", value: fmtPercent(live.cpuPercent), note: "of one core",
        fraction: live.cpuPercent === null ? null : live.cpuPercent / 100 },
      { label: "Event loop p99", value: fmtMs(live.eventLoopLagP99Ms),
        note: "above ~50 ms delays every forward",
        fraction: live.eventLoopLagP99Ms === null ? null : live.eventLoopLagP99Ms / 200 },
      { label: "Uptime", value: fmtDuration(live.uptimeSeconds), note: "since last restart" },
      { label: "Bytes forwarded", value: fmtBytes(live.bytesForwardedTotal), note: "egress, since restart" }
    ];

    var html = "";
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i], status = statusOf(tile.fraction);
      // The percentage is always spelled out, never carried by the dot colour
      // alone.
      var badge = status
        ? '<span class="badge ' + status + '">' + Math.round(tile.fraction * 100) + "%</span>"
        : "";
      html += '<div class="tile"><div class="label">' + esc(tile.label) + badge + '</div><div class="value">' +
        esc(tile.value) + "</div>" + (tile.note ? '<div class="note">' + esc(tile.note) + "</div>" : "") + "</div>";
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
    var rows = plotRows().slice(-500).reverse();
    // Peak and average are separate columns rather than one cell, because the
    // gap between them is the whole point on an aggregated row.
    var html = '<div class="card"><h2>Table view</h2><p class="hint">Most recent ' + rows.length +
      ' sampled intervals, newest first. Rates are derived from each row\\u2019s own window, so a short or aggregated row is still correct. ' +
      'Peak and avg differ only on aggregated rows (30d and 1y); shorter ranges are raw point samples.</p>' +
      '<div class="tablewrap"><table><thead><tr>' +
      "<th>Time</th><th>Res</th><th>Active peak</th><th>Active avg</th><th>Paired peak</th><th>Waiting</th>" +
      "<th>Frames/s</th><th>Bytes/s</th><th>Conns</th><th>Sessions</th><th>Teardowns</th><th>Rejects</th>" +
      "<th>CPU %</th><th>Loop p99</th><th>RSS %</th></tr></thead><tbody>";

    function cell(value, formatted) {
      return '<td' + (value ? '' : ' class="zero"') + ">" + formatted + "</td>";
    }
    function sumValues(record) {
      var total = 0;
      for (var key in record) total += record[key];
      return total;
    }

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var teardowns = sumValues(r.closedByCause);
      var rejects = sumValues(r.rejectsByReasonDelta);
      var resolution = r.resolutionSeconds >= 3600 ? r.resolutionSeconds / 3600 + "h" : r.resolutionSeconds / 60 + "m";
      html += '<tr' + (r.restartCount > 0 ? ' class="restart"' : "") + '><td>' + esc(fmtTime(r.timestampMs)) +
        (r.restartCount > 0 ? " &middot; restart" : "") + "</td><td>" + resolution + "</td>" +
        cell(r.activeConnections.maximum, fmtCount(r.activeConnections.maximum)) +
        cell(r.activeConnections.mean, r.activeConnections.mean === null ? "n/a" : fmtCount(r.activeConnections.mean)) +
        cell(r.pairedSlots.maximum, fmtCount(r.pairedSlots.maximum)) +
        cell(r.waitingSlots.maximum, fmtCount(r.waitingSlots.maximum)) +
        cell(r.framesForwardedDelta, fmtCount(perSecond(r, "framesForwardedDelta"))) +
        cell(r.bytesForwardedDelta, esc(fmtBytes(perSecond(r, "bytesForwardedDelta")))) +
        cell(r.connectionsDelta, fmtCount(r.connectionsDelta)) +
        cell(r.sessionsDelta, fmtCount(r.sessionsDelta)) +
        cell(teardowns, fmtCount(teardowns)) +
        cell(rejects, fmtCount(rejects)) +
        cell(r.cpuPercent, r.cpuPercent ? fmtCount(r.cpuPercent.maximum) : "n/a") +
        cell(r.eventLoopLagP99Ms, r.eventLoopLagP99Ms === null ? "n/a" : fmtCount(r.eventLoopLagP99Ms)) +
        cell(r.rssPercent, r.rssPercent === null ? "n/a" : fmtCount(r.rssPercent)) +
        "</tr>";
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
    state.statusText = text;
    state.statusClass = cls || "";
    paintStatus();
  }

  // Three missed polls. Long enough that ordinary jitter never trips it, short
  // enough that a wedged relay is obvious within a few seconds.
  var STALE_AFTER_MS = POLL_MS * 3;

  /**
   * The age is shown only once it means something.
   *
   * Reporting it continuously looks more informative than it is: at a 2s poll
   * the number just oscillates between 0 and 2 forever, so the label rewrites
   * itself every second while carrying no information, and the motion pulls
   * the eye away from the charts. Below the staleness threshold this reads a
   * flat "Live". Past it the number appears and the dot stops pulsing, because
   * at that point how long ago is exactly the thing you need to know.
   */
  function paintStatus() {
    var label = state.statusText, statusClass = state.statusClass;
    if (state.statusText === "live") {
      var ageMs = state.lastUpdateMs ? Date.now() - state.lastUpdateMs : 0;
      if (ageMs >= STALE_AFTER_MS) {
        label = "Stale &middot; " + Math.round(ageMs / 1000) + "s ago";
        statusClass = "paused";
      } else {
        label = "Live";
      }
    }
    document.getElementById("statusText").innerHTML = label;
    document.getElementById("dot").className = "dot" + (statusClass ? " " + statusClass : "");
  }

  function apply(payload, replace) {
    var seenInstance = payload.meta.instanceId;
    if (IS_LOCAL && state.instanceId && seenInstance && seenInstance !== state.instanceId) {
      location.reload();
      return;
    }
    if (seenInstance) state.instanceId = seenInstance;

    var nowMs = Date.now();
    if (state.previousLive) {
      state.liveRows.push(synthesizeLiveRow(state.previousLive, payload.live, state.previousLiveAtMs, nowMs));
      trimLiveWindow(nowMs);
    }
    state.previousLive = payload.live;
    state.previousLiveAtMs = nowMs;

    state.live = payload.live;
    state.meta = payload.meta;
    if (replace) state.rows = payload.rows;
    else if (payload.rows.length) state.rows = state.rows.concat(payload.rows);
    if (state.rangeMs !== LIVE_RANGE) {
      var oldest = payload.meta.serverTimeMs - state.rangeMs;
      state.rows = state.rows.filter(function (r) { return r.timestampMs >= oldest; });
    }
    if (payload.cursorMs) state.cursorMs = payload.cursorMs;
    render();
  }

  /**
   * Fills the Live window from history the moment it is opened.
   *
   * Without this the view starts empty and grows one point every couple of
   * seconds, so a button labelled "Live" would show five seconds of data and
   * the window would silently be "however long you have had this tab open".
   * Seeding makes it always a real 15 minutes: recorded rows behind, poll rows
   * in front, refining from 60-second to 2-second resolution as they arrive.
   * Every count is plotted as a rate, so the change of resolution at the seam
   * does not show up as a step.
   */
  async function seedLiveFromHistory() {
    try {
      var response = await fetch("/admin/data?range=" + LIVE_WINDOW_MS, { headers: { accept: "application/json" } });
      if (response.ok) {
        var payload = await response.json();
        var nowMs = Date.now();
        var oldestLiveMs = state.liveRows.length ? state.liveRows[0].timestampMs : Infinity;
        var seed = payload.rows.filter(function (row) { return row.timestampMs < oldestLiveMs; });
        state.liveRows = seed.concat(state.liveRows);
        trimLiveWindow(nowMs);

        // This response carries live counters and meta too, so adopting them
        // here means the tiles are populated on first paint instead of empty
        // until the first poll lands. Recording it as the previous sample also
        // lets the very next poll produce a point rather than only priming.
        state.live = payload.live;
        state.meta = payload.meta;
        state.previousLive = payload.live;
        state.previousLiveAtMs = nowMs;
        state.lastUpdateMs = nowMs;
        if (payload.meta.instanceId) state.instanceId = payload.meta.instanceId;
        setStatus("live", "");
      }
    } catch (error) {
      // Seeding is an improvement, not a requirement: without it the view
      // still fills in from the poll, just more slowly.
    }
    render();
  }

  function trimLiveWindow(nowMs) {
    var oldestMs = nowMs - LIVE_WINDOW_MS;
    while (state.liveRows.length && state.liveRows[0].timestampMs < oldestMs) state.liveRows.shift();
  }

  async function load(replace) {
    var url = replace ? "/admin/data?range=" + state.rangeMs : "/admin/data?since=" + state.cursorMs;
    try {
      var response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      apply(await response.json(), replace);
      state.failures = 0;
      state.lastUpdateMs = Date.now();
      setStatus("live", "");
    } catch (error) {
      state.failures++;
      setStatus("Disconnected (" + state.failures + ")", "bad");
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
    if (document.visibilityState === "hidden") { stopPolling(); setStatus("Paused (tab hidden)", "paused"); }
    else { load(false); startPolling(); }
  });

  var buttons = document.querySelectorAll("button[data-range]");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function (event) {
      state.rangeMs = Number(event.target.getAttribute("data-range"));
      for (var b = 0; b < buttons.length; b++) buttons[b].setAttribute("aria-pressed", buttons[b] === event.target ? "true" : "false");
      if (state.rangeMs === LIVE_RANGE) seedLiveFromHistory();
      else load(true);
    });
    if (Number(buttons[i].getAttribute("data-range")) === state.rangeMs) buttons[i].setAttribute("aria-pressed", "true");
  }
  document.getElementById("tableToggle").addEventListener("click", function (event) {
    state.table = !state.table;
    event.target.setAttribute("aria-pressed", state.table ? "true" : "false");
    render();
  });

  // Repaints only the freshness label, so the age keeps counting up between
  // polls and visibly stalls if the relay stops answering.
  var freshnessTimer = setInterval(paintStatus, 1000);
  window.addEventListener("beforeunload", function () { clearInterval(freshnessTimer); });

  // Live needs its window seeded, not a history range fetched.
  var firstPaint = state.rangeMs === LIVE_RANGE ? seedLiveFromHistory() : load(true);
  firstPaint.then(startPolling);
})();
</script>
</body>
</html>
`;
