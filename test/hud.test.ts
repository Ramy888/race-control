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
