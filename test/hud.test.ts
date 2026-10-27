import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { Ledger } from '../src/ledger.js';
import { startLocalServer } from '../src/server.js';

test('/hud-test serves HTML on an isolated port and demo keys update its counter', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hud-http-'));
  const local = await startLocalServer(0, await Ledger.open(join(dir, 'ledger.jsonl')));
  t.after(async () => { local.stop(); await rm(dir, { recursive: true, force: true }); });
  const address = local.server.address(); assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/hud-test?kills=3`);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/html/);
  const html = await response.text(); assert.match(html, /TEST HUD/);
  assert.match(html, /left:1632px;top:108px;width:192px;height:108px/);
  const counter = { textContent: '0' }, frame = { style: { transform: '' } };
  const events = new Map<string, (event: { repeat?: boolean; code?: string; key: string; preventDefault: () => void }) => void>();
  const context = createContext({ innerWidth: 1920, innerHeight: 1080, location: { search: '?kills=3' }, URLSearchParams,
    document: { getElementById: (id: string) => id === 'kills' ? counter : frame },
    addEventListener: (name: string, fn: NonNullable<ReturnType<typeof events.get>>) => events.set(name, fn),
  });
  runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]!, context);
  const key = (key: string, code?: string, repeat = false) => events.get('keydown')!({ key, code, repeat, preventDefault: () => {} });
  assert.equal(counter.textContent, '3');
  key('k'); key(' ', 'Space'); assert.equal(counter.textContent, '5');
  key('K', undefined, true); assert.equal(counter.textContent, '5');
  key('r'); assert.equal(counter.textContent, '0'); assert.equal(frame.style.transform, 'scale(1)');
});

test('embedded HUD hides instructions, keeps TEST HUD, and accepts only parent-origin integer snapshots', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile('public/hud-test.html', 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  for (const embed of [false, true]) {
    const counter = { textContent: '' }, frame = { style: {} }, label = { style: {} }, instructions = { hidden: false };
    const parent = {}, origin = 'https://demo.test';
    const events = new Map<string, (event: unknown) => void>();
    runInContext(script, createContext({
      innerWidth: 1920, innerHeight: 1080, location: { search: '?kills=4' + (embed ? '&embed=1' : ''), origin }, parent, URLSearchParams,
      document: { getElementById: (id: string) => id === 'kills' ? counter : id === 'instructions' ? instructions : frame, querySelector: () => label },
      addEventListener: (type: string, listener: (event: unknown) => void) => events.set(type, listener),
    }));
    assert.equal(instructions.hidden, embed); assert.equal(counter.textContent, '4');
    assert.match(html, /class="label">TEST HUD<\/div>/);
    if (!embed) { assert.equal(events.has('message'), false); assert.deepEqual(label.style, {}); continue; }
    const send = (kills: unknown, source = parent, from = origin) => events.get('message')!({ source, origin: from, data: { type: 'race-hud', kills } });
    send(8); assert.equal(counter.textContent, '8'); send(0); assert.equal(counter.textContent, '0');
    for (const bad of [-1, 1000, 2.5, '7', NaN]) send(bad);
    send(5, {}); send(5, parent, 'https://other.test'); assert.equal(counter.textContent, '0');
  }
});
