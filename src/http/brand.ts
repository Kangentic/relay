/**
 * Vendored verbatim from @kangentic/branding@2.2.0 assets/brandmark-small.svg
 * (the F4k board glyph). That package's mark is a two-tier system keyed to
 * displayed size, not raster resolution: the card-K above 48px, this glyph
 * wherever the OS shows the mark small. A favicon renders at 16-32px, so it
 * takes this tier. Never hand-edit this string; pull a fresh copy from
 * https://github.com/Kangentic/branding if the mark changes.
 *
 * It lives here rather than in one page because both the landing page and the
 * admin dashboard need it, and two hand-maintained copies of a vendored asset
 * is how they drift apart. Vendored rather than imported because `ws` is the
 * relay's only production dependency.
 */
export const BRANDMARK_SMALL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
    <defs><mask id="m">
      <circle cx="256" cy="256" r="256" fill="#fff"/>
      <g transform="scale(5.12)"><g transform="translate(-9,-9) scale(1.18)"><rect x="27" y="25" width="12.5" height="44" rx="3" fill="#000"/>
            <rect x="43.5" y="25" width="12.5" height="24" rx="3" fill="#000"/>
            <rect x="60" y="25" width="12.5" height="44" rx="3" fill="#000"/></g></g>
    </mask></defs>
    <circle cx="256" cy="256" r="256" fill="#c0562f" mask="url(#m)"/>
    <g transform="scale(5.12)"><g transform="translate(-9,-9) scale(1.18)"><rect x="43.5" y="55" width="12.5" height="14" rx="3" fill="#e8a33d"/></g></g>
  </svg>`;

export const FAVICON_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(BRANDMARK_SMALL_SVG).toString('base64')}`;
