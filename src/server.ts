import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { ChatInput } from './commands.js';
import type { Ledger } from './ledger.js';
import { mockChatHandler } from './mock.js';
import { toOverlayView } from './overlay.js';

export function localHandler(html: string, chat?: (input: ChatInput) => Promise<void>) {
  const mock = chat ? mockChatHandler(chat) : undefined;
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method === 'GET' && req.url === '/overlay') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } else if (mock && req.url === '/mock/chat') {
      void mock(req, res);
    } else {
      res.writeHead(404).end('Not found.');
    }
  };
}

export function publishOverlay(ledger: Pick<Ledger, 'state' | 'onAppend'>, sockets: WebSocketServer, now = Date.now): () => void {
  const send = (socket: WebSocket, snapshot: string) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1_000_000) { socket.terminate(); return; }
    socket.send(snapshot, error => { if (error) socket.terminate(); });
  };
  const snapshot = () => JSON.stringify(toOverlayView(ledger.state, now()));
  const broadcast = () => {
    if (!sockets.clients.size) return;
    const message = snapshot();
    for (const socket of sockets.clients) send(socket, message);
  };
  const connected = (socket: WebSocket) => {
    socket.on('error', () => socket.terminate());
    send(socket, snapshot());
  };
  sockets.on('connection', connected);
  const unsubscribe = ledger.onAppend(broadcast);
  const interval = setInterval(() => {
    if (!sockets.clients.size) return;
    const dare = ledger.state.currentDare;
    if (dare && dare.status !== 'resolved') broadcast();
  }, 1000);
  return () => { clearInterval(interval); unsubscribe(); sockets.off('connection', connected); };
}

export async function startLocalServer(
  port: number, ledger: Ledger, chat?: (input: ChatInput) => Promise<void>,
  makeServer = createServer,
  makeSockets = (server: Server) => new WebSocketServer({ server, path: '/overlay/ws', maxPayload: 1024 }),
) {
  const html = await readFile(new URL('../public/overlay.html', import.meta.url), 'utf8');
  const server = makeServer(localHandler(html, chat));
  const sockets = makeSockets(server);
  // ws forwards HTTP-server errors; the listen promise below handles startup failures.
  sockets.on('error', () => {});
  const unpublish = publishOverlay(ledger, sockets);
  const stop = () => {
    unpublish();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.close();
    server.closeAllConnections();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { stop(); throw error; }
  return { server, stop };
}
