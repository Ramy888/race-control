import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { evaluate, type RuleSpec, type PendingRule, type Audit, type RuleContext, type FanScores } from './rules.js';
import type { DareContent } from './gamemaster.js';

export interface Proposal extends DareContent { proposalId: string; expiresAt: string }

export interface DareSpec {
  dareId: string;
  stakes?: string;
  source?: DareContent['source'];
  title: string;
  options: string[];
  target: { stat: 'kills'; count: number };
  voteEndsAt: string;
  dareEndsAt: string;
}
type Payloads = {
  rule_proposed: RuleSpec;
  rule_audited: Audit & { ruleId: string };
  rule_adopted: { ruleId: string };
  rule_rejected: { ruleId: string };
  rule_expired: { ruleId: string };
  rule_failed: { ruleId: string; text: string; reason: string };
  dare_proposed: DareContent & { proposalId: string };
  proposal_expired: { proposalId: string };
  dare_opened: DareSpec;
  vote_cast: { dareId: string; userId: string; login: string; option: number };
  prediction_cast: { dareId: string; userId: string; login: string; yes: boolean };
  vote_locked: { dareId: string; winner: number };
  progress: { dareId: string; stat: 'kills'; delta: number };
  dare_resolved: { dareId: string; success: boolean };
  overruled: { dareId: string; success: boolean; reason: string };
};
export const agents = {
  rule_proposed: 'RulesCompiler', rule_audited: 'Auditor', rule_adopted: 'Commissioner',
  rule_rejected: 'Commissioner', rule_failed: 'RulesCompiler', rule_expired: 'Referee',
  dare_proposed: 'GameMaster', proposal_expired: 'Referee',
  dare_opened: 'Commissioner', vote_cast: 'Chat', prediction_cast: 'Chat',
  vote_locked: 'Referee', progress: 'Referee', dare_resolved: 'Referee', overruled: 'Commissioner',
} as const;
export type EventInput = { [K in keyof Payloads]: { type: K; agent: K extends 'dare_opened' ? 'Commissioner' | 'GameMaster' : typeof agents[K]; data: Payloads[K] } }[keyof Payloads];
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
  activeRule?: RuleSpec;
  pendingRule?: PendingRule;
  ruleContexts: RuleContext[];
  ruleErrors: string[];
  previewScores?: FanScores;
  currentDare?: DareState;
  proposal?: Proposal;
  proposalCount: number;
  recentTitles: string[];
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
  const state: RaceState = { ruleContexts: [], ruleErrors: [], fanScores: Object.create(null), lastEvents: structuredClone(events.slice(-20)), dareCount: 0, proposalCount: 0, recentTitles: [], chatEventCount: 0, agentStrip: [] };
  const activity = (agent: string, text: string) => {
    state.agentStrip.push({ agent, text });
    state.agentStrip = state.agentStrip.slice(-5);
  };
  const dares = new Map<string, DareState>();
  for (const event of events) {
    if (event.agent !== agents[event.type] && !(event.type === 'dare_opened' && event.agent === 'GameMaster')) continue;
    switch (event.type) {
      case 'rule_proposed':
        if (!state.pendingRule) {
          state.pendingRule = { ...structuredClone(event.data), expiresAt: new Date(Date.parse(event.at) + 120_000).toISOString() };
          activity(event.agent, `Rule written: ${event.data.text}`);
        }
        continue;
      case 'rule_audited':
        if (state.pendingRule?.ruleId === event.data.ruleId) {
          state.pendingRule.audit = structuredClone(event.data);
          activity(event.agent, event.data.mismatches ? `Audit failed ${event.data.mismatches}/${event.data.cases}` : `Audit passed ${event.data.cases}/${event.data.cases}`);
          if (event.data.mismatches) delete state.pendingRule;
        }
        continue;
      case 'rule_adopted':
        if (event.data.ruleId === 'default') {
          delete state.activeRule; delete state.pendingRule;
          activity(event.agent, 'Rule adopted');
        } else if (state.pendingRule?.ruleId === event.data.ruleId && state.pendingRule.audit?.mismatches === 0 &&
            state.pendingRule.audit.cases > 0 && Date.parse(event.at) < Date.parse(state.pendingRule.expiresAt)) {
          const { expiresAt: _, audit: __, ...rule } = state.pendingRule;
          state.activeRule = rule;
          delete state.pendingRule;
          activity(event.agent, 'Rule adopted');
        }
        continue;
      case 'rule_rejected':
      case 'rule_expired':
        if (state.pendingRule?.ruleId === event.data.ruleId && (event.type === 'rule_rejected' || Date.parse(event.at) >= Date.parse(state.pendingRule.expiresAt))) {
          delete state.pendingRule;
          activity(event.agent, event.type === 'rule_rejected' ? 'Rule rejected' : 'Rule expired');
        }
        continue;
      case 'rule_failed':
        if (state.pendingRule?.ruleId === event.data.ruleId) delete state.pendingRule;
        activity(event.agent, `Rule failed: ${event.data.reason}`);
        continue;
    }
    if (event.type === 'dare_proposed') {
      if (state.currentDare && state.currentDare.status !== 'resolved') continue;
      if (state.proposal) activity('Commissioner', 'Rerolled');
      state.proposal = { ...structuredClone(event.data), expiresAt: new Date(Date.parse(event.at) + 120_000).toISOString() };
      state.proposalCount++;
      activity(event.agent, `Proposed: ${event.data.title}`);
      if (event.data.source === 'fallback') activity(event.agent, 'Fallback dare (AI unavailable)');
      continue;
    }
    if (event.type === 'proposal_expired') {
      if (state.proposal?.proposalId === event.data.proposalId && Date.parse(event.at) >= Date.parse(state.proposal.expiresAt)) {
        delete state.proposal;
        activity(event.agent, 'Proposal expired');
      }
      continue;
    }
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
      delete state.proposal;
      state.recentTitles = [...state.recentTitles, dare.title].slice(-5);
      activity(event.agent, event.agent === 'Commissioner' ? 'Approved by streamer' : `Opened: ${dare.title}`);
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
  // Recompute across all dares under the final adopted rule, including overrules.
  if (state.pendingRule?.audit?.mismatches === 0) state.previewScores = Object.create(null) as FanScores;
  const score = (rule: RuleSpec | undefined, ctx: RuleContext) => {
    if (!rule) return ctx.correct ? 1 : 0;
    const result = evaluate(rule.ruleId, rule.code, ctx);
    if (!result.valid && !state.ruleErrors.includes(rule.ruleId)) state.ruleErrors.push(rule.ruleId);
    return result.points;
  };
  for (const dare of dares.values()) {
    const predictions = Object.values(dare.predictions);
    const yesCount = predictions.filter(prediction => prediction.yes).length;
    for (const [userId, prediction] of Object.entries(dare.predictions)) {
      const fan = state.fanScores[userId] ??= { login: prediction.login, score: 0 };
      fan.login = prediction.login;
      const preview = state.previewScores && (state.previewScores[userId] ??= { login: prediction.login, score: 0 });
      if (preview) preview.login = prediction.login;
      if (dare.status !== 'resolved') continue;
      const ctx: RuleContext = { correct: prediction.yes === dare.success, yes: prediction.yes, success: !!dare.success,
        overruled: !!dare.overruled, yesCount, noCount: predictions.length - yesCount,
        target: Math.trunc(dare.target.count), progress: Math.trunc(dare.progress) };
      state.ruleContexts.push(ctx);
      fan.score += score(state.activeRule, ctx);
      if (preview) preview.score += score(state.pendingRule, ctx);
    }
  }
  return state;
}

export class Ledger {
  private events: LedgerEvent[] = [];
  private readonly loggedRules = new Set<string>();
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
          !Object.hasOwn(agents, event.type) || (event.agent !== agents[event.type] && !(event.type === 'dare_opened' && event.agent === 'GameMaster')) ||
          !event.data || !('dareId' in event.data ? event.data.dareId : 'proposalId' in event.data ? event.data.proposalId : event.data.ruleId)) {
        throw new Error(`Invalid Ledger event at line ${index + 1}.`);
      }
      return event;
    });
    return ledger;
  }

  get state(): RaceState {
    const state = replay(this.events);
    for (const ruleId of state.ruleErrors) if (!this.loggedRules.has(ruleId)) {
      this.loggedRules.add(ruleId);
      console.error('Scoring rule returned invalid points; scored 0.');
    }
    return state;
  }

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
