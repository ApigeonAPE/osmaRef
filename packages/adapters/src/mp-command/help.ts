export type MpSupport = 'yes' | 'partial' | 'no';

export interface MpCompatibilityRow {
  command: string;
  support: MpSupport;
  note: string;
}

/**
 * The single source of truth shown in the UI. Kept next to the planner so a
 * new mapping cannot ship without updating the documentation.
 */
export const MP_COMPATIBILITY: MpCompatibilityRow[] = [
  { command: '!mp help', support: 'yes', note: 'show this list' },
  { command: '!mp make <name>', support: 'no', note: 'IRC only; create Referee Hub rooms from the create-room dialog' },
  { command: '!mp name <title>', support: 'yes', note: 'renames the room' },
  { command: '!mp invite <user>', support: 'yes', note: 'user must online' },
  { command: '!mp lock / unlock', support: 'yes', note: 'locks team and slot changes' },
  { command: '!mp size <n>', support: 'partial', note: 'unlimited(0) or 2-16' },
  { command: '!mp set <mode>', support: 'partial', note: 'only 0 (H2H) and 2 (Team VS); score mode unsupported' },
  { command: '!mp move <user> <slot>', support: 'yes', note: 'moves a user to a different slot' },
  { command: '!mp team <user> <red|blue>', support: 'yes', note: 'Team VS rooms only' },
  { command: '!mp map <id> [mode]', support: 'yes', note: 'edits the current playlist item' },
  { command: '!mp mods <mod...>', support: 'partial', note: 'Freemod uses the configured allowed-mod pool' },
  { command: '!mp settings', support: 'yes', note: 'renders the local authoritative snapshot' },
  { command: '!mp start [seconds]', support: 'yes', note: 'countdown controlled by the hub' },
  { command: '!mp abort', support: 'yes', note: 'abort the match, requires confirmation' },
  { command: '!mp aborttimer', support: 'partial', note: 'cancels the match start countdown only' },
  { command: '!mp kick <user>', support: 'yes', note: 'kicks a player' },
  { command: '!mp ban <user>', support: 'yes', note: 'bans a player' },
  { command: '!mp password [pw]', support: 'yes', note: 'no argument clears the password; values are redacted' },
  { command: '!mp addref / removeref', support: 'yes', note: 'the hub enforces host-only referee management' },
  { command: '!mp listrefs', support: 'yes', note: 'local snapshot' },
  { command: '!mp close', support: 'yes', note: 'close the lobby, requires confirmation' },
  { command: '!mp makeprivate', support: 'no', note: 'no hub equivalent for private match history' },
  { command: '!mp host / clearhost', support: 'no', note: 'no hub equivalent' },
  { command: '!mp timer [seconds]', support: 'no', note: 'general timer differs from the match start countdown' },
];

export const MP_HELP_TEXT = [
  'osmaRef local !mp compatibility',
  'Type !mp help in chat to print this list again.',
  ...MP_COMPATIBILITY.map((row) => `${row.command}  [${row.support}]  ${row.note}`),
].join('\n');