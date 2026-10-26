import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.js';
import { scopes, type Role } from './tokens.js';

export function authorizationUrl(config: Config, role: Role, state: string): string {
  const url = new URL('https://id.twitch.tv/oauth2/authorize');
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri,
    response_type: 'code', scope: scopes[role].join(' '), state, force_verify: 'true',
  }).toString();
  return url.href;
}

export function callbackHandler(
  state: string,
  authorize: (code: string) => Promise<void>,
  finish: (error?: Error) => void,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let consumed = false;
  return async (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); }
    catch { res.writeHead(400).end('Invalid callback URL.'); return; }
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404).end('Not found.');
      return;
    }
    const received = Buffer.from(url.searchParams.get('state') ?? '');
    const expected = Buffer.from(state);
    // Reject mismatched state before exchanging the authorization code.
    // https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#authorization-code-grant-flow
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.writeHead(400).end('Invalid OAuth state. Use the original authorization link.');
      return;
    }
    if (consumed) { res.writeHead(409).end('Authorization already handled.'); return; }
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') || !code) {
      res.writeHead(400).end('Authorization was denied or no code was returned. Run the auth command again.');
      finish(new Error('Twitch authorization was denied or incomplete.'));
      return;
    }
    consumed = true;
    try {
      await authorize(code);
      res.end('Authorization saved. You can close this tab.');
      finish();
    } catch {
      res.writeHead(400).end('Authorization failed. Check that the Twitch account matches the login in .env and retry.');
      finish(new Error('Authorization failed. Check the configured account, client credentials, redirect URI, and requested scopes.'));
    }
  };
}
