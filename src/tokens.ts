import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Config } from './config.js';
import { readJson, request, type Fetch } from './http.js';

export type Role = 'broadcaster' | 'bot';
export const scopes: Record<Role, string[]> = {
  broadcaster: ['channel:bot'],
  bot: ['user:read:chat', 'user:write:chat', 'user:bot'],
};
export interface Token {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  userId?: string;
}
export type TokenData = Partial<Record<Role | 'app', Token>>;

export class TokenStore {
  constructor(private readonly path = '.data/tokens.json') {}

  async read(): Promise<TokenData> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error('Cannot read .data/tokens.json. Check file permissions.');
    }
    try {
      const data = JSON.parse(text) as TokenData;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      for (const token of Object.values(data)) {
        if (!token || typeof token.accessToken !== 'string' || !Number.isFinite(token.expiresAt) ||
            (token.refreshToken !== undefined && typeof token.refreshToken !== 'string')) throw new Error();
      }
      return data;
    } catch { throw new Error('Invalid .data/tokens.json. Run npm run auth again for both accounts.'); }
  }

  async write(data: TokenData): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      // Replace atomically so an interrupted write cannot truncate the last good tokens.
      await writeFile(`${this.path}.tmp`, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
    } catch { throw new Error('Cannot save .data/tokens.json. Check file permissions.'); }
  }
}

export class TokenManager {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: Config,
    private readonly store: Pick<TokenStore, 'read' | 'write'> = new TokenStore(),
    private readonly fetcher: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  // Serialize refresh and persistence, including concurrent user/app requests.
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => {});
    return result;
  }

  private async grant(params: Record<string, string>): Promise<Token> {
    const response = await request(this.fetcher, 'https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...params }),
    });
    if (!response.ok) throw new Error(`Twitch token grant failed (HTTP ${response.status}). Run npm run auth again if a user grant was revoked.`);
    const body = await readJson<{ access_token: string; refresh_token?: string; expires_in: number }>(response);
    if (!body.access_token || typeof body.access_token !== 'string' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
      throw new Error('Twitch returned an invalid token response.');
    }
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: this.now() + body.expires_in * 1000 };
  }

  private async validate(token: Token, role: Role | 'app'): Promise<boolean> {
    const response = await request(this.fetcher, 'https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${token.accessToken}` },
    });
    if (response.status === 401) return false;
    if (!response.ok) throw new Error(`Twitch token validation failed (HTTP ${response.status}).`);
    const body = await readJson<{ client_id: string; login?: string; user_id?: string; scopes?: string[]; expires_in: number }>(response);
    if (body.client_id !== this.config.clientId) throw new Error(`${role} token belongs to a different TWITCH_CLIENT_ID. Reauthorize.`);
    if (role !== 'app') {
      const login = role === 'bot' ? this.config.botLogin : this.config.broadcasterLogin;
      if (body.login !== login || !body.user_id) throw new Error(`${role} token does not match ${role === 'bot' ? 'BOT_LOGIN' : 'BROADCASTER_LOGIN'}. Run npm run auth -- ${role} using the correct account.`);
      const missing = scopes[role].filter(scope => !body.scopes?.includes(scope));
      if (missing.length) throw new Error(`${role} token missing scopes: ${missing.join(', ')}. Run npm run auth -- ${role}.`);
      token.userId = body.user_id;
    } else if (body.user_id) {
      throw new Error('Expected an app access token.');
    }
    if (!Number.isFinite(body.expires_in) || body.expires_in <= 0) return false;
    token.expiresAt = this.now() + body.expires_in * 1000;
    return true;
  }

  get(role: Role | 'app', force = false, validate = false): Promise<Token> {
    return this.exclusive(async () => {
      const data = await this.store.read();
      let token = data[role];
      if (!token && role !== 'app') throw new Error(`Missing ${role} tokens. Run npm run auth -- ${role}.`);
      let renew = force || !token || token.expiresAt <= this.now() + 30_000;
      if (!renew && (validate || (role !== 'app' && !token!.userId))) renew = !(await this.validate(token!, role));
      if (renew) {
        if (role === 'app') {
          // App tokens cannot be refreshed; obtain a new client-credentials grant.
          // https://dev.twitch.tv/docs/authentication/refresh-tokens/
          token = await this.grant({ grant_type: 'client_credentials' });
        } else {
          if (!token?.refreshToken) throw new Error(`Missing ${role} refresh token. Run npm run auth -- ${role}.`);
          token = await this.grant({ grant_type: 'refresh_token', refresh_token: token.refreshToken });
          if (!token.refreshToken) throw new Error(`Missing rotated refresh token. Run npm run auth -- ${role}.`);
        }
        if (!(await this.validate(token, role))) throw new Error(`New ${role} token is invalid. Reauthorize.`);
      }
      data[role] = token!;
      await this.store.write(data);
      return token!;
    });
  }

  authorize(role: Role, code: string): Promise<void> {
    return this.exclusive(async () => {
      const token = await this.grant({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri });
      if (!token.refreshToken || !(await this.validate(token, role))) throw new Error(`Invalid ${role} authorization. Run npm run auth -- ${role} again.`);
      const data = await this.store.read();
      data[role] = token;
      await this.store.write(data);
    });
  }

  async validateAll(): Promise<{ broadcaster: Token; bot: Token }> {
    // Required at startup and hourly, even when no API calls are being made.
    // https://dev.twitch.tv/docs/authentication/validate-tokens/
    const broadcaster = await this.get('broadcaster', false, true);
    const bot = await this.get('bot', false, true);
    await this.get('app', false, true);
    return { broadcaster, bot };
  }
}
