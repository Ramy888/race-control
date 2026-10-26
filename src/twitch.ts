import { readJson, request, type Fetch } from './http.js';
import type { TokenManager } from './tokens.js';
import { RateLimitQueue } from './queue.js';

export class TwitchApi {
  constructor(
    private readonly clientId: string,
    private readonly broadcasterId: string,
    private readonly botId: string,
    private readonly tokens: Pick<TokenManager, 'get'>,
    private readonly queue: RateLimitQueue,
    private readonly fetcher: Fetch = fetch,
    private readonly log: (message: string) => void = console.log,
  ) {}

  async subscribe(sessionId: string): Promise<void> {
    // EventSub WebSockets require a user token, with user_id matching that user.
    // https://dev.twitch.tv/docs/eventsub/handling-websocket-events/#authentication
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.tokens.get('bot', attempt > 0);
      const response = await request(this.fetcher, 'https://api.twitch.tv/helix/eventsub/subscriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.accessToken}`, 'Client-Id': this.clientId, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'channel.chat.message', version: '1',
          condition: { broadcaster_user_id: this.broadcasterId, user_id: this.botId },
          transport: { method: 'websocket', session_id: sessionId },
        }),
      });
      if (response.status === 401 && attempt === 0) continue;
      if (response.status !== 202) throw new Error(`Chat subscription failed (HTTP ${response.status}). Check bot authorization and channel access.`);
      this.log('Subscribed to channel.chat.message.');
      return;
    }
  }

  async send(message: string): Promise<void> {
    // App-token sending requires the bot's user:write:chat + user:bot grants and
    // the broadcaster's channel:bot grant (or moderator status).
    // https://dev.twitch.tv/docs/api/reference/#send-chat-message
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.tokens.get('app', attempt > 0);
      const response = await this.queue.enqueue(() => request(this.fetcher, 'https://api.twitch.tv/helix/chat/messages', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.accessToken}`, 'Client-Id': this.clientId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ broadcaster_id: this.broadcasterId, sender_id: this.botId, message, for_source_only: true }),
      }));
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) throw new Error(`Send Chat Message failed (HTTP ${response.status}).`);
      const body = await readJson<{ data?: { is_sent: boolean; drop_reason?: { code: string; message: string } | null }[] }>(response);
      const result = body.data?.[0];
      if (typeof result?.is_sent !== 'boolean') throw new Error('Invalid Send Chat Message response.');
      // HTTP 200 does not guarantee delivery; AutoMod can hold or drop a message.
      // https://dev.twitch.tv/docs/chat/send-receive-messages/#sending-chat-messages
      if (!result.is_sent) this.log(`Chat message dropped (is_sent=false): ${result.drop_reason?.code ?? 'unknown'} — ${result.drop_reason?.message ?? 'No reason provided.'}`);
      return;
    }
  }
}
