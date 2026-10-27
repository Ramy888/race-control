import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { Clock } from './dares.js';

// obs-websocket v5 handshake, authentication and GetSourceScreenshot:
// https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
export function obsAuthentication(password: string, salt: string, challenge: string): string {
  const hash = (value: string) => createHash('sha256').update(value).digest('base64');
  return hash(hash(password + salt) + challenge);
}
const timers: Pick<Clock, 'schedule'> = {
  schedule: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
};
type Pending = { source: string; sent: boolean; resolve: (png: Buffer) => void; reject: (error: Error) => void; cancel: () => void };

export class ObsClient {
  private socket?: WebSocket;
  private identified = false;
  private stopped = false;
  private attempts = 0;
  private reconnect?: () => void;
  private handshake?: () => void;
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly url = 'ws://127.0.0.1:4455', private readonly password = '', private readonly time = timers) {}

  screenshot(sourceName: string): Promise<Buffer> {
    if (this.stopped) return Promise.reject(new Error('OBS client stopped.'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const cancel = this.time.schedule(() => {
        this.pending.delete(id); reject(new Error('OBS screenshot timed out.'));
      }, 5000);
      this.pending.set(id, { source: sourceName, sent: false, resolve, reject, cancel });
      if (!this.socket && !this.reconnect) this.connect();
      this.flush();
    });
  }
  stop(): void {
    this.stopped = true;
    this.reconnect?.(); this.reconnect = undefined; this.handshake?.();
    this.failPending();
    this.socket?.terminate(); this.socket = undefined;
  }
  private failPending(): void {
    for (const request of this.pending.values()) { request.cancel(); request.reject(new Error('OBS connection unavailable.')); }
    this.pending.clear();
  }
  private connect(): void {
    if (this.stopped) return;
    let socket: WebSocket;
    try { socket = new WebSocket(this.url, { maxPayload: 32 * 1024 * 1024 }); }
    catch { this.failPending(); this.retry(); return; }
    this.socket = socket;
    this.identified = false;
    let hello = false;
    this.handshake = this.time.schedule(() => socket.terminate(), 5000);
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.handshake?.(); this.socket = undefined; this.identified = false;
      this.failPending(); this.retry();
    });
    socket.on('message', raw => {
      if (this.socket !== socket || this.stopped) return;
      try {
        const { op, d } = JSON.parse(raw.toString());
        if (op === 0 && !hello) {
          hello = true;
          const authentication = d.authentication ? obsAuthentication(this.password, d.authentication.salt, d.authentication.challenge) : undefined;
          socket.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 0, ...(authentication ? { authentication } : {}) } }));
        } else if (op === 2 && hello) {
          if (d.negotiatedRpcVersion !== 1) { socket.terminate(); return; }
          this.identified = true; this.attempts = 0; this.handshake?.(); this.flush();
        } else if (op === 7 && this.identified) {
          const request = this.pending.get(d.requestId);
          if (!request || !request.sent) return;
          request.cancel(); this.pending.delete(d.requestId);
          if (d.requestType !== 'GetSourceScreenshot' || d.requestStatus?.result !== true) {
            request.reject(new Error('OBS screenshot request failed.')); return;
          }
          const data = d.responseData?.imageData;
          if (typeof data !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) {
            request.reject(new Error('OBS returned an invalid PNG.')); return;
          }
          const png = Buffer.from(data.slice('data:image/png;base64,'.length), 'base64');
          if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) request.reject(new Error('OBS returned an invalid PNG.'));
          else request.resolve(png);
        }
      } catch { socket.terminate(); }
    });
  }
  private retry(): void {
    if (this.stopped) return;
    this.reconnect = this.time.schedule(() => { this.reconnect = undefined; this.connect(); }, Math.min(1000 * 2 ** Math.min(this.attempts++, 5), 30_000));
  }
  private flush(): void {
    if (!this.identified || this.socket?.readyState !== WebSocket.OPEN) return;
    for (const [requestId, request] of this.pending) if (!request.sent) {
      request.sent = true;
      this.socket.send(JSON.stringify({ op: 6, d: { requestType: 'GetSourceScreenshot', requestId, requestData: { sourceName: request.source, imageFormat: 'png' } } }));
    }
  }
}
