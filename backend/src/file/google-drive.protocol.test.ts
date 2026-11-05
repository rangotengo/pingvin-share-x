import assert from "node:assert/strict";
import test from "node:test";
import {
  DRIVE_FLUSH,
  assertUploadSessionUrl,
  bytesFromRangeHeader,
  classifyChunk,
  contentRange,
  deletionTargets,
  connectErrorLog,
  connectReason,
  googleFailureReason,
  oauthCallbackAccepted,
  oauthCallbackReason,
  safeGoogleDetail,
  planSlices,
  publicDriveStatus,
  redactSecrets,
  selectNewShareProvider,
  usesBrowserRedirect,
} from "./google-drive.protocol.ts";

test("non-final slices stay 8MiB aligned and bounded", () => {
  const incoming = Buffer.alloc(10_000_000, 1);
  const planned = planSlices(Buffer.alloc(0), incoming, false);
  assert.equal(planned.slices.length, 1);
  assert.equal(planned.slices[0].body.length, DRIVE_FLUSH);
  assert.equal(planned.slices[0].final, false);
  assert.equal(planned.remainder.length, 10_000_000 - DRIVE_FLUSH);
  assert.ok(planned.remainder.length < DRIVE_FLUSH);
});

test("final slice may be short and closes the upload", () => {
  const pending = Buffer.alloc(100, 2);
  const planned = planSlices(pending, Buffer.alloc(50, 3), true);
  assert.equal(planned.slices.length, 1);
  assert.equal(planned.slices[0].final, true);
  assert.equal(planned.slices[0].body.length, 150);
  assert.equal(planned.remainder.length, 0);
  assert.equal(contentRange(8, 150, 158), "bytes 8-157/158");
  assert.equal(
    contentRange(0, DRIVE_FLUSH, null),
    `bytes 0-${DRIVE_FLUSH - 1}/*`,
  );
});

test("interrupted chunk is resumed, duplicate chunk is ignored", () => {
  const chunkSize = 10_000_000;
  assert.equal(
    classifyChunk({
      index: 0,
      chunkSize,
      byteLength: chunkSize,
      accepted: DRIVE_FLUSH,
    }),
    "process",
  );
  assert.equal(
    classifyChunk({
      index: 0,
      chunkSize,
      byteLength: chunkSize,
      accepted: chunkSize,
    }),
    "duplicate",
  );
  assert.equal(
    classifyChunk({ index: 2, chunkSize, byteLength: 10, accepted: 0 }),
    "unexpected",
  );
});

test("status and logs never carry secrets or session urls", () => {
  const secret = "super-secret-value";
  const status = publicDriveStatus({
    enabled: true,
    clientId: "client",
    clientSecret: secret,
    refreshToken: "refresh-secret",
    email: "admin@arunshrestha.info.np",
    folderId: "folder-id-123456",
    folderName: "Pingvin Share",
    redirectUri: "https://share.example/api/admin/google-drive/callback",
  });
  const encoded = JSON.stringify(status);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes("refresh-secret"), false);
  assert.equal(status.connected, true);
  assert.equal(
    redactSecrets(
      "Bearer ya29.token https://www.googleapis.com/upload/drive/v3/files?upload_id=abc upload_id=abc refresh_token=zzz",
    ).includes("ya29"),
    false,
  );
  assert.equal(bytesFromRangeHeader("bytes=0-262143"), 262144);
});

test("drive downloads are not redirected past Pingvin auth", () => {
  assert.equal(usesBrowserRedirect("S3"), true);
  assert.equal(usesBrowserRedirect("GOOGLE_DRIVE"), false);
  assert.equal(usesBrowserRedirect("LOCAL"), false);
});

test("only S3 redirects the browser", () => {
  assert.equal(usesBrowserRedirect("S3"), true);
  assert.equal(usesBrowserRedirect("GOOGLE_DRIVE"), false);
  assert.equal(usesBrowserRedirect("LOCAL"), false);
});

test("new shares pick one provider and refuse drive plus s3", () => {
  assert.equal(selectNewShareProvider(false, false), "LOCAL");
  assert.equal(selectNewShareProvider(false, true), "S3");
  assert.equal(selectNewShareProvider(true, false), "GOOGLE_DRIVE");
  assert.throws(() => selectNewShareProvider(true, true));
});

