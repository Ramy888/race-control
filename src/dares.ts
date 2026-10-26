import { randomUUID } from 'node:crypto';
import { parseCommand, type ChatInput } from './commands.js';
import { voteWinner, type EventInput, type RaceState } from './ledger.js';

export const sampleDares = [
  { title: "3 kills with chat's pick", options: ['SHOTGUN · no armor', 'SNIPER · no scope', 'KNIFE ONLY'], count: 3, voteMs: 30_000, dareMs: 90_000 },
  { title: "15 kills with chat's pick", options: ['SHOTGUN · no armor', 'SNIPER · no scope', 'KNIFE ONLY'], count: 15, voteMs: 60_000, dareMs: 600_000 },
];
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
  constructor(
    private readonly ledger: DareLedger,
    private readonly broadcasterLogin: string,
    private readonly send: (message: string) => Promise<void>,
    private readonly time: Clock = clock,
    private readonly log: (message: string) => void = console.error,
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
    const dare = this.ledger.state.currentDare;
    if (this.stopped || !dare || dare.status === 'resolved') return;
    const deadline = dare.status === 'voting' ? dare.voteEndsAt : dare.dareEndsAt;
    this.cancel = this.time.schedule(() => {
      void this.start().catch(() => { this.stop(); this.log('Dare timer failed. Check the Ledger and restart.'); });
    }, Math.max(0, Date.parse(deadline) - this.time.now()));
  }
  private async advance(): Promise<void> {
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
      const command = parseCommand(chat.text);
      if (!command) return;
      if (command.type === 'reply') { this.say(command.text); return; }
      const broadcaster = chat.login.toLowerCase() === this.broadcasterLogin.toLowerCase();
      const state = this.ledger.state;
      const dare = state.currentDare;
      if (command.type === 'dare') {
        if (!broadcaster || (dare && dare.status !== 'resolved')) return;
        const sample = sampleDares[state.dareCount % sampleDares.length]!;
        const voteEndsAt = this.time.now() + sample.voteMs;
        await this.append({ agent: 'GameMaster', type: 'dare_opened', data: {
          dareId: randomUUID(), title: sample.title, options: sample.options,
          target: { stat: 'kills', count: sample.count }, voteEndsAt: new Date(voteEndsAt).toISOString(),
          dareEndsAt: new Date(voteEndsAt + sample.dareMs).toISOString(),
        } });
        this.say(`${sample.title}. ${sample.options.map((option, i) => `${i + 1}: ${option}`).join(' | ')}. !pick N, !yes / !no. Vote: ${sample.voteMs / 1000}s.`);
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
