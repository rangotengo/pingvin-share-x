const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { collectFiles } = require("./pingvin-mcp-local.js");

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
    assert.throws(() => collectFiles(["/path/that/does/not/exist"]), /Path does not exist/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
