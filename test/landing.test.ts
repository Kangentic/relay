import { describe, it, expect, afterEach } from 'vitest';
import { startTestRelay, type RelayHarness } from './helpers/relayHarness.js';
import { connectTestClient } from './helpers/wsClient.js';

describe('landing page', () => {
  let relay: RelayHarness | undefined;

  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it('GET / returns a static HTML splash page', async () => {
    relay = await startTestRelay();
    const response = await fetch(`${relay.url.replace('ws://', 'http://')}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    const body = await response.text();
    expect(body).toContain('Kangentic Relay');
    expect(body).toContain('https://github.com/Kangentic/relay');
  });

  it('makes zero external subresource requests', async () => {
    relay = await startTestRelay();
    const response = await fetch(`${relay.url.replace('ws://', 'http://')}/`);
    const body = await response.text();
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
    const offHostUrls = [...body.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)["']/gi)]
      .map((match) => match[1])
      .filter((url) => !url?.startsWith('https://github.com/Kangentic/relay'));
    expect(offHostUrls).toEqual([]);
  });

  it('embeds the brandmark as a decodable inline SVG data URI', async () => {
    relay = await startTestRelay();
    const response = await fetch(`${relay.url.replace('ws://', 'http://')}/`);
    const body = await response.text();
    const imageMatch = body.match(/<img src="data:image\/svg\+xml;base64,([^"]+)"/);
    expect(imageMatch).not.toBeNull();
    const decodedSvg = Buffer.from(imageMatch?.[1] ?? '', 'base64').toString('utf8');
    expect(decodedSvg).toContain('<svg');
    expect(decodedSvg).toContain('</svg>');
  });

  it('sets a favicon using the small-tier board glyph, not the card-K mark', async () => {
    relay = await startTestRelay();
    const response = await fetch(`${relay.url.replace('ws://', 'http://')}/`);
    const body = await response.text();
    const iconMatch = body.match(
      /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml;base64,([^"]+)"/,
    );
    expect(iconMatch).not.toBeNull();
    const decodedIcon = Buffer.from(iconMatch?.[1] ?? '', 'base64').toString('utf8');
    // The branding package keys its two tiers to displayed size: the card-K is
    // a <path>, the small board glyph is plain <rect>s. A favicon renders at
    // 16-32px, so it must be the glyph tier.
    expect(decodedIcon).toContain('<rect');
    expect(decodedIcon).not.toContain('<path');

    const imageMatch = body.match(/<img src="data:image\/svg\+xml;base64,([^"]+)"/);
    expect(iconMatch?.[1]).not.toBe(imageMatch?.[1]);
  });

  it('a WebSocket upgrade at / still works alongside the HTML route', async () => {
    relay = await startTestRelay();
    const httpResponse = await fetch(`${relay.url.replace('ws://', 'http://')}/`);
    expect(httpResponse.status).toBe(200);
    const client = await connectTestClient(relay.url, 'a'.repeat(64));
    expect(client.socket.readyState).toBe(client.socket.OPEN);
    client.close();
  });

  it('an unknown path still 404s', async () => {
    relay = await startTestRelay();
    const response = await fetch(`${relay.url.replace('ws://', 'http://')}/unknown`);
    expect(response.status).toBe(404);
  });
});
