import { net, protocol } from 'electron';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const COVER_SCHEME = 'osmaref-cover';

const COVER_TIMEOUT_MS = 10_000;
const MAX_COVER_BYTES = 4 * 1024 * 1024;
// Tournament ids and beatmap ids end up in a URL and in file names, so both are
// validated before anything touches the file system.
const TOURNAMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const FILE_PATTERN = /^(\d+)\.(jpg|png|webp|gif)$/;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

export interface CoverSource {
  beatmapId: number;
  coverUrl: string;
}

/**
 * Stores beatmap cover thumbnails per tournament so a deleted tournament takes
 * its covers with it. A cover is only downloaded when that beatmap id has no
 * saved file yet, which makes the download follow the mappool slot: changing the
 * slot's beatmap id produces a new file, keeping the id reuses the saved one.
 */
export class CoverCache {
  constructor(private readonly root: string) {}

  register(): void {
    protocol.handle(COVER_SCHEME, async (request) => {
      const segments = new URL(request.url).pathname.split('/');
      const tournamentId = segments[1] ?? '';
      const file = segments[2] ?? '';
      if (!TOURNAMENT_ID_PATTERN.test(tournamentId) || !FILE_PATTERN.test(file)) {
        return new Response(null, { status: 400 });
      }
      const extension = file.split('.').pop() ?? '';
      try {
        const data = await readFile(join(this.root, tournamentId, file));
        return new Response(new Uint8Array(data), {
          headers: {
            'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
            'cache-control': 'public, max-age=31536000, immutable',
          },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
  }

  /** Returns a map of beatmap id to local cover URL for the ones on disk. */
  async ensure(tournamentId: string, entries: CoverSource[]): Promise<Map<number, string>> {
    const local = new Map<number, string>();
    if (!TOURNAMENT_ID_PATTERN.test(tournamentId)) return local;
    const saved = await this.savedFiles(tournamentId);
    await Promise.all(
      entries.map(async (entry) => {
        if (!Number.isSafeInteger(entry.beatmapId) || entry.beatmapId <= 0) return;
        const existing = saved.get(entry.beatmapId);
        if (existing) {
          local.set(entry.beatmapId, this.localUrl(tournamentId, existing));
          return;
        }
        if (!/^https?:\/\//i.test(entry.coverUrl)) return;
        const file = await this.download(tournamentId, entry).catch(() => null);
        if (file) local.set(entry.beatmapId, this.localUrl(tournamentId, file));
      }),
    );
    return local;
  }

  async remove(tournamentId: string): Promise<void> {
    if (!TOURNAMENT_ID_PATTERN.test(tournamentId)) return;
    await rm(join(this.root, tournamentId), { recursive: true, force: true });
  }

  private async savedFiles(tournamentId: string): Promise<Map<number, string>> {
    const files = new Map<number, string>();
    let names: string[] = [];
    try {
      names = await readdir(join(this.root, tournamentId));
    } catch {
      return files;
    }
    for (const name of names) {
      const match = FILE_PATTERN.exec(name);
      if (match?.[1]) files.set(Number(match[1]), name);
    }
    return files;
  }

  private async download(tournamentId: string, entry: CoverSource): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COVER_TIMEOUT_MS);
    try {
      const response = await net.fetch(entry.coverUrl, { signal: controller.signal });
      if (!response.ok) return null;
      const type = (response.headers.get('content-type') ?? '')
        .split(';')[0]!
        .trim()
        .toLowerCase();
      const extension = EXTENSIONS[type];
      if (!extension) return null;
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > MAX_COVER_BYTES) return null;
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.byteLength === 0 || data.byteLength > MAX_COVER_BYTES) return null;
      const directory = join(this.root, tournamentId);
      await mkdir(directory, { recursive: true });
      const file = `${entry.beatmapId}${extension}`;
      const temporary = `${file}.tmp`;
      await writeFile(join(directory, temporary), data);
      await rename(join(directory, temporary), join(directory, file));
      return file;
    } finally {
      clearTimeout(timer);
    }
  }

  private localUrl(tournamentId: string, file: string): string {
    return `${COVER_SCHEME}://cover/${tournamentId}/${file}`;
  }
}
