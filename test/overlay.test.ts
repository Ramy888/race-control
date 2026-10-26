import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse, Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { WebSocketServer } from 'ws';
import { Ledger, replay, type LedgerEvent, type EventInput } from '../src/ledger.js';
import { toOverlayView } from '../src/overlay.js';
import { localHandler, publishOverlay, startLocalServer } from '../src/server.js';

const iso = (ms: number) => new Date(ms).toISOString();
const open: EventInput = { agent: 'GameMaster', type: 'dare_opened', data: {
  dareId: 'dare', title: "3 kills with chat's pick", options: ['SHOTGUN', 'KNIFE ONLY'],
  target: { stat: 'kills', count: 3 }, voteEndsAt: iso(30_000), dareEndsAt: iso(120_000),
} };
function history() {
  const events: LedgerEvent[] = [];
  const add = (input: EventInput, at = 0) => { events.push({ ...input, seq: events.length + 1, at: iso(at) }); };
  add(open);
  return { events, add };
}

test('public snapshot omits IDs/maps and handles idle and zero percentages', () => {
  const idle = toOverlayView(replay([]), 123);
  assert.equal(idle.dare, null);
  assert.equal(idle.serverNow, 123);
  assert.equal(idle.predictions.yes.percent, 0);
  const h = history();
  h.add({ agent: 'Chat', type: 'prediction_cast', data: { dareId: 'dare', userId: 'private-123', login: 'viewer', yes: true } });
  const state = replay(h.events);
  const before = JSON.stringify(state);
  const view = toOverlayView(state, 1000);
  assert.deepEqual(view.dare?.options.map(option => option.percent), [0, 0]);
  const serialized = JSON.stringify(view);
  for (const forbidden of ['userId', 'private-123', '"votes"', 'lastEvents', 'chatter_user_id']) assert.ok(!serialized.includes(forbidden));
  assert.ok(!serialized.includes('NaN'));
  assert.equal(JSON.stringify(state), before);
});

test('percent math, replaced predictions, stable top-five order and bounded agent feed', () => {
  const h = history();
  const logins = ['zeta', 'delta', 'beta', 'alpha', 'echo', 'charlie'];
  logins.forEach((login, index) => {
    const userId = `private-${index}`;
    h.add({ agent: 'Chat', type: 'prediction_cast', data: { dareId: 'dare', userId, login, yes: index < 4 } });
    h.add({ agent: 'Chat', type: 'vote_cast', data: { dareId: 'dare', userId, login, option: index < 2 ? 1 : 2 } });
  });
  h.add({ agent: 'Chat', type: 'prediction_cast', data: { dareId: 'dare', userId: 'private-0', login: 'zeta', yes: false } });
  h.add({ agent: 'Referee', type: 'vote_locked', data: { dareId: 'dare', winner: 2 } }, 30_000);
  h.add({ agent: 'Referee', type: 'progress', data: { dareId: 'dare', stat: 'kills', delta: 2 } }, 31_000);
  let view = toOverlayView(replay(h.events), 31_000);
  assert.deepEqual(view.dare?.options.map(option => option.percent), [33, 67]);
  assert.deepEqual(view.predictions, { yes: { count: 3, percent: 50 }, no: { count: 3, percent: 50 } });
  assert.deepEqual(view.agentStrip.map(item => item.text), ["Opened: 3 kills with chat's pick", 'Vote locked: KNIFE ONLY', 'Kills 2/3']);
  for (let i = 0; i < 25; i++) h.add({ agent: 'Chat', type: 'prediction_cast', data: { dareId: 'dare', userId: 'private-0', login: 'zeta', yes: false } }, 32_000);
  h.add({ agent: 'Referee', type: 'progress', data: { dareId: 'dare', stat: 'kills', delta: 1 } }, 33_000);
  h.add({ agent: 'Referee', type: 'dare_resolved', data: { dareId: 'dare', success: true } }, 33_000);
  view = toOverlayView(replay(h.events), 33_000);
  assert.equal(view.agentStrip.length, 5);
  assert.equal(view.agentStrip[0]?.text, "Opened: 3 kills with chat's pick");
  assert.equal(view.agentStrip.at(-1)?.text, 'Dare won');
  assert.equal(view.chatEventCount, 38);
  assert.deepEqual(view.topFans.map(fan => [fan.login, fan.score]), [['alpha', 1], ['beta', 1], ['delta', 1], ['charlie', 0], ['echo', 0]]);
  h.add({ agent: 'Commissioner', type: 'overruled', data: { dareId: 'dare', success: false, reason: 'correction' } }, 34_000);
  view = toOverlayView(replay(h.events), 34_000);
  assert.equal(view.dare?.success, false);
  assert.equal(view.dare?.overruled, true);
  assert.equal(view.agentStrip.at(-1)?.text, 'Overruled: loss');
  assert.deepEqual(view.topFans.slice(0, 3).map(fan => fan.login), ['charlie', 'echo', 'zeta']);
});

