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
  constructor(
    private readonly ledger: DareLedger,
    private readonly broadcasterLogin: string,
    private readonly send: (message: string) => Promise<void>,
    private readonly time: Clock = clock,
    private readonly log: (message: string) => void = console.error,
    private readonly master: (context: MasterContext) => Promise<DareContent> = generateDare,
    private readonly settings: Pick<Config, 'game' | 'gamemaster' | 'voteMs' | 'killMs'> = {},
  ) {}

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
    const { currentDare: dare, proposal } = this.ledger.state;
    if (this.stopped || (!proposal && (!dare || dare.status === 'resolved'))) return;
    const deadline = proposal?.expiresAt ?? (dare!.status === 'voting' ? dare!.voteEndsAt : dare!.dareEndsAt);
    this.cancel = this.time.schedule(() => {
      void this.start().catch(() => { this.stop(); this.log('Dare timer failed. Check the Ledger and restart.'); });
    }, Math.max(0, Date.parse(deadline) - this.time.now()));
  }
  private async advance(): Promise<void> {
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
      this.say(`Dare ${success ? 'won' : 'lost'}: ${dare.progress}/${dare.target.count} kills. Correct predictions earn +1.`);
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
        const dareMs = Math.max(90_000, Math.min(600_000, content.target.count * (this.settings.killMs ?? 30_000)));
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
