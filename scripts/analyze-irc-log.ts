import { readFileSync } from 'node:fs';
import { parseBanchoLine } from '../packages/adapters/src/irc/bancho';

/**
 * Reports which BanchoBot lines a captured osu! multiplayer log contains and
 * which of them the parser does not recognise yet.
 *
 * Usage: npm run analyze:irc -- "C:\\path\\to\\#mp_123.messages.ndjson"
 */

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run analyze:irc -- <path to .messages.ndjson>');
  process.exit(1);
}

const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
const unrecognized = new Map<string, { count: number; sample: string }>();
let parsed = 0;
let messages = 0;

function normalize(text: string): string {
  return text
    .replace(/https:\/\/osu\.ppy\.sh\/u\/\d+/g, '<user-url>')
    .replace(/https:\/\/osu\.ppy\.sh\/b\/\d+/g, '<beatmap-url>')
    .replace(/https:\/\/osu\.ppy\.sh\/mp\/\d+/g, '<mp-url>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\[Team (Red|Blue)\s*(\/[^\]]*)?\]/g, '[<team>]')
    .replace(
      /^(.+?) (finished playing|joined in slot|moved to slot|changed to|left the game|rolls) /,
      '<player> $2 ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

for (const line of lines) {
  let entry: {
    type?: string;
    content?: {
      author?: string;
      messageBuilder?: { message?: string }[];
    };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  if (entry.type !== 'message') continue;
  if (entry.content?.author !== 'BanchoBot') continue;
  const parts = entry.content.messageBuilder ?? [];
  const text = parts.map((part) => part.message ?? '').join('').trim();
  if (!text) continue;
  messages += 1;

  if (parseBanchoLine(text)) {
    parsed += 1;
    continue;
  }
  const template = normalize(text);
  const record = unrecognized.get(template) ?? { count: 0, sample: text };
  record.count += 1;
  unrecognized.set(template, record);
}

console.log(`BanchoBot messages: ${messages}`);
console.log(`recognised: ${parsed}`);
console.log(`unrecognised templates: ${unrecognized.size}`);
for (const [template, record] of [...unrecognized.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`\n[${record.count}] ${template}`);
  console.log(`    sample: ${record.sample}`);
}