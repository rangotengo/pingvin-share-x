import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  PendingUploadsTracker,
  SessionTracker,
  buildPingvinMcpServer,
  extractBearerToken,
  isInitializeRequest,
  validateOriginHeader,
} from "./mcp.protocol.ts";

test("extractBearerToken strictly enforces Authorization header and rejects query tokens", () => {
  // 1. Valid Bearer headers accepted
  assert.equal(
    extractBearerToken("Bearer psa_validtoken1234567890abcdef"),
    "psa_validtoken1234567890abcdef",
  );
  assert.equal(
    extractBearerToken("bearer psa_lowercase_prefix"),
    "psa_lowercase_prefix",
  );

  // 2. Query token or missing/invalid schemes return null
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken(""), null);
  assert.equal(extractBearerToken("Basic dXNlcjpwYXNz"), null);
  assert.equal(extractBearerToken("Token 12345"), null);
});

test("validateOriginHeader blocks cross-origin browser access while allowing companion and valid origins", () => {
  const appUrl = "https://share.arunshrestha.info.np";

  // Non-browser clients (no Origin header) -> allowed
  assert.equal(validateOriginHeader(undefined, appUrl), true);
  assert.equal(validateOriginHeader("", appUrl), true);

  // Matching server origin -> allowed
  assert.equal(
    validateOriginHeader("https://share.arunshrestha.info.np", appUrl),
    true,
  );

  // Local companion and loopback origins -> allowed
  assert.equal(validateOriginHeader("http://localhost:3000", appUrl), true);
  assert.equal(validateOriginHeader("http://127.0.0.1:8080", appUrl), true);

  // External / malicious origin -> strictly blocked
  assert.equal(
    validateOriginHeader("https://evil-hacker.com", appUrl),
    false,
  );
  assert.equal(
    validateOriginHeader("https://phishing-pingvin.info", appUrl),
    false,
  );
  assert.equal(validateOriginHeader("not-a-valid-url", appUrl), false);
});

test("isInitializeRequest identifies initialize JSON-RPC messages and rejects non-initialize calls", () => {
  assert.equal(isInitializeRequest({ method: "initialize" }), true);
  assert.equal(isInitializeRequest([{ method: "initialize" }]), true);
  assert.equal(
    isInitializeRequest({
      method: "tools/call",
      params: { name: "pingvin_create_share" },
    }),
    false,
  );
  assert.equal(isInitializeRequest({ method: "tools/list" }), false);
  assert.equal(isInitializeRequest(null), false);
  assert.equal(isInitializeRequest({}), false);
});

test("SessionTracker enforces per-user bounds, eviction of oldest session, and idle cleanup", () => {
  let closedSessions: string[] = [];
  const tracker = new SessionTracker<{
    userId: string;
    lastActive: number;
    close: () => void;
  }>(3, 10, 5000); // max 3 per user, max 10 total, 5s timeout

  const makeSession = (userId: string, id: string) => ({
    userId,
    lastActive: Date.now(),
    close: () => closedSessions.push(id),
  });

  // Add 3 sessions for user-1
  tracker.set("s1", makeSession("user-1", "s1"));
  tracker.set("s2", makeSession("user-1", "s2"));
  tracker.set("s3", makeSession("user-1", "s3"));
  assert.equal(tracker.size, 3);

  // 4th session for user-1 evicts oldest session ('s1')
  tracker.set("s4", makeSession("user-1", "s4"));
  assert.equal(tracker.size, 3);
  assert.equal(tracker.get("s1"), undefined);
  assert.ok(closedSessions.includes("s1"));

  // Idle timeout cleanup
  const idle = makeSession("user-idle", "s-idle");
  idle.lastActive = Date.now() - 10000;
  tracker.set("s-idle", idle);
  tracker.cleanupExpired();
  assert.equal(tracker.get("s-idle"), undefined);
  assert.ok(closedSessions.includes("s-idle"));
});

test("PendingUploadsTracker tracks chunks, detects partial uploads, and removes completed files", () => {
  const tracker = new PendingUploadsTracker();
  const shareId = "share-tracker-1";

  // File A: 1/1 chunks -> complete immediately
  const resA = tracker.trackChunk(shareId, "fileA", "fileA.txt", 0, 1);
  assert.equal(resA.isComplete, true);
  assert.equal(tracker.hasPendingFiles(shareId).hasPending, false);

  // File B: 2 chunks. Upload chunk 0 only -> partial
  const resB1 = tracker.trackChunk(shareId, "fileB", "fileB.txt", 0, 2);
  assert.equal(resB1.isComplete, false);

  const pending = tracker.hasPendingFiles(shareId);
  assert.equal(pending.hasPending, true);
  assert.equal(pending.fileName, "fileB.txt");
  assert.equal(pending.received, 1);
  assert.equal(pending.total, 2);

  // Upload chunk 1 of 2 -> complete
  const resB2 = tracker.trackChunk(shareId, "fileB", "fileB.txt", 1, 2);
  assert.equal(resB2.isComplete, true);
  assert.equal(tracker.hasPendingFiles(shareId).hasPending, false);
});

