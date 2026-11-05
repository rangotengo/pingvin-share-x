import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AGENT_TOKEN_PREFIX,
  buildPingvinMcpServer,
  generateAgentToken,
  hashAgentToken,
  isStrictBase64,
  normalizeExpirationInput,
  sanitizeRelativePath,
  verifyAgentTokenFormat,
} from "./mcp.protocol.ts";

test("sanitizeRelativePath rejects traversal and absolute paths rather than collapsing", () => {
  assert.equal(sanitizeRelativePath("simple.txt"), "simple.txt");
  assert.equal(
    sanitizeRelativePath("folder/sub/file.pdf"),
    "folder/sub/file.pdf",
  );
  assert.equal(
    sanitizeRelativePath("folder\\sub\\file.pdf"),
    "folder/sub/file.pdf",
  );
  assert.throws(
    () => sanitizeRelativePath("../../../etc/passwd"),
    /directory traversal/,
  );
  assert.throws(
    () => sanitizeRelativePath("/root/file.txt"),
    /absolute paths/,
  );
  assert.throws(
    () => sanitizeRelativePath("C:\\Windows\\system32"),
    /absolute paths/,
  );
  assert.throws(
    () => sanitizeRelativePath("././file.txt"),
    /directory traversal/,
  );
  assert.throws(
    () => sanitizeRelativePath("a/../../b/c.txt"),
    /directory traversal/,
  );
  assert.throws(() => sanitizeRelativePath(""), /file name cannot be empty/);
  assert.throws(() => sanitizeRelativePath("foo\0bar.txt"), /null bytes/);
});

test("isStrictBase64 validates canonical base64 and rejects invalid characters and padding", () => {
  assert.equal(
    isStrictBase64(Buffer.from("Hello world").toString("base64")),
    true,
  );
  assert.equal(isStrictBase64(""), true);
  assert.equal(isStrictBase64("not!base64!"), false);
  assert.equal(isStrictBase64("abc"), false); // length not multiple of 4
  assert.equal(isStrictBase64("===a"), false); // bad padding
});

test("normalizeExpirationInput parses shorthand, relative, and ISO strings", () => {
  assert.equal(normalizeExpirationInput(undefined), "7-days");
  assert.equal(normalizeExpirationInput("never"), "never");
  assert.equal(normalizeExpirationInput("1d"), "1-days");
  assert.equal(normalizeExpirationInput("7 days"), "7-days");
  assert.equal(normalizeExpirationInput("24h"), "24-hours");
  assert.equal(normalizeExpirationInput("30m"), "30-minutes");
  assert.equal(normalizeExpirationInput("2w"), "2-weeks");
  assert.equal(
    normalizeExpirationInput("2026-12-31T23:59:59.000Z"),
    "2026-12-31T23:59:59.000Z",
  );
});

test("Agent token generation and format validation", () => {
  const token = generateAgentToken();
  assert.ok(token.rawToken.startsWith(AGENT_TOKEN_PREFIX));
  assert.equal(token.rawToken.length, 68);
  assert.ok(token.tokenPrefix.startsWith(AGENT_TOKEN_PREFIX));
  assert.equal(token.tokenPrefix.length, 15); // "psa_12345678..."
  assert.equal(token.tokenHash, hashAgentToken(token.rawToken));
  assert.ok(verifyAgentTokenFormat(token.rawToken));
  assert.equal(verifyAgentTokenFormat("psa_short"), false);
  assert.equal(verifyAgentTokenFormat("random_token_123"), false);
  assert.equal(verifyAgentTokenFormat(""), false);
});

