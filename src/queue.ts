import { setTimeout as sleep } from 'node:timers/promises';

export class RateLimitQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private sent: number[] = [];
  private lastAttempt = -Infinity;
  private readonly abort = new AbortController();

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly wait: (ms: number, signal: AbortSignal) => Promise<void> =
      (ms, signal) => sleep(ms, undefined, { signal }),
  ) {}

  enqueue<T>(send: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.abort.signal.aborted) throw new Error('Chat queue stopped.');
      this.sent = this.sent.filter(time => this.now() - time < 30_000);
      // Also respect the regular account limit of one message/second/channel.
      // https://dev.twitch.tv/docs/chat/#twitch-chat-rate-limits
      while (this.sent.length >= 20 || this.now() - this.lastAttempt < 1000) {
        const windowWait = this.sent.length >= 20 ? this.sent[0]! + 30_000 - this.now() : 0;
        await this.wait(Math.max(1, windowWait, this.lastAttempt + 1000 - this.now()), this.abort.signal);
        this.sent = this.sent.filter(time => this.now() - time < 30_000);
      }
      if (this.abort.signal.aborted) throw new Error('Chat queue stopped.');
      // Count attempts too, so HTTP failures and retries cannot bypass the limit.
      this.lastAttempt = this.now();
      this.sent.push(this.lastAttempt);
      return send();
    });
    this.tail = result.catch(() => {});
    return result;
  }

  stop(): void { this.abort.abort(); }
}
