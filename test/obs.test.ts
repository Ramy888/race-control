import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setImmediate as turn } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { ObsClient, obsAuthentication } from '../src/obs.js';

function clock() {
  let now = 0;
  const timers = new Map<() => void, number>();
  return { timers, schedule: (fn: () => void, ms: number) => { timers.set(fn, now + ms); return () => { timers.delete(fn); }; },
    advance: (ms: number) => { now += ms; for (const [fn, at] of [...timers]) if (at <= now && timers.delete(fn)) fn(); },
    delays: () => [...timers.values()].map(at => at - now),
  };
}
async function until(check: () => boolean) { for (let i = 0; i < 1000 && !check(); i++) await turn(); assert.ok(check()); }
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const imageData = 'data:image/png;base64,' + png.toString('base64');
const send = (socket: WebSocket, op: number, d: unknown) => socket.send(JSON.stringify({ op, d }));
async function server() {
  const sockets: WebSocket[] = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', socket => sockets.push(socket));
  await once(server, 'listening');
  const address = server.address(); assert.ok(typeof address === 'object' && address);
  return { server, sockets, url: `ws://127.0.0.1:${address.port}`, close: async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test('OBS auth matches an independently SHA256/base64-computed protocol vector', () => {
  assert.equal(obsAuthentication('supersecretpassword', 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=', '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY='), '1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=');
});

test('OBS handshake with auth, request IDs, error status, invalid PNG and five-second timeout', async t => {
  const s = await server(), time = clock(), client = new ObsClient(s.url, 'password', time);
  t.after(async () => { client.stop(); await s.close(); });
  const requests: { requestId: string; requestData: { sourceName: string; imageFormat: string } }[] = [];
  let identified = false;
  s.server.on('connection', socket => {
    send(socket, 0, { rpcVersion: 1, authentication: { salt: 'salt', challenge: 'challenge' } });
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.op === 1) {
        assert.deepEqual(message.d, { rpcVersion: 1, eventSubscriptions: 0, authentication: obsAuthentication('password', 'salt', 'challenge') });
        identified = true; send(socket, 2, { negotiatedRpcVersion: 1 });
      } else {
        assert.ok(identified); assert.equal(message.op, 6); assert.equal(message.d.requestType, 'GetSourceScreenshot');
        requests.push(message.d);
      }
    });
  });
  const a = client.screenshot('Camera'), b = client.screenshot('Test HUD');
  await until(() => requests.length === 2);
  assert.deepEqual(requests.map(r => r.requestData), [{ sourceName: 'Camera', imageFormat: 'png' }, { sourceName: 'Test HUD', imageFormat: 'png' }]);
  assert.notEqual(requests[0]!.requestId, requests[1]!.requestId);
  const reply = (index: number, result: boolean, data = imageData) => send(s.sockets[0]!, 7, {
    requestType: 'GetSourceScreenshot', requestId: requests[index]!.requestId,
    requestStatus: { result, code: result ? 100 : 600, comment: 'DO NOT LOG THIS' }, responseData: { imageData: data },
  });
  reply(1, true); assert.deepEqual(await b, png); reply(0, true); assert.deepEqual(await a, png);
  const failed = assert.rejects(client.screenshot('Missing'), error => (error as Error).message === 'OBS screenshot request failed.');
  await until(() => requests.length === 3); reply(2, false); await failed;
  const malformed = assert.rejects(client.screenshot('Bad'), /invalid PNG/);
  await until(() => requests.length === 4); reply(3, true, 'data:image/png;base64,aGVsbG8='); await malformed;
  const timeout = assert.rejects(client.screenshot('Slow'), /timed out/);
  await until(() => requests.length === 5); assert.ok(time.delays().includes(5000));
  time.advance(5000); await timeout;
  reply(4, true); // Late responses do not settle another request.
});

test('OBS unauthenticated Identify, close rejection, handshake timeout, backoff and stop', async t => {
  const s = await server(), time = clock(), client = new ObsClient(s.url, '', time);
  t.after(async () => { client.stop(); await s.close(); });
  let count = 0;
  s.server.on('connection', socket => {
    count++;
    if (count > 1) return; // Later handshakes deliberately stall.
    send(socket, 0, { rpcVersion: 1 });
    socket.on('message', raw => {
      const { op, d } = JSON.parse(raw.toString());
      if (op === 1) { assert.deepEqual(d, { rpcVersion: 1, eventSubscriptions: 0 }); send(socket, 2, { negotiatedRpcVersion: 1 }); }
      if (op === 6) socket.close();
    });
  });
  await assert.rejects(client.screenshot('Test'), /unavailable/);
  await until(() => time.delays().includes(1000));
  time.advance(1000); await until(() => count === 2);
  time.advance(5000); await until(() => time.delays().includes(2000));
  time.advance(2000); await until(() => count === 3);
  time.advance(5000); await until(() => time.delays().includes(4000));
  client.stop(); assert.equal(time.timers.size, 0);
  await assert.rejects(client.screenshot('Test'), /stopped/);
});
