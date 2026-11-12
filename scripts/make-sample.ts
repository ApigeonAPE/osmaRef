import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  parseTournament,
  createEmptyTournament,
  type MappoolSlot,
} from '../packages/contracts/src/index';

const tournament = createEmptyTournament('osmaRef Invitational');

tournament.abbreviation = 'OI';
tournament.teams = [
  {
    id: 'team_one',
    name: 'Aster',
    members: [
      { userId: 1001, username: 'Aster', captain: true },
      { userId: 1002, username: 'Birch', captain: false },
    ],
  },
  {
    id: 'team_two',
    name: 'Cedar',
    members: [
      { userId: 1003, username: 'Cedar', captain: true },
      { userId: 1004, username: 'Dahlia', captain: false },
    ],
  },
];

tournament.referees = [{ userId: 9001, username: 'Referee' }];

const slot = (
  label: string,
  category: MappoolSlot['category'],
  beatmapId: number,
  requiredMods: string[] = [],
  freestyle = false,
): MappoolSlot => ({
  id: `slot_${label.toLowerCase()}`,
  label,
  category,
  beatmapId,
  rulesetId: 0,
  requiredMods,
  allowedMods: [],
  freestyle,
  winCondition: null,
  winConditionWinner: null,
});

tournament.rounds[0]!.slots = [
  slot('NM1', 'NM', 101),
  slot('NM2', 'NM', 102),
  slot('NM3', 'NM', 103),
  slot('HD1', 'HD', 104, ['HD']),
  slot('HR1', 'HR', 105, ['HR']),
  slot('DT1', 'DT', 106, ['DT']),
  slot('DT2', 'DT', 107, ['DT']),
  slot('FM1', 'FM', 108, [], true),
  slot('TB', 'TB', 109),
];

tournament.matches.push({
  id: 'match_grand_final',
  name: 'Aster vs Cedar',
  roundId: 'round_1',
  teamOneId: 'team_one',
  teamTwoId: 'team_two',
  refereeIds: [9001],
  transport: 'referee_hub',

  scoringId: 'score_default',
  roomNameTemplate: '{tournament}: ({team_one}) vs ({team_two})',
  initialBeatmapId: 101,
  scheduledAt: null,
});

tournament.automation.push({
  id: 'rule_score_line',
  name: 'Score line',
  trigger: 'beatmap_completed',
  slotLabel: null,
  actions: [
    {
      type: 'chat',
      template: '{{ team_one }} {{ score_one }} - {{ score_two }} {{ team_two }} ({{ slot }})',
    },
  ],
  enabled: true,
});

const parsed = parseTournament(tournament);
if (!parsed.success) {
  console.error(parsed.error.issues);
  process.exit(1);
}

const output = resolve(process.cwd(), 'examples/tournament.sample.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(parsed.data, null, 2), 'utf8');
console.log(`wrote ${output} with ${parsed.data.rounds[0]?.slots.length ?? 0} slots`);