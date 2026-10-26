import WebSocket from 'ws';
import { routeCommand, type ChatInput, type ChatMessage } from './commands.js';

export const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
export interface Socket {
  on(event: 'message', listener: (data: { toString(): string }) => void): unknown;
  on(event: 'close', listener: (code: number) => void): unknown;
  on(event: 'error', listener: () => void): unknown;
  close(): void;
  terminate(): void;
}
interface Connection {
  socket: Socket;
  migrating: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  keepaliveMs: number;
  welcomed: boolean;
}
interface Envelope {
  metadata: { message_type: string; message_id?: string; subscription_type?: string };
  payload: {
    session?: { id: string; keepalive_timeout_seconds: number | null; reconnect_url?: string };
    event?: ChatMessage & { broadcaster_user_id: string; chatter_user_login?: string };
    subscription?: { type: string; status: string };
  };
}

export class EventSubClient {
  private active?: Connection;
  private candidate?: Connection;
  private retry?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private stopped = true;
  private readonly seen = new Set<string>();

  constructor(private readonly options: {
    botId: string;
    broadcasterId: string;
    subscribe: (sessionId: string) => Promise<void>;
    send: (message: string) => Promise<void>;
    onChat?: (chat: ChatInput) => Promise<void>;
    log?: (message: string) => void;
    onFatal?: () => void;
    createSocket?: (url: string) => Socket;
  }) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect(EVENTSUB_URL, false);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.retry = undefined;
    const connections = [this.active, this.candidate];
    this.active = this.candidate = undefined;
    for (const connection of connections) {
      if (!connection) continue;
      clearTimeout(connection.timeout);
      connection.socket.terminate();
    }
  }

  private log(message: string): void { (this.options.log ?? console.log)(message); }

  private connect(url: string, migrating: boolean): void {
    if (this.stopped) return;
    let socket: Socket;
    try {
      // ws automatically answers protocol Ping frames with Pong; send no other frames.
      // https://dev.twitch.tv/docs/eventsub/handling-websocket-events/#ping-message
      socket = (this.options.createSocket ?? (address => new WebSocket(address)))(url);
    } catch { this.reconnect(); return; }
    const connection: Connection = { socket, migrating, keepaliveMs: 15_000, welcomed: false };
    if (migrating) this.candidate = connection;
    else this.active = connection;
    this.armTimeout(connection);
    socket.on('message', data => {
      void this.handle(connection, data.toString()).catch(() => {
        if (this.isCurrent(connection)) {
          this.log('EventSub subscription or message handling failed; reconnecting. Check authorization and network access.');
          this.reconnect();
        }
      });
    });
    socket.on('error', () => {
      if (this.isCurrent(connection)) { this.log('EventSub WebSocket error; reconnecting.'); this.reconnect(); }
    });
    socket.on('close', code => {
      clearTimeout(connection.timeout);
      if (!this.isCurrent(connection)) return;
      // If the old socket closes while the replacement is welcoming, let it finish.
      if (connection === this.active && this.candidate) { this.active = undefined; return; }
      this.log(`EventSub closed (${code}); reconnecting.`);
      this.reconnect();
    });
  }

  private isCurrent(connection: Connection): boolean {
    return !this.stopped && (connection === this.active || connection === this.candidate);
  }

  private armTimeout(connection: Connection): void {
    clearTimeout(connection.timeout);
    connection.timeout = setTimeout(() => {
      if (!this.isCurrent(connection)) return;
      this.log('EventSub welcome/keepalive timed out; reconnecting.');
      this.reconnect();
    }, connection.keepaliveMs + 1000);
  }

  private reconnect(): void {
    if (this.stopped || this.retry) return;
    const connections = [this.active, this.candidate];
    this.active = this.candidate = undefined;
    for (const connection of connections) {
      if (!connection) continue;
      clearTimeout(connection.timeout);
      connection.socket.terminate();
    }
    const delay = Math.min(1000 * 2 ** Math.min(this.attempts++, 5), 30_000);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.connect(EVENTSUB_URL, false);
    }, delay);
  }

  private async handle(connection: Connection, raw: string): Promise<void> {
    if (!this.isCurrent(connection)) return;
    let message: Envelope;
    try {
      message = JSON.parse(raw) as Envelope;
      if (!message?.metadata?.message_type || !message.payload) throw new Error();
    } catch { this.log('Ignored malformed EventSub message.'); return; }
    const { metadata, payload } = message;
    switch (metadata.message_type) {
      case 'session_welcome': {
        const session = payload.session;
        if (connection.welcomed || !session?.id) return;
        connection.welcomed = true;
        connection.keepaliveMs = (session.keepalive_timeout_seconds ?? 10) * 1000;
        this.armTimeout(connection);
        if (connection.migrating) {
          // Keep the old connection until welcome; subscriptions transfer automatically.
          // https://dev.twitch.tv/docs/eventsub/handling-websocket-events/#reconnect-message
          const old = this.active;
          this.active = connection;
          this.candidate = undefined;
          if (old) { clearTimeout(old.timeout); old.socket.close(); }
        } else {
          await this.options.subscribe(session.id);
        }
        if (!this.isCurrent(connection)) return;
        this.attempts = 0;
        this.log('EventSub connected.');
        break;
      }
      case 'session_keepalive': this.armTimeout(connection); break;
      case 'session_reconnect':
        if (payload.session?.reconnect_url && !this.candidate) {
          this.connect(payload.session.reconnect_url, true);
        }
        break;
      case 'notification': {
        this.armTimeout(connection);
        if (metadata.subscription_type !== 'channel.chat.message') return;
        const event = payload.event;
        if (!event || event.broadcaster_user_id !== this.options.broadcasterId ||
            typeof event.chatter_user_id !== 'string' || typeof event.message?.text !== 'string') return;
        if (metadata.message_id) {
          if (this.seen.has(metadata.message_id)) return;
          this.seen.add(metadata.message_id);
          if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
        }
        if (event.chatter_user_id === this.options.botId) return;
        if (this.options.onChat) {
          if (typeof event.chatter_user_login !== 'string') return;
          void this.options.onChat({ userId: event.chatter_user_id, login: event.chatter_user_login, text: event.message.text })
            .catch(() => this.log('Chat handler failed. Check the Ledger.'));
          return;
        }
        const reply = routeCommand(event, this.options.botId);
        // Never await the rate-limit queue on the socket's receive path.
        if (reply) void this.options.send(reply).catch(() => this.log('Chat reply failed. Check Twitch permissions, rate limits, and network access.'));
        break;
      }
      case 'revocation':
        this.log(`EventSub subscription revoked: ${payload.subscription?.type ?? 'unknown'} (${payload.subscription?.status ?? 'unknown'}). Resolve the revocation and restart; reauthorize if needed.`);
        this.stop();
        this.options.onFatal?.();
        break;
    }
  }
}
