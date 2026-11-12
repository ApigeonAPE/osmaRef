import { describe, expect, it } from 'vitest';
import {
  LogEntrySchema,
  MatchSessionSchema,
  SessionEventSchema,
  sessionEventCategory,
  toLobbyLogSession,
  type SessionEventType,
} from '@osmaref/contracts';

describe('session event categories', () => {
  it('classifies chat, game and operation events', () => {
    const game: SessionEventType[] = [
      'match_started',
      'match_finished',
      'match_completed',
      'match_aborted',
      'beatmap_changed',
      'player_joined',
      'player_left',
      'player_finished',
      'countdown',
    ];
    for (const type of game) expect(sessionEventCategory(type)).toBe('game');
    expect(sessionEventCategory('chat_message')).toBe('chat');
    for (const type of [
      'session_created',
      'room_joined',
      'room_left',
      'manual_adjustment',
      'command_rejected',
      'transport_event',
    ] as SessionEventType[]) {
      expect(sessionEventCategory(type)).toBe('operation');
    }
  });

  it('defaults old events to the operation category', () => {
    const event = SessionEventSchema.parse({
      id: 'event-1',
      sessionId: 'session-1',
      at: '2026-01-01T00:00:00.000Z',
      type: 'action_applied',
      summary: 'pick NM1',
    });
    expect(event.category).toBe('operation');
  });

  it('keeps an explicit chat category', () => {
    const event = SessionEventSchema.parse({
      id: 'event-2',
      sessionId: 'session-1',
      at: '2026-01-01T00:00:00.000Z',
      type: 'chat_message',
      category: 'chat',
      summary: 'Player: hello',
    });
    expect(event.category).toBe('chat');
  });
});

describe('log entries', () => {
  it('defaults details to null and accepts a stack', () => {
    const without = LogEntrySchema.parse({
      id: 'log-1',
      at: '2026-01-01T00:00:00.000Z',
      level: 'info',
      scope: 'room',
      message: 'opened room',
    });
    expect(without.details).toBeNull();
    const withDetails = LogEntrySchema.parse({
      ...without,
      id: 'log-2',
      details: 'Error: boom\n  at test',
    });
    expect(withDetails.details).toContain('boom');
  });
});

describe('lobby log metadata', () => {
  it('maps a session to its log metadata', () => {
    const session = MatchSessionSchema.parse({
      id: 'session-1',
      tournamentId: 'tournament-1',
      matchId: 'match-1',
      tournamentRevision: 3,
      matchName: 'Alpha vs Beta',
      teamOneId: 'team_a',
      teamTwoId: 'team_b',
      transport: 'referee_hub',
      status: 'closed',
      bestOf: 9,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T01:00:00.000Z',
    });
    expect(toLobbyLogSession(session)).toEqual({
      sessionId: 'session-1',
      matchName: 'Alpha vs Beta',
      roomId: null,
      transport: 'referee_hub',
      bestOf: 9,
      status: 'closed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T01:00:00.000Z',
    });
  });
});
