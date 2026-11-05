import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";
import { staleTempChunkPaths } from "./temp-files.ts";

test("missing share directory is skipped, other errors are not", () => {
  const missing = path.join(os.tmpdir(), `pingvin-missing-${Date.now()}`);
  assert.deepEqual(staleTempChunkPaths(missing, 1), []);

  const file = path.join(os.tmpdir(), `pingvin-not-dir-${Date.now()}`);
  fs.writeFileSync(file, "x");
  try {
    assert.throws(
      () => staleTempChunkPaths(file, 1),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, "ENOTDIR");
        return true;
      },
    );
  } finally {
    fs.rmSync(file);
  }
});

test("only chunks older than the cutoff are listed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pingvin-shares-"));
  const share = path.join(root, "share-1");
  fs.mkdirSync(share);
  const oldChunk = path.join(share, "a.tmp-chunk");
  const newChunk = path.join(share, "b.tmp-chunk");
  const kept = path.join(share, "c.bin");
  fs.writeFileSync(oldChunk, "old");
  fs.writeFileSync(newChunk, "new");
  fs.writeFileSync(kept, "keep");
  const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
  fs.utimesSync(oldChunk, old / 1000, old / 1000);
  try {
    assert.deepEqual(staleTempChunkPaths(root, 24 * 60 * 60 * 1000), [
      oldChunk,
    ]);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
