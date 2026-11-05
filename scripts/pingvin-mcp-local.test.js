const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  collectFiles,
  getStableFileId,
  parseToolResponse,
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  getFileFingerprint,
} = require("./pingvin-mcp-local.js");

test("collectFiles handles individual files and recursive directories", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pingvin-local-test-"));
  const file1 = path.join(tmpDir, "single.txt");
  fs.writeFileSync(file1, "Single file content");

  const subDir = path.join(tmpDir, "nested");
  fs.mkdirSync(subDir);
  const file2 = path.join(subDir, "inner.json");
  fs.writeFileSync(file2, JSON.stringify({ hello: "world" }));

  try {
    // Single file
    const res1 = collectFiles([file1]);
    assert.equal(res1.length, 1);
    assert.equal(res1[0].shareName, "single.txt");
    assert.equal(res1[0].size, 19);

    // Directory
    const res2 = collectFiles([tmpDir]);
    assert.equal(res2.length, 2);
    const names = res2.map((f) => f.shareName);
    assert.ok(names.some((n) => n.endsWith("single.txt")));
    assert.ok(names.some((n) => n.endsWith("inner.json")));

    // Non-existent path throws
    assert.throws(
      () => collectFiles(["/path/that/does/not/exist"]),
      /Path does not exist/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collectFiles ignores escaping symlinks pointing outside the target directory", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pingvin-symlink-test-"));
  const outsideFile = path.join(os.tmpdir(), "pingvin-outside-secret.txt");
  fs.writeFileSync(outsideFile, "SuperSecretExternalFile");

  const insideDir = path.join(tmpDir, "share-root");
  fs.mkdirSync(insideDir);
  const insideFile = path.join(insideDir, "valid.txt");
  fs.writeFileSync(insideFile, "Valid content");

  const escapingLink = path.join(insideDir, "link-outside.txt");
  try {
    fs.symlinkSync(outsideFile, escapingLink);
  } catch {
    // Symlinks may not be supported on all environments, skip if creation fails
    return;
  }

  try {
    const res = collectFiles([insideDir]);
    const fileNames = res.map((f) => f.shareName);
    assert.ok(fileNames.includes("share-root/valid.txt"));
    // Escaping symlink must NOT be included
    assert.equal(fileNames.includes("share-root/link-outside.txt"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try {
      fs.unlinkSync(outsideFile);
    } catch {}
  }
});

test("getStableFileId produces deterministic, valid UUIDs across retries", () => {
  const id1 = getStableFileId("share123", "docs/file.pdf", 4096);
  const id2 = getStableFileId("share123", "docs/file.pdf", 4096);
  const idDifferentShare = getStableFileId("share456", "docs/file.pdf", 4096);

  assert.equal(id1, id2);
  assert.notEqual(id1, idDifferentShare);
  assert.match(
    id1,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test("parseToolResponse validates tool results and errors safely", () => {
  // Successful response
  const goodRes = {
    result: {
      content: [{ type: "text", text: '{"success":true}' }],
    },
  };
  assert.equal(parseToolResponse(goodRes, "tool"), '{"success":true}');

  // Error response
  const errorRes = {
    result: {
      isError: true,
      content: [{ type: "text", text: "Something went wrong" }],
    },
  };
  assert.throws(
    () => parseToolResponse(errorRes, "tool"),
    /tool failed: Something went wrong/,
  );

  // Missing result
  assert.throws(
    () => parseToolResponse(null, "tool"),
    /tool returned empty or invalid response/,
  );
});

test("checkpoint persists nonsecret state with safe 0600 permissions and survives reload", () => {
  const tmpCheckpoints = fs.mkdtempSync(
    path.join(os.tmpdir(), "pingvin-ckpt-test-"),
  );
  process.env.PINGVIN_CHECKPOINT_DIR = tmpCheckpoints;

  try {
    const testFile = path.join(tmpCheckpoints, "test.txt");
    fs.writeFileSync(testFile, "Hello checkpoint world");
    const fp = getFileFingerprint(testFile);

    const files = [
      {
        absolutePath: testFile,
        shareName: "test.txt",
        size: fp.size,
        mtimeMs: fp.mtimeMs,
        headHash: fp.headHash,
        fileId: "00000000-0000-4000-8000-000000000001",
      },
    ];

    const serverUrl = "https://share.example.com";
    const shareId = "share_test_123";

    saveCheckpoint(serverUrl, files, shareId, {
      "test.txt": { lastConfirmedChunk: 2 },
    });

    const loaded = loadCheckpoint(serverUrl, files);
    assert.ok(loaded);
    assert.equal(loaded.shareId, shareId);
    assert.equal(loaded.serverUrl, serverUrl);
    assert.equal(loaded.files[0].lastConfirmedChunk, 2);

    // Verify no secret tokens are stored
    const rawContent = JSON.stringify(loaded);
    assert.equal(rawContent.includes("token"), false);
    assert.equal(rawContent.includes("psa_"), false);
    assert.equal(rawContent.includes("password"), false);

    // Verify file permission is 0600
    const key = require("node:crypto")
      .createHash("sha256")
      .update(`${serverUrl}::test.txt:${fp.size}:${fp.mtimeMs}`)
      .digest("hex");
    const ckptFile = path.join(tmpCheckpoints, `${key}.json`);
    const stat = fs.statSync(ckptFile);
    assert.equal(stat.mode & 0o777, 0o600);

    // Clear checkpoint
    clearCheckpoint(serverUrl, files);
    assert.equal(loadCheckpoint(serverUrl, files), null);
  } finally {
    delete process.env.PINGVIN_CHECKPOINT_DIR;
    fs.rmSync(tmpCheckpoints, { recursive: true, force: true });
  }
});

test("file fingerprint detects mid-upload file modifications", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pingvin-mod-test-"));
  const testFile = path.join(tmpDir, "changing.txt");
  fs.writeFileSync(testFile, "Initial content 12345");

  try {
    const fp1 = getFileFingerprint(testFile);
    assert.equal(fp1.size, 21);

    // Modify file
    fs.writeFileSync(testFile, "Changed content ABCDEFG 999");
    const fp2 = getFileFingerprint(testFile);

    assert.notEqual(fp1.size, fp2.size);
    assert.notEqual(fp1.headHash, fp2.headHash);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
