import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidTimespanString,
  validateCandidateBatch,
} from "./config.protocol.ts";

test("isValidTimespanString validates format, integer numbers, and allowed units", () => {
  assert.equal(isValidTimespanString("5 minutes"), true);
  assert.equal(isValidTimespanString("1 hours"), true);
  assert.equal(isValidTimespanString("7 days"), true);
  assert.equal(isValidTimespanString("2 weeks"), true);
  assert.equal(isValidTimespanString("1 months"), true);
  assert.equal(isValidTimespanString("1 years"), true);
  assert.equal(isValidTimespanString("0 days"), true);

  // Negative allowed only when specified
  assert.equal(isValidTimespanString("-1 days", false), false);
  assert.equal(isValidTimespanString("-1 days", true), true);

  // Invalid formats
  assert.equal(isValidTimespanString("5"), false);
  assert.equal(isValidTimespanString("five minutes"), false);
  assert.equal(isValidTimespanString("5 parsecs"), false);
  assert.equal(isValidTimespanString(""), false);
  assert.equal(isValidTimespanString(null), false);
  assert.equal(isValidTimespanString(123), false);
});

test("candidate batch validation is strictly order-independent when both limits change", () => {
  const currentConfig = new Map<string, string | number | boolean | null>([
    ["share.maxExpiration", "0 days"],
    ["share.defaultExpiration", "7 days"],
    ["googledrive.enabled", false],
    ["s3.enabled", false],
  ]);

  // Order A: defaultExpiration first, maxExpiration second (invalid: 6m > 5m)
  const orderA = [
    { key: "share.defaultExpiration", value: "6 minutes" },
    { key: "share.maxExpiration", value: "5 minutes" },
  ];
  const resA = validateCandidateBatch(currentConfig, orderA);
  assert.equal(resA.valid, false);
  if (!resA.valid) {
    assert.equal(resA.messageKey, "config.defaultExpirationExceedsMax");
  }

  // Order B: maxExpiration first, defaultExpiration second (invalid: 6m > 5m)
  const orderB = [
    { key: "share.maxExpiration", value: "5 minutes" },
    { key: "share.defaultExpiration", value: "6 minutes" },
  ];
  const resB = validateCandidateBatch(currentConfig, orderB);
  assert.equal(resB.valid, false);
  if (!resB.valid) {
    assert.equal(resB.messageKey, "config.defaultExpirationExceedsMax");
  }

  // Valid batch in Order A (5m <= 6m)
  const validOrderA = [
    { key: "share.defaultExpiration", value: "5 minutes" },
    { key: "share.maxExpiration", value: "6 minutes" },
  ];
  assert.equal(validateCandidateBatch(currentConfig, validOrderA).valid, true);

  // Valid batch in Order B (5m <= 6m)
  const validOrderB = [
    { key: "share.maxExpiration", value: "6 minutes" },
    { key: "share.defaultExpiration", value: "5 minutes" },
  ];
  assert.equal(validateCandidateBatch(currentConfig, validOrderB).valid, true);
});

test("cross-unit duration comparisons handle minutes, hours, days properly", () => {
  const currentConfig = new Map<string, string | number | boolean | null>([
    ["share.maxExpiration", "1 hours"],
    ["share.defaultExpiration", "30 minutes"],
  ]);

  // 75 minutes exceeds 1 hour (60 min)
  const invalidMinutes = validateCandidateBatch(currentConfig, [
    { key: "share.defaultExpiration", value: "75 minutes" },
  ]);
  assert.equal(invalidMinutes.valid, false);

  // 45 minutes is within 1 hour
  const validMinutes = validateCandidateBatch(currentConfig, [
    { key: "share.defaultExpiration", value: "45 minutes" },
  ]);
  assert.equal(validMinutes.valid, true);

  // 30 hours exceeds 1 day
  const invalidHours = validateCandidateBatch(currentConfig, [
    { key: "share.maxExpiration", value: "1 days" },
    { key: "share.defaultExpiration", value: "30 hours" },
  ]);
  assert.equal(invalidHours.valid, false);
});

test("never / unlimited semantics: max=0 allows any default, but max>0 disallows default=0", () => {
  const unlimitedMax = new Map<string, string | number | boolean | null>([
    ["share.maxExpiration", "0 days"],
    ["share.defaultExpiration", "7 days"],
  ]);

  // When max is 0 (unlimited), default can be 0 days (never) or 100 years
  assert.equal(
    validateCandidateBatch(unlimitedMax, [
      { key: "share.defaultExpiration", value: "0 days" },
    ]).valid,
    true,
  );
  assert.equal(
    validateCandidateBatch(unlimitedMax, [
      { key: "share.defaultExpiration", value: "50 years" },
    ]).valid,
    true,
  );

  // When max is 5 days, default cannot be 0 days (never)
  const finiteMax = new Map<string, string | number | boolean | null>([
    ["share.maxExpiration", "5 days"],
    ["share.defaultExpiration", "3 days"],
  ]);
  const neverDefault = validateCandidateBatch(finiteMax, [
    { key: "share.defaultExpiration", value: "0 days" },
  ]);
  assert.equal(neverDefault.valid, false);
  if (!neverDefault.valid) {
    assert.equal(neverDefault.messageKey, "config.defaultExpirationExceedsMax");
  }
});

test("simultaneous Drive and S3 enablement is rejected", () => {
  const currentConfig = new Map<string, string | number | boolean | null>([
    ["googledrive.enabled", false],
    ["s3.enabled", false],
  ]);

  const bothEnabled = validateCandidateBatch(currentConfig, [
    { key: "googledrive.enabled", value: true },
    { key: "s3.enabled", value: true },
  ]);
  assert.equal(bothEnabled.valid, false);
  if (!bothEnabled.valid) {
    assert.equal(bothEnabled.messageKey, "config.driveAndS3");
  }
});
