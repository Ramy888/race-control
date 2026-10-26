import 'dotenv/config';
import { loadConfig } from './config.js';
import { DareLoop } from './dares.js';
import { EventSubClient } from './eventsub.js';
import { Ledger } from './ledger.js';
import { startMockServer } from './mock.js';
import { RateLimitQueue } from './queue.js';
import { TokenManager } from './tokens.js';
import { TwitchApi } from './twitch.js';

const cleanup: (() => void)[] = [];
function shutdown(): void { for (const stop of cleanup) stop(); }
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
try {
  const config = loadConfig(process.env);
  const ledger = await Ledger.open();
  if (config.mock) {
    const loop = new DareLoop(ledger, config.broadcasterLogin, async message => { console.log(`[chat] ${message}`); });
    cleanup.push(() => loop.stop());
    await loop.start();
    const server = startMockServer(config.port, chat => loop.handle(chat));
    cleanup.push(() => { server.close(); server.closeAllConnections(); });
    server.on('error', () => {
      console.error(`Cannot listen on 127.0.0.1:${config.port}. Check whether the port is in use.`);
      process.exitCode = 1;
      shutdown();
    });
    server.on('listening', () => console.log(`Mock chat: http://127.0.0.1:${config.port}/mock/chat — broadcaster: ${config.broadcasterLogin}. Send !dare to start.`));
  } else {
    const tokens = new TokenManager(config);
    const { broadcaster, bot } = await tokens.validateAll();
    const queue = new RateLimitQueue();
    const api = new TwitchApi(config.clientId, broadcaster.userId!, bot.userId!, tokens, queue);
    const loop = new DareLoop(ledger, config.broadcasterLogin, message => api.send(message));
    cleanup.push(() => { loop.stop(); queue.stop(); });
    await loop.start();
    const client = new EventSubClient({
      broadcasterId: broadcaster.userId!, botId: bot.userId!,
      subscribe: id => api.subscribe(id), send: message => api.send(message),
      onChat: chat => loop.handle(chat),
      onFatal: () => { process.exitCode = 1; shutdown(); },
    });
    const hourly = setInterval(() => {
      void tokens.validateAll().catch(error => {
        console.error(error instanceof Error ? error.message : 'Token validation failed.');
        process.exitCode = 1;
        shutdown();
      });
    }, 60 * 60_000);
    cleanup.push(() => { clearInterval(hourly); client.stop(); });
    client.start();
    console.log(`Race Control starting in #${config.broadcasterLogin} as ${config.botLogin}.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Race Control failed to start.');
  process.exitCode = 1;
  shutdown();
}
