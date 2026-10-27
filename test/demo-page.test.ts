import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

async function browser(mode: 'ready' | 'unavailable' | 'timeout') {
  class Element {
    textContent = ''; className = ''; value = ''; disabled = false; type = ''; scrollTop = 0; scrollHeight = 0;
    children: Element[] = []; listeners = new Map<string, (...args: unknown[]) => unknown>();
    append(...nodes: Element[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Element[]) { this.children = nodes; }
    addEventListener(name: string, callback: (...args: unknown[]) => unknown) { this.listeners.set(name, callback); }
  }
  const nodes = new Map<string, Element>();
  const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!; };
  let socket!: Socket, feed!: Feed, now = 0, predicts = 0, kills = 0;
  class Socket { onmessage?: (event: { data: string }) => void; constructor() { socket = this; } }
  class Feed { onopen?: () => void; onmessage?: (event: { data: string }) => void; constructor() { feed = this; } }
  type View = { serverNow: number; dare: null | { status: string; options: { title: string }[]; target: { count: number }; voteEndsAt: string }; pendingRule: object | null; houseRule: string | null };
  let view: View = { serverNow: 0, dare: null, pendingRule: null, houseRule: null };
  const snapshot = () => socket.onmessage?.({ data: JSON.stringify(view) });
  const message = (text: string, from = 'Race Control') => feed.onmessage?.({ data: JSON.stringify({ from, text }) });
  const sent: { user: string; text: string }[] = [];
  const context = createContext({
    document: { getElementById: node, createElement: () => new Element() },
    location: { protocol: 'http:', host: '127.0.0.1:1234' }, WebSocket: Socket, EventSource: Feed, AbortController,
    Date: class extends Date { static override now() { return now; } },
    setTimeout: (callback: () => void, ms: number) => { if (ms < 8000) queueMicrotask(() => { now += ms; callback(); }); return 1; }, clearTimeout: () => {},
    fetch: async (path: string, options?: { body: string }) => {
      if (path === '/demo/config') return { ok: true, json: async () => ({ broadcaster: 'streamer', codex: mode === 'ready', canReset: true }) };
      if (path === '/demo/reset') { view = { serverNow: now, dare: null, pendingRule: null, houseRule: null }; snapshot(); return { ok: true }; }
      const chat = JSON.parse(options!.body) as { user: string; text: string }; sent.push(chat); message(chat.text, chat.user);
      if (chat.text === '!dare' && mode !== 'timeout') view.dare = { status: 'proposed', options: [{ title: 'SHOTGUN no armor' }, { title: 'KNIFE ONLY' }], target: { count: 3 }, voteEndsAt: new Date(now + 10_000).toISOString() };
      if (chat.text === '!approve') view.dare!.status = 'voting';
      if (chat.text === '!yes' || chat.text === '!no') if (++predicts === 6) view.dare!.status = 'running';
      if (chat.text === '!kill' && ++kills === 3) view.dare!.status = 'resolved';
      if (chat.text.startsWith('!rule ')) message(mode === 'ready' ? 'Rule ready: wrong calls lose a point' : 'Codex not available: !rule needs a logged-in Codex CLI.');
      if (chat.text === '!adopt') view.houseRule = 'wrong calls lose a point';
      snapshot(); return { ok: true };
    },
  });
  const html = await readFile(new URL('../public/demo.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('innerHTML'));
  runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]!, context);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  feed.onopen?.(); snapshot();
  return { node, sent, context, message, text: () => {
    const content = (element: Element): string => element.textContent + element.children.map(content).join(' ');
    return content(node('transcript'));
  } };
}

test('demo auto-play completes votes, kills and rule adoption with literal transcript text', async () => {
  const b = await browser('ready');
  assert.equal(b.node('auto').disabled, false);
  assert.equal(b.node('quick').children.length, 12);
  await runInContext('autoplay()', b.context);
  assert.equal(b.sent[0]?.text, '!dare'); assert.equal(b.sent[1]?.text, '!approve');
  assert.equal(b.sent.filter(chat => chat.user.startsWith('viewer')).length, 12);
  assert.ok(b.sent.some(chat => chat.text === 'SHOTGUN'));
  assert.equal(b.sent.filter(chat => chat.text === '!kill').length, 3);
  assert.equal(b.sent.at(-1)?.text, '!adopt');
  assert.equal(b.node('status').textContent, 'Complete · standings replayed');
  b.message('<img src=x onerror=alert(1)>', 'viewer01');
  assert.ok(b.text().includes('<img src=x onerror=alert(1)>'));
});

test('demo auto-play handles missing Codex and names a stalled proposal step', async () => {
  const offline = await browser('unavailable'); await runInContext('autoplay()', offline.context);
  assert.ok(!offline.sent.some(chat => chat.text === '!adopt'));
  assert.match(offline.node('status').textContent, /Dare complete/);
  const timeout = await browser('timeout'); await runInContext('autoplay()', timeout.context);
  assert.match(timeout.node('status').textContent, /Timed out waiting for Game Master proposal/);
  assert.equal(timeout.sent.length, 1); assert.equal(timeout.node('auto').textContent, 'Auto-play');
});
