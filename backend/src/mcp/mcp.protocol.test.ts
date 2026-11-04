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
  normalizeExpirationInput,
  sanitizeRelativePath,
  verifyAgentTokenFormat,
} from "./mcp.protocol.ts";

test("sanitizeRelativePath blocks directory traversal and cleans paths", () => {
  assert.equal(sanitizeRelativePath("simple.txt"), "simple.txt");
  assert.equal(
    sanitizeRelativePath("folder/sub/file.pdf"),
    "folder/sub/file.pdf",
  );
  assert.equal(
    sanitizeRelativePath("folder\\sub\\file.pdf"),
    "folder/sub/file.pdf",
  );
  assert.equal(sanitizeRelativePath("../../../etc/passwd"), "etc/passwd");
  assert.equal(sanitizeRelativePath("/root/file.txt"), "root/file.txt");
  assert.equal(sanitizeRelativePath("././file.txt"), "file.txt");
  assert.equal(sanitizeRelativePath("a/../../b/c.txt"), "a/b/c.txt");
  assert.throws(() => sanitizeRelativePath(""), /Invalid path/);
  assert.throws(() => sanitizeRelativePath("../.."), /Invalid path/);
  assert.throws(() => sanitizeRelativePath("///"), /Invalid path/);
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

  const deps = {
    user: {
      id: "agent-user-1",
      username: "agent-alice",
      allowShare: true,
      shareSizeLimit: "100000000",
    },
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
      const key = `${params.shareId}:${params.fileId}`;
      const existing = fileBuffers.get(key) || Buffer.alloc(0);
      const combined = Buffer.concat([existing, params.data]);
      fileBuffers.set(key, combined);

      if (params.chunkIndex === params.totalChunks - 1) {
        const shareFiles = files.get(params.shareId) || [];
        shareFiles.push({
          id: params.fileId,
          name: params.name,
          size: combined.length.toString(),
        });
        files.set(params.shareId, shareFiles);
      }
      return { id: params.fileId, name: params.name };
    },
    completeShare: async (shareId: string) => {
      const share = shares.get(shareId);
      if (!share) throw new Error("Share not found");
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

  // 4. Multi-chunk binary file upload
  const rawBytesPart1 = Buffer.from("PINGVIN-CHUNK-0-DATA-START; ");
  const rawBytesPart2 = Buffer.from("PINGVIN-CHUNK-1-DATA-END.");
  const expectedTotalBytes = Buffer.concat([rawBytesPart1, rawBytesPart2]);

  const fileId = crypto.randomUUID();
  const up1: any = await client.callTool({
    name: "pingvin_upload_chunk",
    arguments: {
      shareId,
      name: "reports/quarterly.pdf",
      fileId,
      chunkIndex: 0,
      totalChunks: 2,
      dataBase64: rawBytesPart1.toString("base64"),
    },
  });
  assert.equal(up1.isError, undefined);
  const up1Parsed = JSON.parse(up1.content[0].text);
  assert.equal(up1Parsed.isComplete, false);

  const up2: any = await client.callTool({
    name: "pingvin_upload_chunk",
    arguments: {
      shareId,
      name: "reports/quarterly.pdf",
      fileId,
      chunkIndex: 1,
      totalChunks: 2,
      dataBase64: rawBytesPart2.toString("base64"),
    },
  });
  assert.equal(up2.isError, undefined);
  const up2Parsed = JSON.parse(up2.content[0].text);
  assert.equal(up2Parsed.isComplete, true);

  // Check stored buffer integrity
  const stored = fileBuffers.get(`${shareId}:${fileId}`);
  assert.deepEqual(stored, expectedTotalBytes);

  // 5. Complete share and verify public share link
  const completeRes: any = await client.callTool({
    name: "pingvin_complete_share",
    arguments: { shareId },
  });
  assert.equal(completeRes.isError, undefined);
  const completeData = JSON.parse(completeRes.content[0].text);
  assert.equal(completeData.success, true);
  assert.equal(
    completeData.url,
    `https://share.arunshrestha.info.np/share/${shareId}`,
  );
  assert.equal(completeData.filesCount, 1);
  assert.equal(completeData.hasPassword, true);
  assert.equal(completeData.maxViews, 5);

  // 6. Share status reports completed and carries public link
  const statusRes: any = await client.callTool({
    name: "pingvin_get_share_status",
    arguments: { shareId },
  });
  assert.equal(statusRes.isError, undefined);
  const statusData = JSON.parse(statusRes.content[0].text);
  assert.equal(statusData.isCompleted, true);
  assert.equal(
    statusData.url,
    `https://share.arunshrestha.info.np/share/${shareId}`,
  );

  // 7. Cancellation cleans up share
  const shareToCancel: any = await client.callTool({
    name: "pingvin_create_share",
    arguments: { name: "Temp Share" },
  });
  const cancelId = JSON.parse(shareToCancel.content[0].text).shareId;
  const cancelRes: any = await client.callTool({
    name: "pingvin_cancel_share",
    arguments: { shareId: cancelId },
  });
  assert.equal(cancelRes.isError, undefined);
  assert.equal(shares.has(cancelId), false);

  await client.close();
});
