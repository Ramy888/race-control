import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from './dares.js';
import type { RaceState } from './ledger.js';
import type { WatcherConfig } from './config.js';
import { ObsClient } from './obs.js';
import { prepareOcr, type Ocr } from './ocr.js';

export function firstInteger(text: string): number | undefined {
  if (/^[oO]$/.test(text.trim())) return 0; // Vision's fast pass reads a lone HUD zero as the letter o.
  // Never turn a 4-digit OCR token into a smaller, plausible kill count.
  const token = text.match(/(?<![\d.-])\d{1,3}(?![\d.])/);
  return token ? Number(token[0]) : undefined;
}
const clock: Clock = {
  now: Date.now,
  schedule: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
};
export class Watcher {
  private stopped = false;
  private started = false;
  private reading = false;
  private cancel?: () => void;
  private dareId?: string;
  private previous?: number;
  private accepted?: number;
  private jumpLogged = false;
  private errorLogged = false;
  constructor(
    private readonly config: WatcherConfig,
    private readonly state: () => RaceState,
    private readonly progress: (dareId: string, delta: number) => Promise<void>,
    private readonly screenshot: (source: string) => Promise<Buffer>,
    private readonly ocr: Ocr,
    private readonly time: Clock = clock,
    private readonly log: (message: string) => void = console.error,
  ) {}
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const tick = () => {
      if (this.stopped) return;
      this.cancel = this.time.schedule(tick, this.config.interval);
      void this.read().catch(() => { if (!this.errorLogged) { this.errorLogged = true; this.log('Watcher: frame cleanup failed.'); } });
    };
    tick();
  }
  stop(): void { this.stopped = true; this.cancel?.(); }
  async read(): Promise<void> {
    if (this.stopped || this.reading) return;
    const dare = this.state().currentDare;
    if (!dare || dare.status !== 'running' || this.time.now() >= Date.parse(dare.dareEndsAt)) {
      this.dareId = undefined; this.previous = undefined; this.accepted = undefined; return;
    }
    if (dare.dareId !== this.dareId) {
      this.dareId = dare.dareId; this.previous = undefined; this.accepted = undefined; this.jumpLogged = false;
    }
    this.reading = true;
    let directory: string | undefined;
    try {
      const png = await this.screenshot(this.config.source);
      directory = await mkdtemp(join(tmpdir(), 'race-hud-'));
      const path = join(directory, 'frame.png');
      await writeFile(path, png, { mode: 0o600 });
      const value = firstInteger(await this.ocr(path, this.config.region));
      const current = this.state().currentDare;
      if (this.stopped || current?.dareId !== dare.dareId || current.status !== 'running' || this.time.now() >= Date.parse(current.dareEndsAt)) return;
      if (value === undefined) return; // Unreadable frames do not alter the last readable sample.
      if (value !== this.previous) { this.previous = value; return; }
      if (this.accepted === undefined || value < this.accepted) { this.accepted = value; return; }
      const delta = value - this.accepted;
      if (delta > 5) {
        if (!this.jumpLogged) { this.jumpLogged = true; this.log('Watcher: HUD jump above 5 ignored.'); }
        return;
      }
      if (delta > 0) { await this.progress(dare.dareId, delta); this.accepted = value; }
    } catch {
      if (!this.errorLogged) { this.errorLogged = true; this.log('Watcher: frame/OCR read failed; retrying.'); }
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { this.reading = false; }
    }
  }
}

export async function startWatcher(
  config: WatcherConfig, state: () => RaceState, progress: (dareId: string, delta: number) => Promise<void>,
  dependencies: { prepare: () => Promise<Ocr | undefined>; connect: (url: string, password: string) => Pick<ObsClient, 'screenshot' | 'stop'>; log: (message: string) => void } = { prepare: prepareOcr, connect: (url, password) => new ObsClient(url, password), log: console.log },
): Promise<() => void> {
  if (!config.source) return () => {};
  const ocr = await dependencies.prepare();
  if (!ocr) return () => {};
  const obs = dependencies.connect(config.obsUrl, config.obsPassword);
  const watcher = new Watcher(config, state, progress, source => obs.screenshot(source), ocr);
  dependencies.log(`Watcher: source=${config.source}, region=${config.region.join(',')}, interval=${config.interval}ms`);
  watcher.start();
  return () => { watcher.stop(); obs.stop(); };
}
