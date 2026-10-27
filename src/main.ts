import 'dotenv/config';
import { MockSession, codexAvailable } from './demo.js';
import { startWatcher } from './watcher.js';
import { loadConfig } from './config.js';
import { DareLoop } from './dares.js';
import { EventSubClient } from './eventsub.js';
import { Ledger } from './ledger.js';
import { startLocalServer } from './server.js';
import { RateLimitQueue } from './queue.js';
import { TokenManager } from './tokens.js';
import { TwitchApi } from './twitch.js';

const cleanup: (() => void)[] = [];
function shutdown(): void { for (const stop of cleanup) stop(); }
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
try {
  const config = loadConfig(process.env);
  let state: () => import('./ledger.js').RaceState;
  let recordHud: (id: string, delta: number) => Promise<void>;
  if (config.mock) {
    const available = await codexAvailable();
    if (!available) console.log('Codex CLI not found: Game Master uses sample dares; !rule needs Codex.');
    const session = await MockSession.open(config, available);
    state = () => session.state;
    recordHud = (id, delta) => session.recordHud(id, delta);
    cleanup.push(() => session.stop());
    const local = await startLocalServer(config.port, session, chat => session.handle(chat), undefined, undefined, session);
    cleanup.push(local.stop);
    console.log(`Demo page: http://127.0.0.1:${config.port}/demo`);
    console.log(`Mock chat: http://127.0.0.1:${config.port}/mock/chat — broadcaster: ${config.broadcasterLogin}. Send !dare to start.`);
  } else {
    const ledger = await Ledger.open(config.ledgerPath);
    const tokens = new TokenManager(config);
    const { broadcaster, bot } = await tokens.validateAll();
    const queue = new RateLimitQueue();
    const api = new TwitchApi(config.clientId, broadcaster.userId!, bot.userId!, tokens, queue);
    const loop = new DareLoop(ledger, config.broadcasterLogin, message => api.send(message), undefined, undefined, undefined, config);
    state = () => ledger.state;
    recordHud = (id, delta) => loop.recordHud(id, delta);
    cleanup.push(() => { loop.stop(); queue.stop(); });
    await loop.start();
    const local = await startLocalServer(config.port, ledger);
    cleanup.push(local.stop);
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
  if (config.watcher) cleanup.push(await startWatcher(config.watcher, state, recordHud));
  console.log(`OBS overlay: http://127.0.0.1:${config.port}/overlay (1920×1080).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Race Control failed to start.');
  process.exitCode = 1;
  shutdown();
}
