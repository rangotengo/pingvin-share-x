import assert from "node:assert/strict";
import test from "node:test";
import { editFinishAction } from "./shareEdit.util.ts";

test("deleting the last file deletes the share instead of finishing it", () => {
  assert.equal(editFinishAction(0, 0), "delete-share");
  assert.equal(editFinishAction(1, 0), "complete");
  assert.equal(editFinishAction(0, 1), "complete");
  assert.equal(editFinishAction(2, 1), "complete");
});
