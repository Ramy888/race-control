import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { alias } from '../web/build.js';
import { flush } from './helpers.js';

test('shared browser page auto-plays the real bundled session, posts overlay snapshots, and resets without network', async () => {
  class Element {
    textContent = ''; className = ''; value = ''; disabled = false; hidden = true;
    style: Record<string, string> = {}; children: Element[] = [];
    classList = { toggle() {} };
    listeners = new Map<string, (...args: any[]) => unknown>();
    append(...nodes: Element[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Element[]) { this.children = nodes; }
    addEventListener(name: string, callback: (...args: any[]) => unknown) { this.listeners.set(name, callback); }
  }
  const nodes = new Map<string, Element>(), overlayNodes = new Map<string, Element>();
  const node = (map: Map<string, Element>, id: string) => {
    if (!map.has(id)) map.set(id, new Element()); return map.get(id)!;
  };
  const origin = 'https://example.test', parent = {};
  let overlayMessage!: (event: unknown) => void;
  const overlayContext = createContext({
    document: { getElementById: (id: string) => node(overlayNodes, id), createElement: () => new Element() },
    location: { search: '?browser=1', origin }, parent, window: {}, URLSearchParams,
    innerWidth: 354, innerHeight: 354 * 9 / 16,
    addEventListener: (name: string, listener: (event: unknown) => void) => { if (name === 'message') overlayMessage = listener; },
    WebSocket: class { constructor() { throw new Error('Unexpected WebSocket'); } },
  });
  const overlay = await readFile('public/overlay.html', 'utf8');
  runInContext(overlay.match(/<script>([\s\S]*?)<\/script>/)![1]!, overlayContext);
  const frame = Object.assign(new Element(), { contentWindow: { postMessage(data: unknown, destination: string) {
    assert.equal(destination, origin); overlayMessage({ data, origin, source: parent });
  } } });
  nodes.set('overlay', frame);
  const hudReadings: number[] = [];
  nodes.set('hud', Object.assign(new Element(), { contentWindow: { postMessage(data: { kills: number }) { hudReadings.push(data.kills); } } }));
  let now = 0, id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const noNetwork = () => { throw new Error('Browser playground made a network request'); };
  const context = createContext({
    document: { getElementById: (id: string) => node(nodes, id), createElement: () => new Element(),
      querySelector: (selector: string) => selector === 'iframe' ? frame : node(nodes, selector) },
    location: { origin }, structuredClone, crypto: globalThis.crypto, AbortController,
    Date: class extends Date { static override now() { return now; } },
    setTimeout: (callback: () => void, delay: number) => { timers.set(++id, { at: now + delay, callback }); return id; },
    clearTimeout: (id: number) => timers.delete(id), setInterval: () => {}, addEventListener: () => {},
    fetch: noNetwork, WebSocket: noNetwork, EventSource: noNetwork,
  });
  const bundle = await build({ entryPoints: ['web/browser.ts'], write: false, bundle: true, alias,
    format: 'iife', platform: 'browser', define: { 'import.meta.url': '"https://browser.invalid/"' } });
  runInContext(bundle.outputFiles[0]!.text, context);
  const html = await readFile('public/demo.html', 'utf8');
  runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]!, context);
  await flush();
  assert.equal(node(nodes, 'playground-banner').hidden, false);
  assert.equal(node(nodes, 'quick').children.length, 13);
  assert.equal(node(nodes, 'auto').disabled, false);
  let done = false;
  const autoplay = runInContext('autoplay()', context) as Promise<void>;
  void autoplay.then(() => { done = true; });
  for (let i = 0; i < 500 && !done; i++) {
    now += 100;
    for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.callback(); }
    await flush();
  }
  assert.equal(done, true, 'auto-play finishes without wall-clock sleeps'); await autoplay;
  assert.equal(node(nodes, 'status').textContent, 'Complete · standings replayed');
  assert.ok(hudReadings.includes(0));
  assert.ok(hudReadings.includes(8));
  assert.equal(hudReadings.at(-1), 8);
  assert.equal(node(overlayNodes, 'result').textContent, 'DARE WON');
  assert.match(node(overlayNodes, 'house-rule').textContent, /wrong calls lose a point/);
  assert.match(node(overlayNodes, 'stage').style.transform!, /scale\(0.184375\)/);
  // Spoofed cross-origin snapshots never enter the renderer.
  overlayMessage({ source: parent, origin: 'https://other.test', data: { type: 'race-overlay', view: {} } });
  await runInContext("send('streamer', '!rule anything else')", context);
  const content = (element: Element): string => element.textContent + element.children.map(content).join(' ');
  assert.match(content(node(nodes, 'transcript')), /hosted demo has 2 recorded rules/);
  await runInContext('reset(new AbortController().signal)', context);
  assert.equal(node(overlayNodes, 'phase').textContent, 'RESOLVED');
  assert.equal(runInContext('localSession.ledger.state.dareCount', context), 3);
  assert.match(content(node(nodes, 'transcript').children[0]!), /loaded 3 earlier dares/);
});
