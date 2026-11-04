import * as fs from "fs";

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Missing share dir is normal before the first local upload. Other FS errors stay thrown. */
export function staleTempChunkPaths(
  root: string,
  olderThanMs: number,
  now = Date.now(),
): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }

  const stale: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = `${root}/${entry.name}`;
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    for (const file of files) {
      if (!file.endsWith(".tmp-chunk")) continue;
      const path = `${dir}/${file}`;
      let stats: fs.Stats;
      try {
        stats = fs.statSync(path);
      } catch (error) {
        if (isEnoent(error)) continue;
        throw error;
      }
      if (now - stats.mtimeMs > olderThanMs) stale.push(path);
    }
  }
  return stale;
}
