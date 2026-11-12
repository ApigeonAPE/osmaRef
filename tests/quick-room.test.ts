import { describe, expect, it } from 'vitest';
import {
  buildQuickTournament,
  createSession,
  normalizeBestOf,
  applyAction,
} from '@osmaref/domain';
import { MatchSessionSchema, TournamentSchema } from '@osmaref/contracts';

describe('quick room configuration', () => {
  it('produces a valid tournament with one beatmap and a picks-only flow', () => {
    const tournament = buildQuickTournament({
      name: 'Quick room',
      beatmapId: 658127,
      rulesetId: 0,
      matchType: 'team_versus',
      transport: 'referee_hub',
      bestOf: 9,
    });

    expect(TournamentSchema.safeParse(tournament).success).toBe(true);
    expect(tournament.rounds).toHaveLength(1);
    expect(tournament.rounds[0]?.slots[0]?.beatmapId).toBe(658127);
    expect(tournament.rounds[0]?.flow.steps.map((step) => step.kind)).toEqual(['pick']);
    expect(tournament.matches[0]?.initialBeatmapId).toBe(658127);
    expect(tournament.rounds[0]?.bestOf).toBe(9);
    expect(tournament.source).toBeNull();
  });

  it('normalises the best-of value to a legal odd number', () => {
    expect(normalizeBestOf(1)).toBe(1);
    expect(normalizeBestOf(8)).toBe(9);
    expect(normalizeBestOf(9)).toBe(9);
    expect(normalizeBestOf(0)).toBe(1);
    expect(normalizeBestOf(100)).toBe(31);
  });

  it('allows an IRC room without an initial beatmap', () => {
    const tournament = buildQuickTournament({
      name: 'IRC lobby',
      beatmapId: null,
      rulesetId: 0,
      matchType: 'head_to_head',
      transport: 'irc',
      bestOf: 1,
    });

    expect(TournamentSchema.safeParse(tournament).success).toBe(true);
    expect(tournament.rounds[0]?.slots).toEqual([]);
    expect(tournament.matches[0]?.initialBeatmapId).toBeNull();
    // The session can still be created and the flow exists for later picks.
    expect(tournament.rounds[0]?.flow.steps.length).toBeGreaterThan(0);
  });

  it('keeps the snapshot on the session so it survives without the store', () => {
    const tournament = buildQuickTournament({
      name: 'Quick room',
      beatmapId: 1,
      rulesetId: 0,
      matchType: 'team_versus',
      transport: 'irc',
      bestOf: 3,
    });
    const match = tournament.matches[0]!;
    const flow = tournament.rounds[0]!.flow;
    const session = createSession(
      {
        id: 'session_quick',
        tournamentId: tournament.id,
        matchId: match.id,
        matchName: match.name,
        teamOneId: match.teamOneId,
        teamTwoId: match.teamTwoId,
        tournamentRevision: tournament.revision,
        rulesetId: tournament.rulesetId,
        matchType: tournament.defaultMatchType,
        transport: 'irc',
        bestOf: tournament.rounds[0]!.bestOf,
        configSnapshot: tournament,
        now: '2026-01-01T00:00:00.000Z',
      },
      flow,
    );

    expect(MatchSessionSchema.safeParse(session).success).toBe(true);
    expect(session.configSnapshot?.name).toBe('Quick room');
    expect(session.queue[0]?.kind).toBe('pick');

    const next = applyAction(session, {
      kind: 'pick',
      teamId: session.teamOneId,
      slotLabel: 'NM1',
      beatmapId: 1,
      byUserId: 9001,
      at: '2026-01-01T00:00:05.000Z',
    });
    expect(next.phase).toBe('playing');
    expect(next.currentBeatmapId).toBe(1);
  });
});