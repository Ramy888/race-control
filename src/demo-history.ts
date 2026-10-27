import type { EventInput, LedgerEvent } from './ledger.js';

export const historyNotice = 'loaded 3 earlier dares from this stream (sample history) so the standings have something to re-score.';

// Different participation counts make penalties change ranks, not just point totals.
// The third result includes a manual correction so the recorded overrule rule also matters.
export function demoHistory(now: number): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const predictions = [
    { viewer01: false, viewer02: true, viewer03: true, viewer04: true, viewer05: false },
    { viewer01: true, viewer05: true, viewer06: false },
    { viewer01: true, viewer02: true },
  ];
  const iso = (ms: number) => new Date(ms).toISOString();
  for (let i = 0; i < 3; i++) {
    const start = now - (3 - i) * 180_000, dareId = `sample-history-${i + 1}`;
    const append = (event: EventInput, offset: number) => events.push({ ...event, seq: events.length + 1, at: iso(start + offset) });
    append({ agent: 'GameMaster', type: 'dare_opened', data: {
      dareId, title: ['Earlier: 3 kills, pistols only', 'Earlier: 3 kills, no shields', 'Earlier: 3 kills, shotgun only'][i]!,
      options: [['Pistols only', 'Shotgun only'], ['No shields', 'No healing'], ['Shotgun only', 'Pistols only']][i]!, target: { stat: 'kills', count: 3 }, source: 'sample',
      stakes: 'Sample history from earlier this stream.', voteEndsAt: iso(start + 10_000), dareEndsAt: iso(start + 30_000),
    } }, 0);
    for (const [login, yes] of Object.entries(predictions[i]!)) {
      append({ agent: 'Chat', type: 'vote_cast', data: { dareId, userId: login, login, option: 1 } }, 1000);
      append({ agent: 'Chat', type: 'prediction_cast', data: { dareId, userId: login, login, yes } }, 2000);
    }
    append({ agent: 'Referee', type: 'vote_locked', data: { dareId, winner: 1 } }, 10_000);
    for (let kill = 1; kill <= (i === 0 ? 3 : 2); kill++) {
      append({ agent: 'Referee', type: 'progress', data: { dareId, stat: 'kills', delta: 1 } }, 10_000 + kill * 1000);
    }
    append({ agent: 'Referee', type: 'dare_resolved', data: { dareId, success: i === 0 } }, i === 0 ? 13_000 : 30_000);
    if (i === 2) append({ agent: 'Commissioner', type: 'overruled', data: {
      dareId, success: true, reason: 'Sample history: streamer corrected a missed kill.',
    } }, 31_000);
  }
  return events;
}
