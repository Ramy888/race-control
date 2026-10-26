export interface Config {
  mock?: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  broadcasterLogin: string;
  botLogin: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  if (env.MOCK === '1') {
    const port = Number(env.PORT?.trim() || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
    const broadcasterLogin = env.BROADCASTER_LOGIN?.trim().toLowerCase() || 'streamer';
    if (!/^[a-z0-9_]{1,25}$/.test(broadcasterLogin)) throw new Error('BROADCASTER_LOGIN must be a Twitch login (1–25 letters, digits or underscores).');
    return { mock: true, port, broadcasterLogin, botLogin: '', clientId: '', clientSecret: '', redirectUri: '' };
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
    clientId: env.TWITCH_CLIENT_ID!.trim(), clientSecret: env.TWITCH_CLIENT_SECRET!.trim(),
    redirectUri: redirect.href, broadcasterLogin: env.BROADCASTER_LOGIN!.toLowerCase(),
    botLogin: env.BOT_LOGIN!.toLowerCase(), port,
  };
}
