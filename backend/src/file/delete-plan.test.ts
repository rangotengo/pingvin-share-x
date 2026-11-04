import assert from "node:assert/strict";
import test from "node:test";
import {
  isAlreadyGoneStatus,
  isMissingObject,
  isMissingObjectCode,
  isRecordMissing,
  shouldDeleteDbRow,
} from "./delete-plan.ts";

test("remote 404 and 410 are gone; auth and server errors are not", () => {
  assert.equal(isAlreadyGoneStatus(204), true);
  assert.equal(isAlreadyGoneStatus(200), true);
  assert.equal(isAlreadyGoneStatus(404), true);
  assert.equal(isAlreadyGoneStatus(410), true);
  assert.equal(isAlreadyGoneStatus(403), false);
  assert.equal(isAlreadyGoneStatus(401), false);
  assert.equal(isAlreadyGoneStatus(500), false);
});

test("missing object codes do not hide a real delete failure", () => {
  assert.equal(isMissingObjectCode("NoSuchKey"), true);
  assert.equal(isMissingObjectCode("NotFound"), true);
  assert.equal(isMissingObjectCode("AccessDenied"), false);
  assert.equal(isMissingObject({ name: "NoSuchKey" }), true);
  assert.equal(isMissingObject({ $metadata: { httpStatusCode: 404 } }), true);
  assert.equal(isMissingObject({ name: "AccessDenied" }), false);
  assert.equal(isRecordMissing({ code: "P2025" }), true);
  assert.equal(isRecordMissing({ code: "P2003" }), false);
});

test("db row is deleted once, and only after the remote object is gone", () => {
  assert.equal(shouldDeleteDbRow({ rowExists: true, remote: "gone" }), true);
  assert.equal(shouldDeleteDbRow({ rowExists: true, remote: "absent" }), true);
  assert.equal(shouldDeleteDbRow({ rowExists: true, remote: "failed" }), false);
  assert.equal(shouldDeleteDbRow({ rowExists: false, remote: "gone" }), false);
});
