export type HudRegion = [number, number, number, number];
export interface WatcherConfig { obsUrl: string; obsPassword: string; source: string; region: HudRegion; interval: number }
export function parseHudRegion(value: string): HudRegion {
  const parts = value.split(',');
  const numbers = parts.map(part => Number(part.trim()));
  const [x, y, w, h] = numbers;
  if (parts.length !== 4 || parts.some(part => !part.trim()) || numbers.some(n => !Number.isFinite(n)) ||
      x! < 0 || y! < 0 || w! <= 0 || h! <= 0 || x! + w! > 1 || y! + h! > 1) {
    throw new Error('HUD_REGION must be x,y,w,h fractions within 0–1, with positive width/height.');
  }
  return numbers as HudRegion;
}
export function loadWatcherConfig(env: NodeJS.ProcessEnv): WatcherConfig {
  const obsUrl = env.OBS_URL?.trim() || 'ws://127.0.0.1:4455';
  let url: URL;
  try { url = new URL(obsUrl); } catch { throw new Error('OBS_URL must be a ws:// or wss:// URL.'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('OBS_URL must be ws:// or wss:// without embedded credentials.');
  const interval = Number(env.WATCHER_MS?.trim() || 2000);
  if (!Number.isInteger(interval) || interval < 1 || interval > 2_147_483_647) throw new Error('WATCHER_MS must be a positive integer (milliseconds).');
  return { obsUrl, obsPassword: env.OBS_PASSWORD ?? '', source: env.WATCHER_SOURCE?.trim() || '',
    region: parseHudRegion(env.HUD_REGION?.trim() || '0.85,0.1,0.1,0.1'), interval };
}

export interface Config {
  mock?: boolean;
  demo?: boolean;
  ledgerPath?: string;
  minDareMs?: number;
  watcher?: WatcherConfig;
  game?: string;
  gamemaster?: boolean;
  voteMs?: number;
  killMs?: number;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  broadcasterLogin: string;
  botLogin: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const seconds = (key: string, fallback: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < 1 || value > 600) throw new Error(`${key} must be an integer between 1 and 600 seconds.`);
    return value * 1000;
  };
  const ledgerPath = env.LEDGER_PATH ?? '.data/ledger.jsonl';
  if (!ledgerPath.trim() || ledgerPath.includes('\0')) throw new Error('LEDGER_PATH must be a non-empty file path.');
  const master = { demo: env.DEMO === '1', ledgerPath, minDareMs: seconds('MIN_DARE_SECONDS', 90), watcher: loadWatcherConfig(env), game: env.GAME?.trim() || 'Fortnite', gamemaster: env.GAMEMASTER !== 'off', voteMs: seconds('VOTE_SECONDS', 30), killMs: seconds('SECONDS_PER_KILL', 30) };
  if (env.MOCK === '1') {
    const port = Number(env.PORT?.trim() || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
    const broadcasterLogin = env.BROADCASTER_LOGIN?.trim().toLowerCase() || 'streamer';
    if (!/^[a-z0-9_]{1,25}$/.test(broadcasterLogin)) throw new Error('BROADCASTER_LOGIN must be a Twitch login (1–25 letters, digits or underscores).');
    return { ...master, mock: true, port, broadcasterLogin, botLogin: '', clientId: '', clientSecret: '', redirectUri: '' };
  }
  const required = ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_REDIRECT_URI',
    'BROADCASTER_LOGIN', 'BOT_LOGIN', 'PORT'] as const;
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  let redirect: URL;
  try { redirect = new URL(env.TWITCH_REDIRECT_URI!); }
  catch { throw new Error('TWITCH_REDIRECT_URI must be a valid local HTTP URL.'); }
  if (redirect.protocol !== 'http:' || redirect.hostname !== 'localhost' ||
      Number(redirect.port || 80) !== port || redirect.pathname !== '/callback' ||
      redirect.search || redirect.hash || redirect.username || redirect.password) {
    throw new Error('TWITCH_REDIRECT_URI must be http://localhost:<PORT>/callback.');
  }
  for (const key of ['BROADCASTER_LOGIN', 'BOT_LOGIN'] as const) {
    if (!/^[a-zA-Z0-9_]+$/.test(env[key]!)) throw new Error(`${key} must be a Twitch login (no @ or URL).`);
  }
  return {
    ...master, clientId: env.TWITCH_CLIENT_ID!.trim(), clientSecret: env.TWITCH_CLIENT_SECRET!.trim(),
    redirectUri: redirect.href, broadcasterLogin: env.BROADCASTER_LOGIN!.toLowerCase(),
    botLogin: env.BOT_LOGIN!.toLowerCase(), port,
  };
}
