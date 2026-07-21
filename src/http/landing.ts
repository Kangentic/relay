import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Vendored verbatim from @kangentic/branding@2.2.0 assets/mascot/overseer.svg
 * (the Overseer, the Kangentic mascot's canonical resting frame). Each
 * frame carries its own role="img" aria-label from upstream; the three
 * frames are stacked in LANDING_PAGE_HTML, so the individual frames are
 * hidden from assistive tech there and a single label is given to the
 * stack as a whole. Never hand-edit this string; pull a fresh copy from
 * https://github.com/Kangentic/branding if the mark changes.
 */
const MASCOT_BASE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 12" width="18" height="12" shape-rendering="crispEdges" role="img" aria-label="Pixel-art Kangentic mascot"><rect x="5" y="0" width="8" height="1" fill="#e8a33d"/><rect x="3" y="1" width="12" height="1" fill="#e8a33d"/><rect x="2" y="2" width="14" height="1" fill="#e8a33d"/><rect x="2" y="3" width="2" height="1" fill="#e8a33d"/><rect x="4" y="3" width="1" height="1" fill="#24201b"/><rect x="5" y="3" width="1" height="1" fill="#fdfbf7"/><rect x="6" y="3" width="2" height="1" fill="#e8a33d"/><rect x="8" y="3" width="1" height="1" fill="#24201b"/><rect x="9" y="3" width="1" height="1" fill="#fdfbf7"/><rect x="10" y="3" width="2" height="1" fill="#e8a33d"/><rect x="12" y="3" width="1" height="1" fill="#24201b"/><rect x="13" y="3" width="1" height="1" fill="#fdfbf7"/><rect x="14" y="3" width="2" height="1" fill="#e8a33d"/><rect x="2" y="4" width="2" height="1" fill="#e8a33d"/><rect x="4" y="4" width="2" height="1" fill="#24201b"/><rect x="6" y="4" width="2" height="1" fill="#e8a33d"/><rect x="8" y="4" width="2" height="1" fill="#24201b"/><rect x="10" y="4" width="2" height="1" fill="#e8a33d"/><rect x="12" y="4" width="2" height="1" fill="#24201b"/><rect x="14" y="4" width="2" height="1" fill="#e8a33d"/><rect x="0" y="5" width="18" height="1" fill="#e8a33d"/><rect x="0" y="6" width="18" height="1" fill="#e8a33d"/><rect x="2" y="7" width="14" height="1" fill="#e8a33d"/><rect x="2" y="8" width="14" height="1" fill="#e8a33d"/><rect x="3" y="9" width="12" height="1" fill="#e8a33d"/><rect x="4" y="10" width="2" height="1" fill="#e8a33d"/><rect x="8" y="10" width="2" height="1" fill="#e8a33d"/><rect x="12" y="10" width="2" height="1" fill="#e8a33d"/><rect x="4" y="11" width="2" height="1" fill="#e8a33d"/><rect x="8" y="11" width="2" height="1" fill="#e8a33d"/><rect x="12" y="11" width="2" height="1" fill="#e8a33d"/></svg>`;

/**
 * Vendored verbatim from @kangentic/branding@2.2.0
 * assets/mascot/overseer-wave.svg. Plays once on page load, then yields to
 * MASCOT_BASE_SVG. Never hand-edit; see MASCOT_BASE_SVG's comment.
 */
const MASCOT_WAVE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 12" width="18" height="12" shape-rendering="crispEdges" role="img" aria-label="Pixel-art Kangentic mascot"><rect x="5" y="0" width="8" height="1" fill="#e8a33d"/><rect x="3" y="1" width="12" height="1" fill="#e8a33d"/><rect x="2" y="2" width="14" height="1" fill="#e8a33d"/><rect x="2" y="3" width="2" height="1" fill="#e8a33d"/><rect x="4" y="3" width="1" height="1" fill="#24201b"/><rect x="5" y="3" width="1" height="1" fill="#fdfbf7"/><rect x="6" y="3" width="2" height="1" fill="#e8a33d"/><rect x="8" y="3" width="1" height="1" fill="#24201b"/><rect x="9" y="3" width="1" height="1" fill="#fdfbf7"/><rect x="10" y="3" width="2" height="1" fill="#e8a33d"/><rect x="12" y="3" width="1" height="1" fill="#24201b"/><rect x="13" y="3" width="1" height="1" fill="#fdfbf7"/><rect x="14" y="3" width="2" height="1" fill="#e8a33d"/><rect x="2" y="4" width="2" height="1" fill="#e8a33d"/><rect x="4" y="4" width="2" height="1" fill="#24201b"/><rect x="6" y="4" width="2" height="1" fill="#e8a33d"/><rect x="8" y="4" width="2" height="1" fill="#24201b"/><rect x="10" y="4" width="2" height="1" fill="#e8a33d"/><rect x="12" y="4" width="2" height="1" fill="#24201b"/><rect x="14" y="4" width="4" height="1" fill="#e8a33d"/><rect x="0" y="5" width="18" height="1" fill="#e8a33d"/><rect x="0" y="6" width="16" height="1" fill="#e8a33d"/><rect x="2" y="7" width="14" height="1" fill="#e8a33d"/><rect x="2" y="8" width="14" height="1" fill="#e8a33d"/><rect x="3" y="9" width="12" height="1" fill="#e8a33d"/><rect x="4" y="10" width="2" height="1" fill="#e8a33d"/><rect x="8" y="10" width="2" height="1" fill="#e8a33d"/><rect x="12" y="10" width="2" height="1" fill="#e8a33d"/><rect x="4" y="11" width="2" height="1" fill="#e8a33d"/><rect x="8" y="11" width="2" height="1" fill="#e8a33d"/><rect x="12" y="11" width="2" height="1" fill="#e8a33d"/></svg>`;

/**
 * Vendored verbatim from @kangentic/branding@2.2.0
 * assets/mascot/overseer-blink.svg. Flashed briefly and infrequently as an
 * ambient idle animation. Never hand-edit; see MASCOT_BASE_SVG's comment.
 */
const MASCOT_BLINK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 12" width="18" height="12" shape-rendering="crispEdges" role="img" aria-label="Pixel-art Kangentic mascot"><rect x="5" y="0" width="8" height="1" fill="#e8a33d"/><rect x="3" y="1" width="12" height="1" fill="#e8a33d"/><rect x="2" y="2" width="14" height="1" fill="#e8a33d"/><rect x="2" y="3" width="14" height="1" fill="#e8a33d"/><rect x="2" y="4" width="2" height="1" fill="#e8a33d"/><rect x="4" y="4" width="2" height="1" fill="#24201b"/><rect x="6" y="4" width="2" height="1" fill="#e8a33d"/><rect x="8" y="4" width="2" height="1" fill="#24201b"/><rect x="10" y="4" width="2" height="1" fill="#e8a33d"/><rect x="12" y="4" width="2" height="1" fill="#24201b"/><rect x="14" y="4" width="2" height="1" fill="#e8a33d"/><rect x="0" y="5" width="18" height="1" fill="#e8a33d"/><rect x="0" y="6" width="18" height="1" fill="#e8a33d"/><rect x="2" y="7" width="14" height="1" fill="#e8a33d"/><rect x="2" y="8" width="14" height="1" fill="#e8a33d"/><rect x="3" y="9" width="12" height="1" fill="#e8a33d"/><rect x="4" y="10" width="2" height="1" fill="#e8a33d"/><rect x="8" y="10" width="2" height="1" fill="#e8a33d"/><rect x="12" y="10" width="2" height="1" fill="#e8a33d"/><rect x="4" y="11" width="2" height="1" fill="#e8a33d"/><rect x="8" y="11" width="2" height="1" fill="#e8a33d"/><rect x="12" y="11" width="2" height="1" fill="#e8a33d"/></svg>`;

/**
 * Vendored verbatim from @kangentic/branding@2.2.0 assets/brandmark-small.svg
 * (the F4k board glyph). That package's mark is a two-tier system keyed to
 * displayed size, not raster resolution: the card-K above 48px, this glyph
 * wherever the OS shows the mark small. A favicon renders at 16-32px, so it
 * takes this tier. Never hand-edit this string; pull a fresh copy from
 * https://github.com/Kangentic/branding if the mark changes.
 */
const BRANDMARK_SMALL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
    <defs><mask id="m">
      <circle cx="256" cy="256" r="256" fill="#fff"/>
      <g transform="scale(5.12)"><g transform="translate(-9,-9) scale(1.18)"><rect x="27" y="25" width="12.5" height="44" rx="3" fill="#000"/>
            <rect x="43.5" y="25" width="12.5" height="24" rx="3" fill="#000"/>
            <rect x="60" y="25" width="12.5" height="44" rx="3" fill="#000"/></g></g>
    </mask></defs>
    <circle cx="256" cy="256" r="256" fill="#c0562f" mask="url(#m)"/>
    <g transform="scale(5.12)"><g transform="translate(-9,-9) scale(1.18)"><rect x="43.5" y="55" width="12.5" height="14" rx="3" fill="#e8a33d"/></g></g>
  </svg>`;

const FAVICON_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(BRANDMARK_SMALL_SVG).toString('base64')}`;

/**
 * A static splash page for a plain GET /, so the relay's hostname does not
 * show a blank page when visited directly in a browser. Deliberately makes
 * zero external requests (no font CDN, no analytics): a system font stack
 * only, and every mark is inlined rather than linked. The mascot frames are
 * inlined as raw <svg> (not a data URI) so CSS can cross-fade between them
 * for the entrance wave and idle blink; sizing and hiding the individual
 * frames from assistive tech both happen in CSS, not by touching the
 * vendored strings. prefers-reduced-motion drops both animations and
 * leaves the resting frame in place.
 */
const LANDING_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kangentic Relay</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">
<style>
  :root {
    color-scheme: light;
    --cream: #fdfbf7;
    --ink: #24201b;
    --ink-soft: #6e6659;
    --rust: #c0562f;
    --amber: #e8a33d;
    --terminal: #1d1915;
    --term-text: #f3ede3;
    --hairline: rgba(36, 32, 27, 0.14);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    min-height: 100%;
    background: var(--cream);
  }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 2rem 1.5rem;
    color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: min(92vw, 34rem);
    text-align: center;
  }

  .mascot {
    position: relative;
    width: 198px;
    height: 132px;
  }
  .mascot div {
    position: absolute;
    inset: 0;
  }
  .mascot svg {
    display: block;
    width: 100%;
    height: 100%;
  }
  .frame-base { opacity: 1; }
  .frame-wave {
    opacity: 0;
    animation: wave-in 900ms ease-out 200ms 1 both;
  }
  .frame-blink {
    opacity: 0;
    animation: blink 5200ms ease-in-out 1500ms infinite;
  }
  @keyframes wave-in {
    0% { opacity: 1; }
    70% { opacity: 1; }
    100% { opacity: 0; }
  }
  @keyframes blink {
    0%, 92%, 100% { opacity: 0; }
    94%, 96% { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .frame-wave, .frame-blink { animation: none; opacity: 0; }
  }

  .eyebrow {
    margin: 1.5rem 0 0;
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 0.72rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink-soft);
  }
  h1 {
    margin: 0.6rem 0 0;
    font-size: 1.9rem;
    font-weight: 800;
    letter-spacing: -0.01em;
    line-height: 1.15;
    text-wrap: balance;
  }
  .sub {
    margin: 0.85rem 0 0;
    color: var(--ink-soft);
    line-height: 1.5;
    white-space: nowrap;
    font-size: clamp(0.72rem, 3vw, 1rem);
  }

  .chip {
    margin-top: 1.4rem;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--terminal);
    color: var(--term-text);
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 0.88rem;
    padding: 0.55rem 0.9rem;
    border-radius: 8px;
  }
  .chip::before {
    content: "$";
    color: var(--amber);
  }

  footer {
    margin-top: 1.75rem;
    padding-top: 1.1rem;
    border-top: 1px solid var(--hairline);
    width: 100%;
  }
  footer a {
    color: var(--ink-soft);
    font-size: 0.82rem;
    text-decoration: none;
  }
  footer a:hover,
  footer a:focus-visible {
    color: var(--rust);
    text-decoration: underline;
  }
  a:focus-visible {
    outline: 2px solid var(--rust);
    outline-offset: 3px;
    border-radius: 2px;
  }
</style>
</head>
<body>
<main>
  <div class="mascot" role="img" aria-label="The Overseer, the Kangentic mascot">
    <div class="frame-base" aria-hidden="true">${MASCOT_BASE_SVG}</div>
    <div class="frame-wave" aria-hidden="true">${MASCOT_WAVE_SVG}</div>
    <div class="frame-blink" aria-hidden="true">${MASCOT_BLINK_SVG}</div>
  </div>

  <p class="eyebrow">kangentic relay</p>
  <h1>The Overseer sees nothing.</h1>
  <p class="sub">It just passes ciphertext between your phone and your desktop.</p>
  <p class="chip">bytes read: 0</p>

  <footer>
    <a href="https://github.com/Kangentic/relay">Source</a>
  </footer>
</main>
</body>
</html>
`;

export function handleLandingRequest(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(LANDING_PAGE_HTML);
}
