export type Fetch = typeof fetch;

// Never include request headers, OAuth bodies, or raw upstream errors in logs.
export async function request(fetcher: Fetch, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetcher(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error('Twitch request failed (network error or timeout).');
  }
}

export async function readJson<T>(response: Response): Promise<T> {
  try { return await response.json() as T; }
  catch { throw new Error('Twitch returned invalid JSON.'); }
}