test("oauth callback names the reject reason and keeps secrets out of it", () => {
  const now = 1_000_000;
  const ok = {
    code: "auth-code",
    stateUserId: "admin-1",
    requestUserId: "admin-1",
    exp: now + 1,
    now,
  };
  assert.equal(oauthCallbackReason(ok), null);
  assert.equal(
    oauthCallbackReason({ ...ok, error: "access_denied" }),
    "access_denied",
  );
  assert.equal(oauthCallbackReason({ ...ok, error: "weird" }), "access_denied");
  assert.equal(oauthCallbackReason({ ...ok, code: "" }), "missing_code");
  assert.equal(
    oauthCallbackReason({ ...ok, stateUserId: undefined }),
    "state_missing",
  );
  assert.equal(oauthCallbackReason({ ...ok, exp: now - 1 }), "state_expired");
  assert.equal(
    oauthCallbackReason({ ...ok, requestUserId: "other" }),
    "state_mismatch",
  );
  assert.equal(connectReason("not-a-reason"), null);

  const mismatch = googleFailureReason(
    {
      error: "invalid_grant",
      error_description: "redirect_uri mismatch",
    },
    "token_exchange",
  );
  assert.equal(mismatch, "redirect_uri_mismatch");
  assert.equal(
    googleFailureReason(
      {
        error: {
          errors: [{ reason: "accessNotConfigured" }],
          message: "Drive API has not been used",
        },
      },
      "folder_failed",
    ),
    "access_not_configured",
  );
  const leaked = {
    error: "invalid_client",
    error_description: "client_secret=super-secret-value Bearer ya29.token",
  };
  assert.equal(safeGoogleDetail(leaked), "");
  assert.equal(
    safeGoogleDetail({ error_description: "The OAuth client was not found." }),
    "The OAuth client was not found.",
  );
  const leakedError = new Error("invalid_client") as Error & {
    detail?: string;
  };
  leakedError.detail = "client_secret=super-secret-value";
  assert.equal(connectErrorLog(leakedError), "invalid_client");
  const safeError = new Error("invalid_client") as Error & { detail?: string };
  safeError.detail = "The OAuth client was not found.";
  assert.equal(
    connectErrorLog(safeError),
    "invalid_client (The OAuth client was not found.)",
  );
});

test("oauth callback accepts only this admin's unexpired state", () => {
  const now = 1_000_000;
  const ok = {
    code: "auth-code",
    stateUserId: "admin-1",
    requestUserId: "admin-1",
    exp: now + 1,
    now,
  };
  assert.equal(oauthCallbackAccepted(ok), true);
  assert.equal(oauthCallbackAccepted({ ...ok, error: "access_denied" }), false);
  assert.equal(oauthCallbackAccepted({ ...ok, code: "" }), false);
  assert.equal(oauthCallbackAccepted({ ...ok, requestUserId: "other" }), false);
  assert.equal(oauthCallbackAccepted({ ...ok, exp: now - 1 }), false);
  assert.equal(oauthCallbackAccepted({ ...ok, stateUserId: undefined }), false);
});

test("cleanup deletes only stored drive file ids", () => {
  assert.deepEqual(
    deletionTargets([
      { providerFileId: "app-file-0001" },
      { providerFileId: null },
      { providerFileId: "app-file-0002" },
    ]),
    ["app-file-0001", "app-file-0002"],
  );
});

test("upload session url must be a Google upload endpoint", () => {
  assert.throws(() =>
    assertUploadSessionUrl("https://evil.example/upload/drive"),
  );
  assert.doesNotThrow(() =>
    assertUploadSessionUrl(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc",
    ),
  );
});

test("redaction strips token and session material", () => {
  const raw =
    "Bearer ya29.secret client_secret=client-secret refresh_token=refresh-secret https://www.googleapis.com/upload/drive/v3/files?upload_id=abc";
  const cleaned = redactSecrets(raw);
  assert.equal(cleaned.includes("ya29"), false);
  assert.equal(cleaned.includes("client-secret"), false);
  assert.equal(cleaned.includes("refresh-secret"), false);
  assert.equal(cleaned.includes("upload_id=abc"), false);
});
