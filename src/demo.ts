import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { Config } from './config.js';
import { parseCommand, type ChatInput } from './commands.js';
import { DareLoop } from './dares.js';
import { generateDare } from './gamemaster.js';
import { demoHistory, historyNotice } from './demo-history.js';
import { Ledger } from './ledger.js';

export const demoLedgerPath = '.data/demo.jsonl';
export function demoEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, MOCK: '1', DEMO: '1', LEDGER_PATH: demoLedgerPath,
    PORT: env.PORT || '3000', VOTE_SECONDS: '10', SECONDS_PER_KILL: '6', MIN_DARE_SECONDS: '20' };
}
export async function freshDemo(env: NodeJS.ProcessEnv, remove = rm): Promise<NodeJS.ProcessEnv> {
  // Always delete this fixed demo file, never an inherited LEDGER_PATH.
  await remove(demoLedgerPath, { force: true });
  return demoEnvironment(env);
}
export async function codexAvailable(run: (file: string, args: string[], options: { timeout: number }) => Promise<unknown> = promisify(execFile)): Promise<boolean> {
  try { await run('codex', ['--version'], { timeout: 2000 }); return true; }
  catch { return false; }
}

export class DemoFeed {
  private sequence = 0;
  private history: { id: number; from: string; text: string }[] = [];
  private clients = new Set<ServerResponse>();
  publish(from: string, text: string): void {
    const line = { id: ++this.sequence, from, text };
    this.history.push(line); this.history = this.history.slice(-200);
    for (const client of this.clients) this.send(client, line);
  }
  private send(client: ServerResponse, line: { id: number; from: string; text: string }): void {
    if (client.writableLength > 1_000_000) { client.destroy(); return; }
    client.write(`id: ${line.id}\ndata: ${JSON.stringify({ from: line.from, text: line.text })}\n\n`);
  }
  connect(res: ServerResponse, lastId = 0): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    this.clients.add(res);
    for (const line of this.history) if (line.id > lastId) this.send(res, line);
    res.on('close', () => this.clients.delete(res));
  }
  clear(): void { this.history = []; }
  stop(): void { for (const client of this.clients) client.end(); this.clients.clear(); }
}

export class MockSession {
  readonly feed = new DemoFeed();
  readonly canReset: boolean;
  private loop!: DareLoop;
  private unsubscribe?: () => void;
  private listeners = new Set<() => void>();
  private pending: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private constructor(
    private ledger: Ledger, readonly config: Config, readonly hasCodex: boolean,
    private readonly master = generateDare,
  ) { this.canReset = !!config.demo && basename(config.ledgerPath ?? '') === 'demo.jsonl'; }
  static async open(config: Config, hasCodex: boolean, master = generateDare): Promise<MockSession> {
    const session = new MockSession(await Ledger.open(config.ledgerPath), config, hasCodex, master);
    await session.bind(); return session;
  }
  private async bind(): Promise<void> {
    if (this.canReset && !this.ledger.state.lastEvents.length) {
      for (const event of demoHistory(Date.now())) await this.ledger.append(event, event.at);
      this.feed.publish('Demo guide', historyNotice);
    }
    this.unsubscribe = this.ledger.onAppend(() => this.notify());
    this.loop = new DareLoop(this.ledger, this.config.broadcasterLogin, async text => {
      console.log(`[chat] ${text}`); this.feed.publish('Race Control', text);
      if (text.startsWith('Rule failed: compilation failed')) {
        this.feed.publish('Race Control', 'Codex not available for this rule. Check your Codex login and model access, then retry.');
      }
    }, undefined, undefined, this.master, this.config);
    if (!this.stopped) await this.loop.start();
  }
  get state() { return this.ledger.state; }
  onAppend(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(): void { for (const listener of this.listeners) { try { listener(); } catch { /* Observer owns its errors. */ } } }
  private run(work: () => Promise<void>): Promise<void> {
    const result = this.pending.then(async () => { if (!this.stopped) await work(); });
    this.pending = result.catch(() => {}); return result;
  }
  handle(chat: ChatInput): Promise<void> {
    return this.run(async () => {
      this.feed.publish(chat.login, chat.text);
      if (!this.hasCodex && chat.login.toLowerCase() === this.config.broadcasterLogin.toLowerCase() && parseCommand(chat.text)?.type === 'rule') {
        const text = 'Codex not available: !rule needs a logged-in Codex CLI.';
        console.log(`[chat] ${text}`); this.feed.publish('Race Control', text); return;
      }
      await this.loop.handle(chat);
    });
  }
  recordHud(id: string, delta: number): Promise<void> { return this.run(() => this.loop.recordHud(id, delta)); }
  reset(): Promise<void> {
    if (!this.canReset) return Promise.reject(new Error('Reset requires npm run demo and a demo.jsonl Ledger.'));
    return this.run(async () => {
      this.loop.stop(); await this.loop.start(); // Drain queued writes; late AI completions see the stopped loop.
      this.unsubscribe?.();
      await mkdir(dirname(this.config.ledgerPath!), { recursive: true });
      await rm(this.config.ledgerPath!, { force: true });
      await writeFile(this.config.ledgerPath!, '', { mode: 0o600 });
      this.ledger = await Ledger.open(this.config.ledgerPath);
      this.feed.clear(); await this.bind(); this.notify();
      this.feed.publish('Race Control', 'Demo reset. Ready for !dare.');
    });
  }
  stop(): void { this.stopped = true; this.loop.stop(); this.unsubscribe?.(); this.feed.stop(); }
}
