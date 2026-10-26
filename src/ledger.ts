import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DareSpec {
  dareId: string;
  title: string;
  options: string[];
  target: { stat: 'kills'; count: number };
  voteEndsAt: string;
  dareEndsAt: string;
}
type Payloads = {
  dare_opened: DareSpec;
  vote_cast: { dareId: string; userId: string; login: string; option: number };
  prediction_cast: { dareId: string; userId: string; login: string; yes: boolean };
  vote_locked: { dareId: string; winner: number };
  progress: { dareId: string; stat: 'kills'; delta: number };
  dare_resolved: { dareId: string; success: boolean };
  overruled: { dareId: string; success: boolean; reason: string };
};
export const agents = {
  dare_opened: 'GameMaster', vote_cast: 'Chat', prediction_cast: 'Chat',
  vote_locked: 'Referee', progress: 'Referee', dare_resolved: 'Referee', overruled: 'Commissioner',
} as const;
export type EventInput = { [K in keyof Payloads]: { type: K; agent: typeof agents[K]; data: Payloads[K] } }[keyof Payloads];
export type LedgerEvent = EventInput & { seq: number; at: string };
export interface DareState extends Omit<DareSpec, 'options'> {
  options: { title: string; tally: number }[];
  votes: Record<string, number>;
  predictions: Record<string, { login: string; yes: boolean }>;
  winner?: number; // One-based, matching !pick N.
  progress: number;
  status: 'voting' | 'running' | 'resolved';
  success?: boolean;
  overruled?: boolean;
}
export interface RaceState {
  currentDare?: DareState;
  fanScores: Record<string, { login: string; score: number }>;
  lastEvents: LedgerEvent[];
  dareCount: number;
  chatEventCount: number;
  agentStrip: { agent: string; text: string }[];
}

export function voteWinner(options: DareState['options']): number {
  return options.reduce((best, option, index) => option.tally > options[best]!.tally ? index : best, 0) + 1;
}

export function replay(events: readonly LedgerEvent[]): RaceState {
  const state: RaceState = { fanScores: Object.create(null), lastEvents: structuredClone(events.slice(-20)), dareCount: 0, chatEventCount: 0, agentStrip: [] };
  const activity = (agent: string, text: string) => {
    state.agentStrip.push({ agent, text });
    state.agentStrip = state.agentStrip.slice(-5);
  };
  const dares = new Map<string, DareState>();
  for (const event of events) {
    if (event.agent !== agents[event.type]) continue;
    if (event.agent === 'Chat') state.chatEventCount++;
    if (event.type === 'dare_opened') {
      const spec = event.data;
      if (dares.has(spec.dareId) || (state.currentDare && state.currentDare.status !== 'resolved') ||
          spec.options.length < 2 || spec.options.length > 4 || spec.target.count <= 0) continue;
      const dare: DareState = {
        ...structuredClone(spec), options: spec.options.map(title => ({ title, tally: 0 })),
        votes: Object.create(null), predictions: Object.create(null), progress: 0, status: 'voting',
      };
      dares.set(spec.dareId, dare);
      state.currentDare = dare;
      state.dareCount++;
      activity(event.agent, `Opened: ${dare.title}`);
      continue;
    }
    const dare = dares.get(event.data.dareId);
    if (!dare) continue;
    const at = Date.parse(event.at);
    switch (event.type) {
      case 'vote_cast': {
        const { userId, option } = event.data;
        if (dare.status !== 'voting' || at >= Date.parse(dare.voteEndsAt) || !Number.isInteger(option) || !dare.options[option - 1]) break;
        const previous = dare.votes[userId];
        if (previous !== undefined) dare.options[previous - 1]!.tally--;
        dare.votes[userId] = option;
        dare.options[option - 1]!.tally++;
        break;
      }
      case 'prediction_cast':
        if (dare.status !== 'resolved' && at < Date.parse(dare.dareEndsAt)) {
          dare.predictions[event.data.userId] = { login: event.data.login, yes: event.data.yes };
        }
        break;
      case 'vote_locked':
        if (dare.status === 'voting' && at >= Date.parse(dare.voteEndsAt)) {
          dare.winner = voteWinner(dare.options);
          dare.status = 'running';
          activity(event.agent, `Vote locked: ${dare.options[dare.winner - 1]!.title}`);
        }
        break;
      case 'progress':
        if (dare.status === 'running' && at <= Date.parse(dare.dareEndsAt) && event.data.stat === dare.target.stat &&
            Number.isFinite(event.data.delta) && event.data.delta > 0) {
          dare.progress += event.data.delta;
          activity(event.agent, `Kills ${dare.progress}/${dare.target.count}`);
        }
        break;
      case 'dare_resolved':
        if (dare.status === 'running' && (dare.progress >= dare.target.count || at >= Date.parse(dare.dareEndsAt))) {
          dare.status = 'resolved';
          dare.success = dare.progress >= dare.target.count;
          activity(event.agent, dare.success ? 'Dare won' : 'Dare lost');
        }
        break;
      case 'overruled':
        if (dare.status === 'resolved' && event.data.reason.trim() && event.data.success !== dare.success) {
          dare.success = event.data.success;
          dare.overruled = true;
          activity(event.agent, `Overruled: ${dare.success ? 'win' : 'loss'}`);
        }
        break;
    }
  }
  // Recompute across all dares, so corrections never double-credit predictions.
  for (const dare of dares.values()) {
    for (const [userId, prediction] of Object.entries(dare.predictions)) {
      const fan = state.fanScores[userId] ??= { login: prediction.login, score: 0 };
      fan.login = prediction.login;
      if (dare.status === 'resolved' && prediction.yes === dare.success) fan.score++;
    }
  }
  return state;
}

export class Ledger {
  private events: LedgerEvent[] = [];
  private readonly listeners = new Set<() => void>();
  private pending: Promise<unknown> = Promise.resolve();
  private constructor(private readonly path: string) {}

  static async open(path = '.data/ledger.jsonl'): Promise<Ledger> {
    const ledger = new Ledger(path);
    let content: string;
    try { content = await readFile(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ledger;
      throw error;
    }
    // Fail closed on a partial/corrupt record; never silently discard history.
    if (content && !content.endsWith('\n')) throw new Error('Ledger has an incomplete final line. Repair it before restarting.');
    ledger.events = content.split('\n').filter(Boolean).map((line, index) => {
      const event = JSON.parse(line) as LedgerEvent;
      if (event.seq !== index + 1 || !Number.isFinite(Date.parse(event.at)) ||
          !Object.hasOwn(agents, event.type) || event.agent !== agents[event.type] || !event.data?.dareId) {
        throw new Error(`Invalid Ledger event at line ${index + 1}.`);
      }
      return event;
    });
    return ledger;
  }

  get state(): RaceState { return replay(this.events); }

  onAppend(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  append(input: EventInput, at = new Date().toISOString()): Promise<void> {
    const copy = structuredClone(input);
    const result = this.pending.then(async () => {
      const event: LedgerEvent = { ...copy, seq: this.events.length + 1, at };
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, JSON.stringify(event) + '\n', { mode: 0o600 });
      this.events.push(event);
      for (const listener of this.listeners) {
        // A disconnected observer must not turn a committed write into a failure.
        try { listener(); } catch { /* Observers own their error handling. */ }
      }
    });
    // A failed write poisons this writer: continuing could append after a partial line.
    this.pending = result;
    return result;
  }
}