test("McpServer rejects completion when File A is complete but File B is partial, plus restart-safe check", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pingvin-mcp-integration-"));
  const shareId = "test-share-abc";
  const shareDir = path.join(tmpDir, shareId);
  fs.mkdirSync(shareDir, { recursive: true });

  const tracker = new PendingUploadsTracker();
  const dbFiles: Array<{ id: string; name: string; size: string }> = [];

  const deps = {
    getCurrentUser: () => ({ id: "u1", allowShare: true }),
    getAppUrl: () => "https://share.arunshrestha.info.np",
    getChunkSize: () => 52428800,
    getShareIdLength: () => 16,
    getDefaultExpiration: () => "7 days",
    getMaxShareSize: () => 1000000000,
    createShare: async (p: any) => ({
      id: p.id,
      storageProvider: "LOCAL",
      expiration: new Date(),
    }),
    uploadChunk: async (p: any) => {
      tracker.trackChunk(p.shareId, p.fileId, p.name, p.chunkIndex, p.totalChunks);
      if (p.chunkIndex === p.totalChunks - 1) {
        dbFiles.push({ id: p.fileId, name: p.name, size: "123" });
      }
      return { id: p.fileId, name: p.name };
    },
    completeShare: async (sId: string) => {
      const pending = tracker.hasPendingFiles(sId);
      if (pending.hasPending) {
        throw new Error(
          `Cannot complete share: upload for file '${pending.fileName}' is incomplete (${pending.received}/${pending.total} chunks)`,
        );
      }
      // Restart-safe storage check: check if any .tmp-chunk exists on disk
      if (fs.existsSync(shareDir)) {
        const files = fs.readdirSync(shareDir);
        if (files.some((f) => f.endsWith(".tmp-chunk"))) {
          throw new Error("Cannot complete share: pending file chunk uploads are still in progress");
        }
      }
      if (dbFiles.length === 0) {
        throw new Error("Cannot complete a share without any uploaded files");
      }
      return {
        id: sId,
        expiration: new Date(),
        hasPassword: false,
        maxViews: null,
        files: dbFiles,
      };
    },
    getShareStatus: async () => null,
    cancelShare: async () => {},
  };

  const server = buildPingvinMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "int-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  // Upload File A (1/1 chunks - complete)
  const fileAId = crypto.randomUUID();
  await client.callTool({
    name: "pingvin_upload_chunk",
    arguments: {
      shareId,
      name: "fileA.txt",
      fileId: fileAId,
      chunkIndex: 0,
      totalChunks: 1,
      dataBase64: Buffer.from("File A").toString("base64"),
    },
  });

  // Upload File B chunk 0 of 2 (PARTIAL)
  const fileBId = crypto.randomUUID();
  await client.callTool({
    name: "pingvin_upload_chunk",
    arguments: {
      shareId,
      name: "fileB.txt",
      fileId: fileBId,
      chunkIndex: 0,
      totalChunks: 2,
      dataBase64: Buffer.from("File B Part 1").toString("base64"),
    },
  });

  // Attempting to complete the share MUST BE REJECTED
  const partialRes: any = await client.callTool({
    name: "pingvin_complete_share",
    arguments: { shareId },
  });
  assert.equal(partialRes.isError, true);
  assert.match(partialRes.content[0].text, /file 'fileB.txt' is incomplete/);

  // Complete File B chunk 1 of 2
  await client.callTool({
    name: "pingvin_upload_chunk",
    arguments: {
      shareId,
      name: "fileB.txt",
      fileId: fileBId,
      chunkIndex: 1,
      totalChunks: 2,
      dataBase64: Buffer.from("File B Part 2").toString("base64"),
    },
  });

  // Completion now succeeds
  const successRes: any = await client.callTool({
    name: "pingvin_complete_share",
    arguments: { shareId },
  });
  assert.equal(successRes.isError, undefined);
  const parsed = JSON.parse(successRes.content[0].text);
  assert.equal(parsed.success, true);
  assert.equal(parsed.filesCount, 2);

  // Restart-safe disk check: if .tmp-chunk left behind, completion is blocked
  fs.writeFileSync(path.join(shareDir, "stranded.tmp-chunk"), "orphan-data");
  const strandedRes: any = await client.callTool({
    name: "pingvin_complete_share",
    arguments: { shareId },
  });
  assert.equal(strandedRes.isError, true);
  assert.match(strandedRes.content[0].text, /pending file chunk uploads are still in progress/);

  await client.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
