import { setTimeout as sleep } from 'node:timers/promises';
import type { Fetch } from './http.js';

export async function simulateCrowd(
  count: number, port: number, fetcher: Fetch = fetch,
  wait: (ms: number) => Promise<void> = ms => sleep(ms), random: () => number = Math.random,
): Promise<void> {
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('count must be an integer between 1 and 1000.');
  await Promise.all(Array.from({ length: count }, async (_, index) => {
    const user = `viewer${String(index + 1).padStart(2, '0')}`;
    const messages = [`!pick ${1 + Math.floor(random() * 3)}`, random() < 0.5 ? '!yes' : '!no'];
    for (const text of messages) {
      await wait(50 + Math.floor(random() * 250));
      const response = await fetcher(`http://127.0.0.1:${port}/mock/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, text }), signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Mock chat rejected a message (HTTP ${response.status}).`);
    }
  }));
}
