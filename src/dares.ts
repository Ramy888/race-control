import { compileRule, auditRule, rankChanges } from './rules.js';
import { randomUUID } from 'node:crypto';
import { parseCommand, type ChatInput } from './commands.js';
import { voteWinner, type EventInput, type RaceState } from './ledger.js';

import { generateDare, type DareContent, type MasterContext } from './gamemaster.js';
import type { Config } from './config.js';
export { sampleDares } from './gamemaster.js';
export interface Clock {
  now(): number;
  schedule(callback: () => void, delay: number): () => void;
}
const clock: Clock = {
  now: Date.now,
  schedule: (callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); },
};
export interface DareLedger {
  readonly state: RaceState;
  append(event: EventInput, at: string): Promise<void>;
}

export class DareLoop {
  private pending: Promise<unknown> = Promise.resolve();
  private cancel?: () => void;
  private stopped = false;
  private generating = false;
  private compiling?: string;
  constructor(
    private readonly ledger: DareLedger,
    private readonly broadcasterLogin: string,
    private readonly send: (message: string) => Promise<void>,
    private readonly time: Clock = clock,
    private readonly log: (message: string) => void = console.error,
    private readonly master: (context: MasterContext) => Promise<DareContent> = generateDare,
    private readonly settings: Pick<Config, 'game' | 'gamemaster' | 'voteMs' | 'killMs' | 'minDareMs'> = {},
    private readonly compiler: typeof compileRule = compileRule,
  ) {}

  recordHud(dareId: string, delta: number): Promise<void> {
    return this.run(async () => {
      const dare = this.ledger.state.currentDare;
      if (dare?.dareId === dareId && dare.status === 'running' && Number.isInteger(delta) && delta > 0 && delta <= 5) {
        await this.append({ agent: 'Watcher', type: 'progress', data: { dareId, stat: 'kills', delta } });
      }
    });
  }
  start(): Promise<void> { return this.run(async () => {}); }
  stop(): void { this.stopped = true; this.cancel?.(); }
  private say(message: string): void {
    // Chat delivery cannot delay scoring, deadlines, or other incoming commands.
    void this.send(message).catch(() => this.log('Dare chat reply failed.'));
  }
  private append(event: EventInput): Promise<void> {
    return this.ledger.append(event, new Date(this.time.now()).toISOString());
  }
  private run(work: () => Promise<void>): Promise<void> {
    const result = this.pending.then(async () => {
      if (this.stopped) return;
      this.cancel?.();
      try { await this.advance(); await work(); await this.advance(); }
      finally { this.arm(); }
    });
    this.pending = result.catch(() => {});
    return result;
  }
  private arm(): void {
    this.cancel?.();
    const { currentDare: dare, proposal, pendingRule } = this.ledger.state;
    const deadlines = [proposal?.expiresAt, pendingRule?.expiresAt,
      dare && dare.status !== 'resolved' ? (dare.status === 'voting' ? dare.voteEndsAt : dare.dareEndsAt) : undefined]
      .filter((value): value is string => !!value).map(Date.parse);
    if (this.stopped || !deadlines.length) return;
    const deadline = Math.min(...deadlines);
    this.cancel = this.time.schedule(() => {
      void this.start().catch(() => { this.stop(); this.log('Dare timer failed. Check the Ledger and restart.'); });
    }, Math.max(0, deadline - this.time.now()));
  }
  private async advance(): Promise<void> {
    const rule = this.ledger.state.pendingRule;
    if (rule && this.time.now() >= Date.parse(rule.expiresAt)) {
      await this.append({ agent: 'Referee', type: 'rule_expired', data: { ruleId: rule.ruleId } });
      this.say('Rule expired. !rule to try again.');
    }
    const proposal = this.ledger.state.proposal;
    if (proposal && this.time.now() >= Date.parse(proposal.expiresAt)) {
      await this.append({ agent: 'Referee', type: 'proposal_expired', data: { proposalId: proposal.proposalId } });
      this.say('Proposal expired. !dare for a new one.');
    }
    let dare = this.ledger.state.currentDare;
    if (!dare) return;
    if (dare.status === 'voting' && this.time.now() >= Date.parse(dare.voteEndsAt)) {
      const winner = voteWinner(dare.options);
      await this.append({ agent: 'Referee', type: 'vote_locked', data: { dareId: dare.dareId, winner } });
      const option = dare.options[winner - 1]!;
      const seconds = Math.max(0, Math.ceil((Date.parse(dare.dareEndsAt) - this.time.now()) / 1000));
      this.say(`Vote locked: ${option.title} (${option.tally} votes). ${dare.target.count} kills in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}, go!`);
      dare = this.ledger.state.currentDare!;
    }
    if (dare.status === 'running' && (dare.progress >= dare.target.count || this.time.now() >= Date.parse(dare.dareEndsAt))) {
      const success = dare.progress >= dare.target.count;
      await this.append({ agent: 'Referee', type: 'dare_resolved', data: { dareId: dare.dareId, success } });
      this.say(`Dare ${success ? 'won' : 'lost'}: ${dare.progress}/${dare.target.count} kills. ${this.ledger.state.activeRule ? 'House rule applied.' : 'Correct predictions earn +1.'}`);
    }
  }

