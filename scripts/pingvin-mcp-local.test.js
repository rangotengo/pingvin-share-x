const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  collectFiles,
  getStableFileId,
  parseToolResponse,
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