test('Ledger listeners see committed state, unsubscribe, and cannot poison appends', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'overlay-ledger-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = await Ledger.open(join(dir, 'ledger.jsonl'));
  let count = 0;
  ledger.onAppend(() => { throw new Error('observer failed'); });
  const off = ledger.onAppend(() => { count++; assert.ok(ledger.state.currentDare); });
  await ledger.append(open, iso(0));
  off();
  await ledger.append({ agent: 'Referee', type: 'vote_locked', data: { dareId: 'dare', winner: 1 } }, iso(30_000));
  assert.equal(count, 1);
  const bad = await Ledger.open(join(dir, 'missing', 'ledger.jsonl'));
  // Make the intended parent path a regular file, forcing append to fail.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'missing'), 'file');
  let notified = false;
  bad.onAppend(() => { notified = true; });
  await assert.rejects(bad.append(open));
  assert.equal(notified, false);
});

function response() {
  const result = { status: 200, headers: {} as Record<string, string>, body: '' };
  const res = {
    writeHead: (status: number, headers = {}) => { result.status = status; result.headers = headers; return res; },
    end: (body: string) => { result.body = body; },
  };
  return { result, res: res as unknown as ServerResponse };
}

test('local HTTP serves actual overlay HTML and live mode has no mock endpoint', async () => {
  const html = await readFile(new URL('../public/overlay.html', import.meta.url), 'utf8');
  const handler = localHandler(html);
  const r = response();
  handler({ method: 'GET', url: '/overlay' } as IncomingMessage, r.res);
  assert.equal(r.result.status, 200);
  assert.match(r.result.headers['Content-Type']!, /text\/html/);
  assert.match(r.result.body, /STREAMER vs CHAT/);
  assert.ok(!html.includes('innerHTML'));
  assert.ok(html.split('\n').length < 300);
  const denied = response();
  handler({ method: 'POST', url: '/mock/chat' } as IncomingMessage, denied.res);
  assert.equal(denied.result.status, 404);
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  messages: ReturnType<typeof toOverlayView>[] = [];
  send(text: string, callback: (error?: Error) => void) { this.messages.push(JSON.parse(text)); callback(); }
  terminate() { this.readyState = 3; }
}

test('WS sends on connect, each append and active ticks; cleanup removes timers/listener', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const dir = await mkdtemp(join(tmpdir(), 'overlay-ws-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = await Ledger.open(join(dir, 'ledger.jsonl'));
  const sockets = Object.assign(new EventEmitter(), { clients: new Set<FakeSocket>() });
  let now = 0;
  const stop = publishOverlay(ledger, sockets as unknown as WebSocketServer, () => now);
  t.after(stop);
  const socket = new FakeSocket(); sockets.clients.add(socket); sockets.emit('connection', socket);
  assert.equal(socket.messages.length, 1);
  assert.equal(socket.messages[0]?.dare, null);
  t.mock.timers.tick(1000);
  assert.equal(socket.messages.length, 1);
  await ledger.append(open, iso(0));
  assert.equal(socket.messages.at(-1)?.dare?.status, 'voting');
  now = 1000; t.mock.timers.tick(1000);
  assert.equal(socket.messages.at(-1)?.serverNow, 1000);
  await ledger.append({ agent: 'Referee', type: 'vote_locked', data: { dareId: 'dare', winner: 1 } }, iso(30_000));
  await ledger.append({ agent: 'Referee', type: 'dare_resolved', data: { dareId: 'dare', success: false } }, iso(120_000));
  const count = socket.messages.length;
  t.mock.timers.tick(1000);
  assert.equal(socket.messages.length, count);
  assert.equal(socket.messages.at(-1)?.agentStrip.at(-1)?.text, 'Dare lost');
  stop();
  await ledger.append({ agent: 'Commissioner', type: 'overruled', data: { dareId: 'dare', success: true, reason: 'review' } }, iso(121_000));
  assert.equal(socket.messages.length, count);
  assert.equal(sockets.listenerCount('connection'), 0);
});


test('shared server binds loopback, serves mock and live modes, and cleans up on stop/error', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'overlay-server-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = await Ledger.open(join(dir, 'ledger.jsonl'));
  for (const fail of [false, true]) {
    let binding: unknown[] = [];
    let closed = false;
    const server = Object.assign(new EventEmitter(), {
      listen: (port: number, host: string, ready: () => void) => {
        binding = [port, host];
        if (fail) server.emit('error', new Error('occupied')); else ready();
      },
      close: () => { closed = true; }, closeAllConnections: () => {},
    });
    const sockets = Object.assign(new EventEmitter(), { clients: new Set<FakeSocket>(), close: () => {} });
    const factory = ((handler: (req: IncomingMessage, res: ServerResponse) => void) => {
      const r = response(); handler({ method: 'GET', url: '/overlay' } as IncomingMessage, r.res);
      assert.equal(r.result.status, 200);
      assert.match(r.result.body, /STREAMER vs CHAT/);
      return server;
    }) as unknown as typeof createServer;
    const pending = startLocalServer(3000, ledger, undefined, factory, actual => {
      assert.equal(actual, server);
      return sockets as unknown as WebSocketServer;
    });
    if (fail) await assert.rejects(pending, /occupied/);
    else {
      const local = await pending;
      const socket = new FakeSocket(); sockets.clients.add(socket); sockets.emit('connection', socket);
      assert.equal(socket.messages.length, 1);
      local.stop();
      assert.equal(socket.readyState, 3);
    }
    assert.deepEqual(binding, [3000, '127.0.0.1']);
    assert.equal(closed, true);
    assert.equal(sockets.listenerCount('connection'), 0);
  }
});

test('inline renderer handles all phases safely and reconnects with backoff without client time', async () => {
  const { createContext, runInContext } = await import('node:vm');
  class Node {
    textContent = ''; className = ''; hidden = false;
    style: Record<string, string> = {};
    children: Node[] = [];
    classList = { toggle: (_name: string, _on: boolean) => {} };
    set innerHTML(_value: string) { assert.fail('HTML insertion is forbidden'); }
    append(...nodes: Node[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Node[]) { this.children = nodes; }
  }
  const nodes = new Map<string, Node>();
  const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id)!; };
  const sockets: BrowserSocket[] = [];
  class BrowserSocket {
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor(public url: string) { sockets.push(this); }
  }
  const delays: number[] = [];
  const callbacks: (() => void)[] = [];
  const context = createContext({
    document: { getElementById: node, createElement: () => new Node() },
    innerWidth: 1920, innerHeight: 1080, addEventListener: () => {},
    location: { protocol: 'http:', host: 'localhost:3000' }, WebSocket: BrowserSocket,
    setTimeout: (callback: () => void, ms: number) => { delays.push(ms); callbacks.push(callback); },
  });
  const html = await readFile(new URL('../public/overlay.html', import.meta.url), 'utf8');
  runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]!, context);
  assert.equal(sockets[0]?.url, 'ws://localhost:3000/overlay/ws');
  const render = (view: ReturnType<typeof toOverlayView>) => sockets.at(-1)!.onmessage!({ data: JSON.stringify(view) });
  render(toOverlayView(replay([]), 0));
  assert.equal(node('idle').hidden, false);
  const h = history();
  const view = toOverlayView(replay(h.events), 1000);
  view.topFans = [{ login: '<img src=x onerror=alert(1)>', score: 1 }];
  render(view);
  assert.equal(node('countdown').textContent, '0:29');
  assert.equal(node('voting').hidden, false);
  assert.equal(node('fans').children[0]!.children[1]!.textContent, '<img src=x onerror=alert(1)>');
  view.dare!.status = 'running'; view.dare!.winner = 2; view.dare!.progress = 2;
  render(view);
  assert.equal(node('winner').textContent, 'KNIFE ONLY');
  assert.equal(node('progress').textContent, '2 / 3');
  assert.equal(node('running').hidden, false);
  view.dare!.status = 'resolved'; view.dare!.success = false; view.dare!.overruled = true;
  render(view);
  assert.equal(node('result').textContent, 'DARE LOST');
  assert.equal(node('overruled').hidden, false);
  assert.equal(node('clock').hidden, true);
  sockets.at(-1)!.onclose!(); callbacks.shift()!();
  sockets.at(-1)!.onclose!(); callbacks.shift()!();
  assert.deepEqual(delays, [1000, 2000]);
  render(view); sockets.at(-1)!.onclose!();
  assert.equal(delays.at(-1), 1000);
  assert.match(node('connection').textContent, /RECONNECTING/);
});