  handle(chat: ChatInput): Promise<void> {
    return this.run(async () => {
      const current = this.ledger.state.currentDare;
      const command = parseCommand(chat.text, current?.status === 'voting' ? current.options.map(option => option.title) : []);
      if (!command) return;
      if (command.type === 'reply') { this.say(command.text); return; }
      const broadcaster = chat.login.toLowerCase() === this.broadcasterLogin.toLowerCase();
      const state = this.ledger.state;
      const dare = state.currentDare;
      if (command.type === 'ruleShow') {
        const text = state.activeRule?.text.replace(/[.!?]+$/, '') ?? 'default (+1 per correct call)';
        this.say(`House rule: ${text}. !rule <text> to change, !rule reset for default.`);
        return;
      }
      if (command.type === 'ruleReset') {
        if (!broadcaster) return;
        this.compiling = undefined; // Invalidate a late compile completion after reset.
        await this.append({ agent: 'Commissioner', type: 'rule_adopted', data: { ruleId: 'default' } });
        this.say('Default rule restored. Standings replayed.');
        return;
      }
      if (command.type === 'rule') {
        if (!broadcaster || this.compiling || state.pendingRule) return;
        const ruleId = randomUUID();
        this.compiling = ruleId;
        this.say('Rules Compiler is writing it…');
        void this.compiler(command.text).then(async ({ compiler, auditor }) => {
          if (this.compiling !== ruleId || this.stopped) return;
          const audit = await auditRule(ruleId, compiler, auditor, this.ledger.state.ruleContexts);
          await this.run(async () => {
            if (this.compiling !== ruleId) return;
            await this.append({ agent: 'RulesCompiler', type: 'rule_proposed', data: { ruleId, text: command.text, ...compiler } });
            await this.append({ agent: 'Auditor', type: 'rule_audited', data: { ruleId, ...audit } });
            if (audit.mismatches) this.say(`Auditor disagrees on ${audit.mismatches}/${audit.cases} cases. Rule not adopted. Try rewording.`);
            else {
              const ready = this.ledger.state;
              const changes = rankChanges(ready.fanScores, ready.previewScores ?? ready.fanScores);
              this.say(`Rule ready: ${command.text}. Auditor matched ${audit.cases}/${audit.cases}. Replay: ${changes.join(', ') || 'ranks unchanged'}. !adopt or !reject`);
            }
          });
        }).catch(error => this.run(async () => {
          if (this.compiling !== ruleId) return;
          this.log(`Rules Compiler failed: ${String(error?.message ?? error).slice(0, 200)}`);
          const reason = ['banned code', 'failed examples', 'invalid output'].includes(error?.message) ? error.message as string : 'compilation failed';
          await this.append({ agent: 'RulesCompiler', type: 'rule_failed', data: { ruleId, text: command.text, reason } });
          this.say(`Rule failed: ${reason}. Try rewording.`);
        })).catch(() => this.log('Rule Ledger write failed.'))
          .finally(() => { if (this.compiling === ruleId) this.compiling = undefined; });
        return;
      }
      if (command.type === 'adopt' || command.type === 'reject') {
        if (!broadcaster || !state.pendingRule || (command.type === 'adopt' && state.pendingRule.audit?.mismatches !== 0)) return;
        await this.append({ agent: 'Commissioner', type: command.type === 'adopt' ? 'rule_adopted' : 'rule_rejected', data: { ruleId: state.pendingRule.ruleId } });
        this.say(command.type === 'adopt' ? 'Rule adopted. Standings replayed.' : 'Rule rejected.');
        return;
      }
      if (command.type === 'dare' || command.type === 'reroll') {
        if (!broadcaster || this.generating || (dare && dare.status !== 'resolved') ||
            (command.type === 'dare' ? !!state.proposal : !state.proposal)) return;
        this.generating = true;
        this.say('Game Master is thinking…');
        // Do not await generation here: completion rejoins the serialized command queue.
        void this.master({ game: this.settings.game ?? 'Fortnite', enabled: this.settings.gamemaster !== false,
          previousTitles: state.recentTitles, sampleIndex: state.proposalCount,
        }).then(content => this.run(async () => {
          await this.append({ agent: 'GameMaster', type: 'dare_proposed', data: { proposalId: randomUUID(), ...content } });
          this.say(`Game Master proposes: ${content.title} — ${content.options.map((o, i) => `${i + 1}: ${o}`).join(' | ')}. Stakes: ${content.stakes.replace(/[.!?]+$/, '')}. !approve or !reroll`);
        })).catch(() => this.log('Game Master proposal failed. Try !dare or !reroll again.'))
          .finally(() => { this.generating = false; });
        return;
      }
      if (command.type === 'approve') {
        if (!broadcaster || this.generating || !state.proposal) return;
        const { proposalId: _, expiresAt: __, ...content } = state.proposal;
        const voteMs = this.settings.voteMs ?? 30_000;
        const dareMs = Math.max(this.settings.minDareMs ?? 90_000, Math.min(600_000, content.target.count * (this.settings.killMs ?? 30_000)));
        const voteEndsAt = this.time.now() + voteMs;
        await this.append({ agent: 'Commissioner', type: 'dare_opened', data: {
          ...content, dareId: randomUUID(), voteEndsAt: new Date(voteEndsAt).toISOString(),
          dareEndsAt: new Date(voteEndsAt + dareMs).toISOString(),
        } });
        this.say(`${content.title}. ${content.options.map((option, i) => `${i + 1}: ${option}`).join(' | ')}. Vote with a number, option word, or !pick N. !yes / !no. Vote: ${voteMs / 1000}s.`);
        return;
      }
      if (!dare) return;
      const dareId = dare.dareId;
      switch (command.type) {
        case 'pick':
          if (dare.status === 'voting' && dare.options[command.option - 1]) {
            await this.append({ agent: 'Chat', type: 'vote_cast', data: { dareId, userId: chat.userId, login: chat.login, option: command.option } });
          }
          break;
        case 'predict':
          if (dare.status !== 'resolved') await this.append({ agent: 'Chat', type: 'prediction_cast', data: { dareId, userId: chat.userId, login: chat.login, yes: command.yes } });
          break;
        case 'kill':
          if (broadcaster && dare.status === 'running') {
            await this.append({ agent: 'Referee', type: 'progress', data: { dareId, stat: 'kills', delta: 1 } });
            this.say(`Kills: ${this.ledger.state.currentDare!.progress}/${dare.target.count}.`);
          }
          break;
        case 'overrule':
          if (broadcaster && dare.status === 'resolved') {
            await this.append({ agent: 'Commissioner', type: 'overruled', data: { dareId, success: !dare.success, reason: command.reason } });
            this.say(`Overruled: ${dare.success ? 'loss' : 'win'}. Fan scores updated.`);
          }
          break;
      }
    });
  }
}