test("McpServer tools register and execute full chunked upload and share lifecycle", async () => {
  const shares = new Map<string, any>();
  const files = new Map<string, any[]>();
  const fileBuffers = new Map<string, Buffer>();
  const pendingFiles = new Map<string, Map<string, { total: number; chunks: Set<number> }>>();

  let currentUserState = {
    id: "agent-user-1",
    username: "agent-alice",
    allowShare: true,
    shareSizeLimit: "100000000",
  };

  const deps = {
    getCurrentUser: () => currentUserState,
    getAppUrl: () => "https://share.arunshrestha.info.np",
    getChunkSize: () => 5000000,
    getShareIdLength: () => 10,
    getDefaultExpiration: () => "7 days",
    getMaxShareSize: () => 1000000000,
    createShare: async (params: any) => {
      const share = {
        id: params.id,
        name: params.name,
        storageProvider: "LOCAL",
        expiration: new Date(Date.now() + 7 * 86400 * 1000),
        uploadLocked: false,
        password: params.password,
        maxViews: params.maxViews,
      };
      shares.set(params.id, share);
      files.set(params.id, []);
      return share;
    },
    uploadChunk: async (params: any) => {
      let sharePending = pendingFiles.get(params.shareId);
      if (!sharePending) {
        sharePending = new Map();
        pendingFiles.set(params.shareId, sharePending);
      }
      let filePending = sharePending.get(params.fileId);
      if (!filePending) {
        filePending = { total: params.totalChunks, chunks: new Set() };
        sharePending.set(params.fileId, filePending);
      }
      filePending.chunks.add(params.chunkIndex);

      const key = `${params.shareId}:${params.fileId}`;
      const existing = fileBuffers.get(key) || Buffer.alloc(0);
      const combined = Buffer.concat([existing, params.data]);
      fileBuffers.set(key, combined);

      if (params.chunkIndex === params.totalChunks - 1 && filePending.chunks.size >= params.totalChunks) {
        const shareFiles = files.get(params.shareId) || [];
        shareFiles.push({
          id: params.fileId,
          name: params.name,
          size: combined.length.toString(),
        });
        files.set(params.shareId, shareFiles);
        sharePending.delete(params.fileId);
      }
      return { id: params.fileId, name: params.name };
    },
    completeShare: async (shareId: string) => {
      const share = shares.get(shareId);
      if (!share) throw new Error("Share not found");
      const sharePending = pendingFiles.get(shareId);
      if (sharePending && sharePending.size > 0) {
        throw new Error("Cannot complete share: pending file chunks are still being uploaded");
      }
      const shareFiles = files.get(shareId) || [];
      if (shareFiles.length === 0) {
        throw new Error("Cannot complete a share without any uploaded files");
      }
      share.uploadLocked = true;
      return {
        id: share.id,
        expiration: share.expiration,
        hasPassword: !!share.password,
        maxViews: share.maxViews,
        files: shareFiles,
      };
    },
    getShareStatus: async (shareId: string) => {
      const share = shares.get(shareId);
      if (!share) return null;
      return {
        id: share.id,
        name: share.name,
        uploadLocked: share.uploadLocked,
        files: files.get(shareId) || [],
      };
    },
    cancelShare: async (shareId: string) => {
      shares.delete(shareId);
      files.delete(shareId);
      pendingFiles.delete(shareId);
    },
    listShares: async (params) => {
      const all = Array.from(shares.values()).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        createdAt: s.createdAt,
        expiration: s.expiration,
        isExpired: s.expiration.getTime() !== 0 && s.expiration.getTime() < Date.now(),
        uploadLocked: s.uploadLocked,
        views: 0,
        filesCount: (files.get(s.id) || []).length,
        totalBytes: 100,
        hasPassword: !!s.password,
        maxViews: s.maxViews,
        url: `https://share.example.com/share/${s.id}`,
      }));
      let filtered = all;
      if (params.query) {
        filtered = filtered.filter((s) => s.name?.includes(params.query!));
      }
      return { shares: filtered, nextCursor: null, total: filtered.length };
    },
    updateShare: async (params) => {
      const share = shares.get(params.shareId);
      if (!share) throw new Error("Share not found");
      if (params.name) share.name = params.name;
      return {
        id: share.id,
        name: share.name,
        description: share.description,
        expiration: share.expiration,
        hasPassword: !!share.password,
        maxViews: share.maxViews,
      };
    },
    revokeShare: async (shareId: string) => {
      const share = shares.get(shareId);
      if (!share) throw new Error("Share not found");
      share.expiration = new Date(Date.now() - 60000);
      return { success: true, shareId };
    },
    deleteShare: async (shareId: string) => {
      shares.delete(shareId);
      files.delete(shareId);
      return { success: true, shareId };
    },
    getUploadStatus: async (shareId: string) => {
      const share = shares.get(shareId);
      if (!share) throw new Error("Share not found");
      return {
        shareId: share.id,
        storageProvider: "LOCAL",
        isCompleted: share.uploadLocked,
        chunkSize: 5000000,
        files: files.get(shareId) || [],
        pendingFiles: [],
        canComplete: true,
      };
    },
  };

  const server = buildPingvinMcpServer(deps);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  // 1. List tools
  const toolsResult = await client.listTools();
  const toolNames = toolsResult.tools.map((t) => t.name);
  assert.ok(toolNames.includes("pingvin_create_share"));
  assert.ok(toolNames.includes("pingvin_upload_chunk"));
  assert.ok(toolNames.includes("pingvin_complete_share"));
  assert.ok(toolNames.includes("pingvin_get_share_status"));
  assert.ok(toolNames.includes("pingvin_cancel_share"));
  assert.ok(toolNames.includes("pingvin_list_shares"));
  assert.ok(toolNames.includes("pingvin_update_share"));
  assert.ok(toolNames.includes("pingvin_revoke_share"));
  assert.ok(toolNames.includes("pingvin_delete_share"));
  assert.ok(toolNames.includes("pingvin_get_upload_status"));

  // 2. Create share
  const createRes: any = await client.callTool({
    name: "pingvin_create_share",
    arguments: {
      name: "Agent Upload Batch",
      description: "Automated agent files",
      expiration: "1d",
      password: "secretpassword123",
      maxViews: 5,
    },
  });
  assert.equal(createRes.isError, undefined);
  const createData = JSON.parse(createRes.content[0].text);
  assert.ok(createData.shareId);
  assert.equal(createData.chunkSize, 5000000);
  assert.equal(createData.storageProvider, "LOCAL");
  const shareId = createData.shareId;

  // 3. Early completion rejection (no files yet)
  const prematureComplete: any = await client.callTool({
    name: "pingvin_complete_share",
    arguments: { shareId },
  });
  assert.equal(prematureComplete.isError, true);
  assert.match(
    prematureComplete.content[0].text,
    /Cannot complete a share without any uploaded files/,
  );

  // 4. File A upload (complete: 1 chunk)
  const fileAId = crypto.randomUUID();
  const upA: any = await client.callTool({
    name: "pingvin_upload_chunk",
    arguments: {
      shareId,
      name: "fileA.txt",
      fileId: fileAId,
      chunkIndex: 0,
      totalChunks: 1,
      dataBase64: Buffer.from("File A Content").toString("base64"),
    },
  });
  assert.equal(upA.isError, undefined);

  // 5. File B upload (PARTIAL: chunk 0 of 2)
  const fileBId = crypto.randomUUID();
  const upB1: any = await client.callTool({
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
  assert.equal(upB1.isError, undefined);

  // 6. Complete share MUST be rejected while File B is only partially uploaded!
  const partialComplete: any = await client.callTool({
    name: "pingvin_complete_share",
    arguments: { shareId },
  });
  assert.equal(partialComplete.isError, true);
  assert.match(
    partialComplete.content[0].text,
    /pending file chunks are still being uploaded/,
  );

  // 7. Complete File B (chunk 1 of 2)
  const upB2: any = await client.callTool({
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
  assert.equal(upB2.isError, undefined);

  // 8. Now completion succeeds because all files/chunks are done!
  const completeRes: any = await client.callTool({
    name: "pingvin_complete_share",
    arguments: { shareId },
  });
  assert.equal(completeRes.isError, undefined);
  const completeData = JSON.parse(completeRes.content[0].text);
  assert.equal(completeData.success, true);
  assert.equal(completeData.filesCount, 2);

  // 9. Input validation tests: malformed base64, payload exceeding chunkSize, invalid fileId
  const badBase64: any = await client.callTool({
    name: "pingvin_upload_chunk",
    arguments: {
      shareId,
      name: "bad.txt",
      fileId: crypto.randomUUID(),
      chunkIndex: 0,
      totalChunks: 1,
      dataBase64: "this-is-not-base64!@@#",
    },
  });
  assert.equal(badBase64.isError, true);
  assert.match(badBase64.content[0].text, /strictly valid base64/);

  const badFileId: any = await client.callTool({
    name: "pingvin_upload_chunk",
    arguments: {
      shareId,
      name: "bad.txt",
      fileId: "not-a-valid-uuid",
      chunkIndex: 0,
      totalChunks: 1,
      dataBase64: Buffer.from("ok").toString("base64"),
    },
  });
  assert.equal(badFileId.isError, true);
  assert.match(badFileId.content[0].text, /valid UUID/);

  // 10. Test new tools: list, update, revoke, delete, upload status
  const listRes: any = await client.callTool({
    name: "pingvin_list_shares",
    arguments: { query: "Agent" },
  });
  assert.equal(listRes.isError, undefined);
  const listData = JSON.parse(listRes.content[0].text);
  assert.equal(listData.shares.length, 1);
  assert.equal(listData.shares[0].id, shareId);

  const statusCheck: any = await client.callTool({
    name: "pingvin_get_upload_status",
    arguments: { shareId },
  });
  assert.equal(statusCheck.isError, undefined);
  const statusCheckData = JSON.parse(statusCheck.content[0].text);
  assert.equal(statusCheckData.isCompleted, true);

  const updateRes: any = await client.callTool({
    name: "pingvin_update_share",
    arguments: {
      shareId,
      name: "Renamed Agent Batch",
    },
  });
  assert.equal(updateRes.isError, undefined);
  const updateData = JSON.parse(updateRes.content[0].text);
  assert.equal(updateData.share.name, "Renamed Agent Batch");

  const revokeRes: any = await client.callTool({
    name: "pingvin_revoke_share",
    arguments: { shareId },
  });
  assert.equal(revokeRes.isError, undefined);
  const revokeData = JSON.parse(revokeRes.content[0].text);
  assert.equal(revokeData.success, true);

  // pingvin_delete_share without confirm=true requires confirmation
  const deleteNoConfirm: any = await client.callTool({
    name: "pingvin_delete_share",
    arguments: { shareId },
  });
  assert.equal(deleteNoConfirm.isError, undefined);
  const delData1 = JSON.parse(deleteNoConfirm.content[0].text);
  assert.equal(delData1.requiresConfirmation, true);

  // pingvin_delete_share with confirm=true permanently deletes
  const deleteConfirmed: any = await client.callTool({
    name: "pingvin_delete_share",
    arguments: { shareId, confirm: true },
  });
  assert.equal(deleteConfirmed.isError, undefined);
  const delData2 = JSON.parse(deleteConfirmed.content[0].text);
  assert.equal(delData2.success, true);

  // 11. Dynamic permission check: disabled user rejected for creation, but can list/manage
  currentUserState = { ...currentUserState, allowShare: false };
  const disabledShare: any = await client.callTool({
    name: "pingvin_create_share",
    arguments: { name: "Forbidden" },
  });
  assert.equal(disabledShare.isError, true);
  assert.match(disabledShare.content[0].text, /Sharing is disabled/);

  const allowedList: any = await client.callTool({
    name: "pingvin_list_shares",
    arguments: {},
  });
  assert.equal(allowedList.isError, undefined);

  await client.close();
});
