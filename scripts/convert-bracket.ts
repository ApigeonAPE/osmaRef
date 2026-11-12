import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { convertBracketToTournament, parseTournament } from '../packages/contracts/src/index';

/**
 * Converts an osu! tournament client bracket into an osmaRef tournament JSON.
 *
 * Usage: npm run convert:bracket -- [bracket.json] [output.json]
 */
const inputPath = resolve(process.cwd(), process.argv[2] ?? 'bracket.json');
const outputPath = resolve(
  process.cwd(),
  process.argv[3] ?? 'examples/tournament.from-bracket.json',
);

const raw = JSON.parse(readFileSync(inputPath, 'utf8')) as unknown;
const { tournament, notes } = convertBracketToTournament(raw, {
  name: basename(inputPath, '.json'),
});
const parsed = parseTournament(tournament);
if (!parsed.success) {
  console.error(parsed.error.issues);
  process.exit(1);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(parsed.data, null, 2), 'utf8');
for (const note of notes) console.warn(`note: ${note}`);
console.log(
  `wrote ${outputPath}: ${parsed.data.teams.length} teams, ` +
    `${parsed.data.rounds.length} rounds, ${parsed.data.matches.length} matches`,
);
