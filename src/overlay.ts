import { rankedFans, type FanScores } from './rules.js';
import type { RaceState } from './ledger.js';

export function toOverlayView(state: RaceState, now: number) {
  const proposal = state.proposal;
  const dare = proposal ? undefined : state.currentDare;
  const votes = dare?.options.reduce((sum, option) => sum + option.tally, 0) ?? 0;
  const predictions = Object.values(dare?.predictions ?? {});
  const yes = predictions.filter(prediction => prediction.yes).length;
  const no = predictions.length - yes;
  const percent = (count: number, total: number) => total ? Math.round(count / total * 100) : 0;
  const yesPercent = percent(yes, predictions.length);
  const top = (scores: FanScores) => rankedFans(scores).slice(0, 5).map(({ login, score }) => ({ login, score }));
  // Explicit public fields only: never spread state, raw events, or user maps.
  return {
    serverNow: now,
    houseRule: state.activeRule?.text ?? null,
    pendingRule: state.pendingRule ? {
      text: state.pendingRule.text, expiresAt: state.pendingRule.expiresAt,
      audit: state.pendingRule.audit ? { cases: state.pendingRule.audit.cases, mismatches: state.pendingRule.audit.mismatches } : null,
      before: top(state.fanScores), after: top(state.previewScores ?? state.fanScores),
    } : null,
    dare: proposal ? {
      title: proposal.title, status: 'proposed' as const, stakes: proposal.stakes, source: proposal.source,
      options: proposal.options.map(title => ({ title, tally: 0, percent: 0 })),
      target: { stat: proposal.target.stat, count: proposal.target.count },
      winner: null, progress: 0, success: null, overruled: false,
      voteEndsAt: proposal.expiresAt, dareEndsAt: proposal.expiresAt,
    } : dare ? {
      title: dare.title, status: dare.status, stakes: dare.stakes ?? '', source: dare.source ?? 'sample',
      options: dare.options.map(option => ({ title: option.title, tally: option.tally, percent: percent(option.tally, votes) })),
      winner: dare.winner ?? null, progress: dare.progress, target: { stat: dare.target.stat, count: dare.target.count },
      voteEndsAt: dare.voteEndsAt, dareEndsAt: dare.dareEndsAt,
      success: dare.success ?? null, overruled: dare.overruled ?? false,
    } : null,
    predictions: { yes: { count: yes, percent: yesPercent }, no: { count: no, percent: predictions.length ? 100 - yesPercent : 0 } },
    topFans: top(state.fanScores),
    agentStrip: state.agentStrip.map(item => ({ agent: item.agent, text: item.text })),
    chatEventCount: state.chatEventCount,
  };
}
