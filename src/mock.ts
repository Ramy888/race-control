import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ChatInput } from './commands.js';

export function parseMockChat(value: unknown): ChatInput | undefined {
  if (!value || typeof value !== 'object') return;
  const { user, text } = value as Record<string, unknown>;
  if (typeof user !== 'string' || !/^[a-zA-Z0-9_]{1,25}$/.test(user) || typeof text !== 'string' || text.length > 500) return;
  const login = user.toLowerCase();
  return { userId: login, login, text };
}

export function mockChatHandler(handle: (chat: ChatInput) => Promise<void>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST' || req.url !== '/mock/chat') {
      res.writeHead(404).end(JSON.stringify({ error: 'Use POST /mock/chat.' }));
      return;
    }
    let chat: ChatInput | undefined;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > 8192) { res.writeHead(400).end(JSON.stringify({ error: 'Request too large.' })); return; }
        chunks.push(buffer);
      }
      chat = parseMockChat(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch { /* Invalid JSON or incomplete body. */ }
    if (!chat) {
      res.writeHead(400).end(JSON.stringify({ error: 'user must be 1–25 letters, digits or underscores; text must be a string of at most 500 characters.' }));
      return;
    }
    try {
      await handle(chat);
      res.end(JSON.stringify({ accepted: true }));
    } catch { res.writeHead(500).end(JSON.stringify({ error: 'Chat handler failed. Check the Ledger.' })); }
  };
}

export function startMockServer(port: number, handle: (chat: ChatInput) => Promise<void>, makeServer = createServer) {
  const server = makeServer(mockChatHandler(handle));
  server.listen(port, '127.0.0.1');
  return server;
}
