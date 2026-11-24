import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, type BrowserWindow } from 'electron';

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const DEFAULT_STATE: WindowState = { width: 1440, height: 900, maximized: false };
const MIN_WIDTH = 1280;
const MIN_HEIGHT = 720;
const SAVE_DELAY_MS = 500;

function isDimension(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min;
}

/**
 * Remembers the main window's normal bounds and maximized state across runs.
 * Kept in its own file instead of settings: it changes on every drag and should
 * not churn the user-editable settings document.
 */
export class WindowStateStore {
  private readonly file: string;
  private state: WindowState;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, 'window-state.json');
    this.state = this.load();
  }

  /** Bounds for the BrowserWindow, dropping coordinates that are off every display. */
  options(): { x?: number; y?: number; width: number; height: number } {
    const { workArea } = screen.getPrimaryDisplay();
    const width = Math.min(Math.max(this.state.width, MIN_WIDTH), workArea.width);
    const height = Math.min(Math.max(this.state.height, MIN_HEIGHT), workArea.height);
    const x = this.state.x;
    const y = this.state.y;
    if (x !== undefined && y !== undefined) {
      const visible = screen.getAllDisplays().some(({ workArea }) => {
        return (
          x < workArea.x + workArea.width &&
          x + width > workArea.x &&
          y < workArea.y + workArea.height &&
          y + height > workArea.y
        );
      });
      if (visible) return { x, y, width, height };
    }
    return { width, height };
  }

  isMaximized(): boolean {
    return this.state.maximized;
  }

  track(window: BrowserWindow): void {
    const capture = () => this.capture(window);
    window.on('resize', capture);
    window.on('move', capture);
    window.on('maximize', capture);
    window.on('unmaximize', capture);
    window.on('close', () => {
      this.capture(window);
      this.flush();
    });
  }

  private capture(window: BrowserWindow): void {
    const { x, y, width, height } = window.getNormalBounds();
    this.state = { x, y, width, height, maximized: window.isMaximized() };
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8');
    renameSync(temporary, this.file);
  }

  private load(): WindowState {
    if (!existsSync(this.file)) return { ...DEFAULT_STATE };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<WindowState>;
      return {
        x: typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? parsed.x : undefined,
        y: typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : undefined,
        width: isDimension(parsed.width, MIN_WIDTH) ? Math.round(parsed.width) : DEFAULT_STATE.width,
        height: isDimension(parsed.height, MIN_HEIGHT)
          ? Math.round(parsed.height)
          : DEFAULT_STATE.height,
        maximized: parsed.maximized === true,
      };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }
}
