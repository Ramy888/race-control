import type { Config } from '../src/config.js';
import type { Fetch } from '../src/http.js';

export const config: Config = {
  clientId: 'client', clientSecret: 'test-secret', redirectUri: 'http://localhost:3000/callback',
  broadcasterLogin: 'streamer', botLogin: 'robot', port: 3000,
};

export function mockFetch(responses: Response[]): { fetcher: Fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected fetch call');
    return response;
  };
  return { fetcher, calls };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
