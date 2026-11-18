import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  BUILTIN_WIN_BY_RULE,
  BUILTIN_WIN_BY_RULE_ID,
  WinByRuleSchema,
  parseWinByDirectives,
  type WinByRule,
} from '@osmaref/contracts';
import { compileWinBySource } from './winby';

interface WinByFile {
  version: 1;
  rules: WinByRule[];
}

export class WinByStore {
  private readonly file: string;
  private rules: WinByRule[] = [];

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'win-by-rules.json');
    this.load();
  }

  list(): WinByRule[] {
    return [BUILTIN_WIN_BY_RULE, ...this.rules];
  }

  get(id: string): WinByRule | null {
    if (id === BUILTIN_WIN_BY_RULE_ID) return BUILTIN_WIN_BY_RULE;
    return this.rules.find((rule) => rule.id === id) ?? null;
  }

  add(source: string): WinByRule {
    const directives = parseWinByDirectives(source);
    if (!directives) {
      throw new Error(
        'Win-by rule must start with "// @name <name>" and "// @scoreboard <enable|disable>"',
      );
    }
    compileWinBySource(source);
    const timestamp = new Date().toISOString();
    const rule = WinByRuleSchema.parse({
      id: `winby_${randomUUID()}`,
      name: directives.name,
      scoreboard: directives.scoreboard,
      source,
      builtIn: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.rules.push(rule);
    this.persist();
    return rule;
  }

  remove(id: string): void {
    if (id === BUILTIN_WIN_BY_RULE_ID) {
      throw new Error('the built-in Win-by rule cannot be removed');
    }
    const before = this.rules.length;
    this.rules = this.rules.filter((rule) => rule.id !== id);
    if (this.rules.length === before) throw new Error('Win-by rule not found');
    this.persist();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<WinByFile>;
      if (!Array.isArray(parsed.rules)) return;
      this.rules = parsed.rules.flatMap((value) => {
        const result = WinByRuleSchema.safeParse(value);
        if (!result.success || result.data.builtIn) return [];
        return [result.data];
      });
    } catch {
      this.rules = [];
    }
  }

  private persist(): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    const payload: WinByFile = { version: 1, rules: this.rules };
    writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(temporary, this.file);
  }
}
