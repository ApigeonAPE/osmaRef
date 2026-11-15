import { describe, expect, it } from 'vitest';
import {
  buildQuickTournament,
  createSession,
  normalizeBestOf,
  applyAction,
} from '@osmaref/domain';
import { MatchSessionSchema, TournamentSchema, matchTeamIds } from '@osmaref/contracts';

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
    expect(tournament.stages).toHaveLength(1);
    const stage = tournament.stages[0]!;
    expect(stage.slots[0]?.beatmapId).toBe(658127);
    expect(stage.flow.phases.map((phase) => phase.action)).toEqual(['pick']);
    expect(stage.flow.phases[0]?.countPerTeam).toBeNull();
    expect(stage.bestOf).toBe(9);
    expect(tournament.source).toBeNull();
    const match = stage.matches[0]!;
    expect(match.type).toBe('match');
    expect(tournament.platform).toBe('lazer');
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
    expect(tournament.stages[0]?.slots).toEqual([]);
    expect(tournament.platform).toBe('stable');
    expect(tournament.stages[0]?.flow.phases.length).toBeGreaterThan(0);
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
    const stage = tournament.stages[0]!;
    const match = stage.matches[0]!;
    const participantIds = matchTeamIds(match).map(String);
    const session = createSession(
      {
        id: 'session_quick',
        tournamentId: tournament.id,
        matchId: match.id,
        matchName: 'Quick room',
        matchKind: match.type,
        participantIds,
        teamOneId: participantIds[0]!,
        teamTwoId: participantIds[1]!,
        tournamentRevision: tournament.revision,
        rulesetId: 0,
        matchType: match.roomMode,
        transport: 'irc',
        bestOf: stage.bestOf,
        configSnapshot: tournament,
        now: '2026-01-01T00:00:00.000Z',
      },
      stage.flow,
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
