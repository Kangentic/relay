import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Vendored verbatim from @kangentic/branding@2.2.0 assets/brandmark.svg (the
 * card-K mark, used at >= 48px per that package's two-tier sizing rule).
 * Never hand-edit this string; pull a fresh copy from
 * https://github.com/Kangentic/branding if the mark changes.
 */
const BRANDMARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
    <defs><mask id="m">
      <circle cx="256" cy="256" r="256" fill="#fff"/>
      <g transform="scale(5.12)"><g transform="translate(50,50) scale(1.1014796117174366) translate(-50,-51.34228515625)"><rect x="22.009765625" y="18.6845703125" width="55.98046875" height="65.3154296875" rx="7.5" fill="#000"/></g></g>
    </mask></defs>
    <circle cx="256" cy="256" r="256" fill="#c0562f" mask="url(#m)"/>
    <g transform="scale(5.12)"><g transform="translate(50,50) scale(1.1014796117174366) translate(-50,-51.34228515625)"><mask id="kg31"><rect x="-50" y="-50" width="200" height="200" fill="#fff"/><rect x="53.5" y="25.9" width="4.5" height="26" transform="rotate(-38 55.75 38.9)" fill="#000"/></mask>
    <g mask="url(#kg31)"><g transform="translate(20.68359375,5.7485651397705055) scale(0.79)"><path d="M8.0078125,22.70380401611328L23.779296875,22.70380401611328 23.779296875,55.80927276611328 24.0234375,55.80927276611328 24.365232467651367,55.05243682861328 24.804685592651367,54.14911651611328 25.341794967651367,53.09931182861328 25.9765625,51.90302276611328 45.3125,22.70380401611328 64.111328125,22.70380401611328 39.697265625,56.10224151611328 66.2109375,92.72333526611328 46.2890625,92.72333526611328 25.87890625,62.30341339111328 25.543212890625,61.73273468017578 25.1220703125,60.89960479736328 24.615478515625,59.80402374267578 24.0234375,58.44599151611328 23.779296875,58.44599151611328 23.779296875,92.72333526611328 8.0078125,92.72333526611328 8.0078125,22.70380401611328z" fill="#c0562f"/></g></g><clipPath id="kt32"><polygon points="-188.74156593464818,-277.68953976217153 303.7876143258784,352.71906312320607 618.9919157685672,106.45447299294278 126.46273550804062,-523.9541298924348"/></clipPath>
    <g clip-path="url(#kt32)"><g transform="translate(20.68359375,5.7485651397705055) scale(0.79)"><path d="M8.0078125,22.70380401611328L23.779296875,22.70380401611328 23.779296875,55.80927276611328 24.0234375,55.80927276611328 24.365232467651367,55.05243682861328 24.804685592651367,54.14911651611328 25.341794967651367,53.09931182861328 25.9765625,51.90302276611328 45.3125,22.70380401611328 64.111328125,22.70380401611328 39.697265625,56.10224151611328 66.2109375,92.72333526611328 46.2890625,92.72333526611328 25.87890625,62.30341339111328 25.543212890625,61.73273468017578 25.1220703125,60.89960479736328 24.615478515625,59.80402374267578 24.0234375,58.44599151611328 23.779296875,58.44599151611328 23.779296875,92.72333526611328 8.0078125,92.72333526611328 8.0078125,22.70380401611328z" fill="#e8a33d"/></g></g></g></g>
  </svg>`;

const BRANDMARK_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(BRANDMARK_SVG).toString('base64')}`;

/**
 * Vendored verbatim from @kangentic/branding@2.2.0 assets/brandmark-small.svg
 * (the F4k board glyph). That package's mark is a two-tier system keyed to
 * displayed size, not raster resolution: the card-K above 48px, this glyph
 * wherever the OS shows the mark small. A favicon renders at 16-32px, so it
 * takes this tier, not BRANDMARK_SVG. Never hand-edit this string; pull a
 * fresh copy from https://github.com/Kangentic/branding if the mark changes.
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
 * only, and the mark is inlined as a data URI rather than a linked asset.
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
    --cream: #fdfbf7;
    --ink: #24201b;
    --ink-soft: #6e6659;
    --rust: #c0562f;
    --radius: 8px;
  }
  html, body {
    margin: 0;
    height: 100%;
  }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--cream);
    color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main {
    max-width: 34rem;
    padding: 2rem;
    text-align: center;
  }
  img {
    width: 96px;
    height: 96px;
  }
  h1 {
    margin: 1.25rem 0 0.75rem;
    font-size: 1.75rem;
  }
  p {
    margin: 0 0 1rem;
    color: var(--ink-soft);
    line-height: 1.5;
  }
  a {
    color: var(--rust);
  }
</style>
</head>
<body>
<main>
  <img src="${BRANDMARK_DATA_URI}" alt="" width="96" height="96">
  <h1>Kangentic Relay</h1>
  <p>
    This host runs a blind WebSocket rendezvous relay for the Kangentic desktop app's mobile
    companion. It pairs two connections that present the same slot id and forwards ciphertext
    between them. It authenticates nothing and reads nothing.
  </p>
  <p><a href="https://github.com/Kangentic/relay">Source on GitHub</a></p>
</main>
</body>
</html>
`;

export function handleLandingRequest(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(LANDING_PAGE_HTML);
}
