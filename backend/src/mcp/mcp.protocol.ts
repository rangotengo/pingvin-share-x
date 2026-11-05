import * as crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const AGENT_TOKEN_PREFIX = "psa_";

export function generateAgentToken(): {
  rawToken: string;
  tokenPrefix: string;
  tokenHash: string;
} {
  const entropy = crypto.randomBytes(32).toString("hex");
  const rawToken = `${AGENT_TOKEN_PREFIX}${entropy}`;
  const tokenPrefix = `${AGENT_TOKEN_PREFIX}${entropy.slice(0, 8)}...`;
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  return { rawToken, tokenPrefix, tokenHash };
}

export function hashAgentToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export function verifyAgentTokenFormat(rawToken: string): boolean {
  return (
    typeof rawToken === "string" &&
    rawToken.startsWith(AGENT_TOKEN_PREFIX) &&
    rawToken.length >= 36
  );
}

export function sanitizeRelativePath(filePath: string): string {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new Error("Invalid path: file name cannot be empty");
  }
  const normalized = filePath.replace(/\\/g, "/").trim();
  if (normalized.includes("\0")) {
    throw new Error("Invalid path: null bytes are not allowed");
  }
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error("Invalid path: absolute paths are not allowed");
  }
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") {
      throw new Error("Invalid path: directory traversal is not allowed");
    }
    if (seg.length === 0) {
      throw new Error("Invalid path: empty path segment");
    }
  }
  return segments.join("/");
}

export function isStrictBase64(str: string): boolean {
  if (typeof str !== "string") return false;
  if (str.length === 0) return true;
  if (str.length % 4 !== 0) return false;
  const base64Regex =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;
  if (!base64Regex.test(str)) return false;
  try {
    return Buffer.from(str, "base64").toString("base64") === str;
  } catch {
    return false;
  }
}

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const SHARE_ID_REGEX = /^[a-zA-Z0-9_-]{3,50}$/;

export function extractBearerToken(authHeader?: string): string | null {
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return null;
}

export function validateOriginHeader(
  origin: string | undefined,
  appUrl: string,
): boolean {
  if (!origin || typeof origin !== "string") {
    return true; // Non-browser clients (CLI helper, Claude Desktop, curl)
  }
  try {
    const requestOrigin = new URL(origin).origin;
    if (appUrl) {
      const configuredOrigin = new URL(appUrl).origin;
      if (requestOrigin === configuredOrigin) return true;
    }
    const host = new URL(origin).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function isInitializeRequest(body: unknown): boolean {
  return (
    (body !== null &&
      typeof body === "object" &&
      (body as Record<string, unknown>).method === "initialize") ||
    (Array.isArray(body) &&
      body.some(
        (msg) =>
          msg !== null &&
          typeof msg === "object" &&
          (msg as Record<string, unknown>).method === "initialize",
      ))
  );
}

export class SessionTracker<
  T extends {
    userId: string;
    lastActive: number;
    close: () => Promise<void> | void;
  },
> {
  private sessions = new Map<string, T>();
  readonly maxSessionsPerUser: number;
  readonly maxTotalSessions: number;
  readonly sessionIdleTimeoutMs: number;

  constructor(
    maxSessionsPerUser = 10,
    maxTotalSessions = 100,
    sessionIdleTimeoutMs = 30 * 60 * 1000,
  ) {
    this.maxSessionsPerUser = maxSessionsPerUser;
    this.maxTotalSessions = maxTotalSessions;
    this.sessionIdleTimeoutMs = sessionIdleTimeoutMs;
  }

  get(sessionId: string): T | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActive = Date.now();
    }
    return session;
  }

  set(sessionId: string, session: T): void {
    this.cleanupExpired();
    this.evictForUser(session.userId);
    this.sessions.set(sessionId, session);
  }

  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      void Promise.resolve(session.close()).catch(() => {});
      this.sessions.delete(sessionId);
      return true;
    }
    return false;
  }

  cleanupExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActive > this.sessionIdleTimeoutMs) {
        this.delete(id);
      }
    }
  }

  private evictForUser(userId: string): void {
    const userSessions: Array<{ id: string; session: T }> = [];
    for (const [id, session] of this.sessions.entries()) {
      if (session.userId === userId) {
        userSessions.push({ id, session });
      }
    }
    if (userSessions.length >= this.maxSessionsPerUser) {
      userSessions.sort((a, b) => a.session.lastActive - b.session.lastActive);
      this.delete(userSessions[0].id);
    }
    if (this.sessions.size >= this.maxTotalSessions) {
      const all = Array.from(this.sessions.entries()).sort(
        (a, b) => a[1].lastActive - b[1].lastActive,
      );
      if (all[0]) {
        this.delete(all[0][0]);
      }
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  entries(): IterableIterator<[string, T]> {
    return this.sessions.entries();
  }
}

export interface PendingFileInfo {
  name: string;
  totalChunks: number;
  chunks: Set<number>;
}

export class PendingUploadsTracker {
  private pending = new Map<string, Map<string, PendingFileInfo>>();

  trackChunk(
    shareId: string,
    fileId: string,
    name: string,
    chunkIndex: number,
    totalChunks: number,
  ): { isComplete: boolean } {
    let shareFiles = this.pending.get(shareId);
    if (!shareFiles) {
      shareFiles = new Map();
      this.pending.set(shareId, shareFiles);
    }
    let fileInfo = shareFiles.get(fileId);
    if (!fileInfo) {
      fileInfo = { name, totalChunks, chunks: new Set() };
      shareFiles.set(fileId, fileInfo);
    }
    fileInfo.chunks.add(chunkIndex);

    const isComplete =
      chunkIndex === totalChunks - 1 && fileInfo.chunks.size >= totalChunks;
    if (isComplete) {
      shareFiles.delete(fileId);
      if (shareFiles.size === 0) {
        this.pending.delete(shareId);
      }
    }
    return { isComplete };
  }

  hasPendingFiles(shareId: string): {
    hasPending: boolean;
    fileName?: string;
    received?: number;
    total?: number;
  } {
    const shareFiles = this.pending.get(shareId);
    if (!shareFiles || shareFiles.size === 0) {
      return { hasPending: false };
    }
    const [_, info] = shareFiles.entries().next().value;
    return {
      hasPending: true,
      fileName: info.name,
      received: info.chunks.size,
      total: info.totalChunks,
    };
  }

  clearShare(shareId: string): void {
    this.pending.delete(shareId);
  }
}

export function normalizeExpirationInput(input?: any): string {
  if (!input) return "7-days";
  if (typeof input === "object" && input.value !== undefined) {
    return `${input.value}-${input.unit || "days"}`;
  }
  if (typeof input !== "string") return "7-days";
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "never") return "never";

  const shorthandMatch = trimmed.match(/^(\d+)\s*([a-z]+)$/);
  if (shorthandMatch) {
    const count = shorthandMatch[1];
    const unit = shorthandMatch[2];
    if (unit === "d" || unit === "day" || unit === "days")
      return `${count}-days`;
    if (unit === "h" || unit === "hour" || unit === "hours")
      return `${count}-hours`;
    if (
      unit === "m" ||
      unit === "min" ||
      unit === "minute" ||
      unit === "minutes"
    )
      return `${count}-minutes`;
    if (unit === "w" || unit === "week" || unit === "weeks")
      return `${count}-weeks`;
    if (unit === "mo" || unit === "month" || unit === "months")
      return `${count}-months`;
    if (unit === "y" || unit === "year" || unit === "years")
      return `${count}-years`;
  }
  return input.trim();
}

export interface McpServerDependencies {
  user?: {
    id: string;
    username?: string;
    allowShare?: boolean;
    shareSizeLimit?: string | null;
  };
  getCurrentUser?: () =>
    | Promise<{
        id: string;
        username?: string;
        allowShare?: boolean;
        shareSizeLimit?: string | null;
      } | null>
    | {
        id: string;
        username?: string;
        allowShare?: boolean;
        shareSizeLimit?: string | null;
      }
    | null;
  getAppUrl: () => string;
  getChunkSize: () => number;
  getShareIdLength: () => number;
  getDefaultExpiration: () => string;
  getMaxShareSize: () => number;
  createShare: (params: {
    id: string;
    name?: string;
    description?: string;
    expiration: string;
    password?: string;
    maxViews?: number;
  }) => Promise<{
    id: string;
    name?: string;
    storageProvider: string;
    expiration: Date;
  }>;
  uploadChunk: (params: {
    shareId: string;
    fileId: string;
    name: string;
    chunkIndex: number;
    totalChunks: number;
    data: Buffer;
  }) => Promise<{ id: string; name: string }>;
  completeShare: (shareId: string) => Promise<{
    id: string;
    expiration: Date;
    hasPassword: boolean;
    maxViews?: number | null;
    files: Array<{ id: string; name: string; size: string }>;
  }>;
  getShareStatus: (shareId: string) => Promise<{
    id: string;
    name?: string;
    uploadLocked: boolean;
    files: Array<{ id: string; name: string; size: string }>;
  } | null>;
  cancelShare: (shareId: string) => Promise<void>;
  listShares?: (params: {
    limit?: number;
    cursor?: string;
    query?: string;
    includeExpired?: boolean;
  }) => Promise<{
    shares: Array<{
      id: string;
      name?: string | null;
      description?: string | null;
      createdAt: Date;
      expiration: Date;
      isExpired: boolean;
      uploadLocked: boolean;
      views: number;
      filesCount: number;
      totalBytes: number;
      hasPassword: boolean;
      maxViews?: number | null;
      url: string;
    }>;
    nextCursor: string | null;
    total: number;
  }>;
  updateShare?: (params: {
    shareId: string;
    name?: string;
    description?: string;
    expiration?: string;
    password?: string;
    maxViews?: number;
  }) => Promise<{
    id: string;
    name?: string | null;
    description?: string | null;
    expiration: Date;
    hasPassword: boolean;
    maxViews?: number | null;
  }>;
  revokeShare?: (shareId: string) => Promise<{ success: boolean; shareId: string }>;
  deleteShare?: (shareId: string) => Promise<{ success: boolean; shareId: string }>;
  getUploadStatus?: (shareId: string) => Promise<{
    shareId: string;
    storageProvider: string;
    isCompleted: boolean;
    chunkSize: number;
    files: Array<{ id: string; name: string; size: string }>;
    pendingFiles: Array<{
      id: string;
      name: string;
      totalChunks?: number | null;
      expectedChunkIndex: number;
      committedBytes: number;
      updatedAt: Date;
    }>;
    canComplete: boolean;
  }>;
}

async function resolveUser(deps: McpServerDependencies) {
  if (deps.getCurrentUser) {
    const user = await deps.getCurrentUser();
    if (user) return user;
  }
  return deps.user;
}

export function buildPingvinMcpServer(deps: McpServerDependencies): McpServer {
  const server = new McpServer({
    name: "pingvin-share",
    version: "2.1.0",
  });

  // Tool 1: pingvin_create_share
  server.tool(
    "pingvin_create_share",
    "Create a new file share on Pingvin Share to receive file uploads. Returns shareId and chunk configuration.",
    {
      name: z
        .string()
        .max(255)
        .optional()
        .describe("Optional human-readable name for the share"),
      description: z
        .string()
        .max(1024)
        .optional()
        .describe("Optional description for the share"),
      expiration: z
        .string()
        .optional()
        .describe(
          "Expiration time e.g. '1d', '7d', '24h', 'never', or ISO 8601 string",
        ),
      password: z
        .string()
        .optional()
        .describe("Optional password to protect the share"),
      maxViews: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Optional maximum download view count limit"),
    },
    async (args) => {
      try {
        const user = await resolveUser(deps);
        if (!user || user.allowShare === false) {
          throw new Error("Sharing is disabled for this user");
        }

        const shareIdLength = deps.getShareIdLength();
        const shareId = crypto
          .randomBytes(Math.ceil(shareIdLength * 0.75))
          .toString("base64url")
          .slice(0, shareIdLength);

        const defaultExpiration = deps.getDefaultExpiration();
        const expiration = normalizeExpirationInput(
          args.expiration || defaultExpiration,
        );

        const createdShare = await deps.createShare({
          id: shareId,
          name: args.name,
          description: args.description,
          expiration,
          password: args.password,
          maxViews: args.maxViews,
        });

        const chunkSize = deps.getChunkSize();
        const maxShareSize = user.shareSizeLimit
          ? parseInt(user.shareSizeLimit, 10)
          : deps.getMaxShareSize();

        const result = {
          shareId: createdShare.id,
          name: createdShare.name,
          chunkSize,
          storageProvider: createdShare.storageProvider,
          maxShareSize,
          expiration: createdShare.expiration,
          message:
            "Share created successfully. Upload each file chunk using pingvin_upload_chunk, then finalize with pingvin_complete_share.",
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error creating share: ${msg}`,
            },
          ],
        };
      }
    },
  );

  // Tool 2: pingvin_upload_chunk
  server.tool(
    "pingvin_upload_chunk",
    "Upload a single binary data chunk (base64 encoded) for a file within a share.",
    {
      shareId: z
        .string()
        .describe("ID of the share returned by pingvin_create_share"),
      name: z
        .string()
        .describe(
          "Relative path or file name (e.g. 'notes.txt' or 'docs/report.pdf')",
        ),
      chunkIndex: z
        .number()
        .int()
        .min(0)
        .describe("0-based index of this chunk (0 to totalChunks - 1)"),
      totalChunks: z
        .number()
        .int()
        .min(1)
        .describe("Total count of chunks for this file (minimum 1)"),
      dataBase64: z
        .string()
        .describe(
          "Base64-encoded chunk binary content (must not exceed configured chunkSize)",
        ),
      fileId: z
        .string()
        .optional()
        .describe(
          "Optional UUID for this file to ensure deterministic chunk appending across retries",
        ),
    },
    async (args) => {
      try {
        if (!SHARE_ID_REGEX.test(args.shareId)) {
          throw new Error(
            `Invalid shareId: '${args.shareId}' must match /^[a-zA-Z0-9_-]{3,50}$/`,
          );
        }

        const safeName = sanitizeRelativePath(args.name);

        if (!Number.isSafeInteger(args.chunkIndex) || args.chunkIndex < 0) {
          throw new Error(
            `chunkIndex (${args.chunkIndex}) must be a non-negative safe integer`,
          );
        }

        if (!Number.isSafeInteger(args.totalChunks) || args.totalChunks < 1) {
          throw new Error(
            `totalChunks (${args.totalChunks}) must be a positive safe integer`,
          );
        }

        if (args.chunkIndex >= args.totalChunks) {
          throw new Error(
            `chunkIndex (${args.chunkIndex}) must be strictly less than totalChunks (${args.totalChunks})`,
          );
        }

        if (args.fileId && !UUID_REGEX.test(args.fileId)) {
          throw new Error(
            `Invalid fileId: '${args.fileId}' must be a valid UUID`,
          );
        }

        if (!isStrictBase64(args.dataBase64)) {
          throw new Error(
            "Invalid chunk payload: dataBase64 must be a strictly valid base64 string",
          );
        }

        const configuredChunkSize = deps.getChunkSize();
        const buffer = Buffer.from(args.dataBase64, "base64");
        if (buffer.length > configuredChunkSize) {
          throw new Error(
            `Chunk payload byte length (${buffer.length}) exceeds server chunk size limit (${configuredChunkSize})`,
          );
        }

        const fileId = args.fileId || crypto.randomUUID();

        await deps.uploadChunk({
          shareId: args.shareId,
          fileId,
          name: safeName,
          chunkIndex: args.chunkIndex,
          totalChunks: args.totalChunks,
          data: buffer,
        });

        const isComplete = args.chunkIndex === args.totalChunks - 1;
        const result = {
          success: true,
          shareId: args.shareId,
          fileId,
          name: safeName,
          chunkIndex: args.chunkIndex,
          totalChunks: args.totalChunks,
          isComplete,
          message: isComplete
            ? `File '${safeName}' fully uploaded (${args.totalChunks} chunks).`
            : `Chunk ${args.chunkIndex + 1}/${args.totalChunks} received.`,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error uploading chunk: ${msg}`,
            },
          ],
        };
      }
    },
  );

  // Tool 3: pingvin_complete_share
  server.tool(
    "pingvin_complete_share",
    "Finalize a share after all files and chunks have been uploaded. Locks share and returns the ready public shareable URL.",
    {
      shareId: z.string().describe("ID of the share to complete"),
    },
    async (args) => {
      try {
        if (!SHARE_ID_REGEX.test(args.shareId)) {
          throw new Error(
            `Invalid shareId: '${args.shareId}' must match /^[a-zA-Z0-9_-]{3,50}$/`,
          );
        }
        const completed = await deps.completeShare(args.shareId);
        const appUrl = deps.getAppUrl().replace(/\/$/, "");
        const publicUrl = appUrl
          ? `${appUrl}/share/${args.shareId}`
          : `/share/${args.shareId}`;

        const totalBytes = completed.files.reduce(
          (acc, f) => acc + parseInt(f.size, 10),
          0,
        );

        const result = {
          success: true,
          shareId: completed.id,
          url: publicUrl,
          filesCount: completed.files.length,
          totalBytes,
          files: completed.files,
          expiration: completed.expiration,
          hasPassword: completed.hasPassword,
          maxViews: completed.maxViews,
          message: `Share successfully finalized! Shareable public URL: ${publicUrl}`,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error finalizing share: ${msg}`,
            },
          ],
        };
      }
    },
  );

  // Tool 4: pingvin_get_share_status
  server.tool(
    "pingvin_get_share_status",
    "Get current status of a share, including uploaded files and whether it is completed.",
    {
      shareId: z.string().describe("ID of the share to inspect"),
    },
    async (args) => {
      try {
        if (!SHARE_ID_REGEX.test(args.shareId)) {
          throw new Error(
            `Invalid shareId: '${args.shareId}' must match /^[a-zA-Z0-9_-]{3,50}$/`,
          );
        }
        const share = await deps.getShareStatus(args.shareId);
        if (!share) {
          throw new Error(`Share '${args.shareId}' not found`);
        }

        const appUrl = deps.getAppUrl().replace(/\/$/, "");
        const publicUrl = share.uploadLocked
          ? appUrl
            ? `${appUrl}/share/${share.id}`
            : `/share/${share.id}`
          : null;

        const result = {
          shareId: share.id,
          name: share.name,
          isCompleted: share.uploadLocked,
          filesCount: share.files.length,
          files: share.files,
          url: publicUrl,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error getting share status: ${msg}`,
            },
          ],
        };
      }
    },
  );

  // Tool 5: pingvin_cancel_share
  server.tool(
    "pingvin_cancel_share",
    "Cancel and delete an in-progress share and clean up any uploaded files.",
    {
      shareId: z.string().describe("ID of the share to cancel and delete"),
    },
    async (args) => {
      try {
        if (!SHARE_ID_REGEX.test(args.shareId)) {
          throw new Error(
            `Invalid shareId: '${args.shareId}' must match /^[a-zA-Z0-9_-]{3,50}$/`,
          );
        }
        await deps.cancelShare(args.shareId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: `Share '${args.shareId}' was cancelled and deleted.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error canceling share: ${msg}`,
            },
          ],
        };
      }
    },
  );

  // Tool 6: pingvin_list_shares
  server.tool(
    "pingvin_list_shares",
    "List and search shares owned by the authenticated agent user with pagination.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .optional()
        .describe("Number of shares to return (1-100, default 20)"),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor: shareId of last item from previous page"),
      query: z
        .string()
        .max(255)
        .optional()
        .describe("Substring search query matching share name or description"),
      includeExpired: z
        .boolean()
        .default(false)
        .optional()
        .describe("Include expired or revoked shares (default false)"),
    },
    async (args) => {
      try {
        if (!deps.listShares) throw new Error("listShares not implemented");
        const res = await deps.listShares(args);
        return {
          content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `Error listing shares: ${msg}` }],
        };
      }
    },
  );

  // Tool 7: pingvin_update_share
  server.tool(
    "pingvin_update_share",
    "Update an existing share's expiration, name, description, password, or max views limit.",
    {
      shareId: z.string().describe("ID of the share to update"),
      name: z.string().max(255).optional().describe("New name for the share"),
      description: z.string().max(1024).optional().describe("New description for the share"),
      expiration: z
        .string()
        .optional()
        .describe("New expiration: '1d', '7d', 'never', or ISO 8601 string"),
      password: z
        .string()
        .optional()
        .describe("New password to protect share, or empty string to remove password"),
      maxViews: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("New maximum view count limit"),
    },
    async (args) => {
      try {
        if (!deps.updateShare) throw new Error("updateShare not implemented");
        const res = await deps.updateShare(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  share: res,
                  message: "Share updated successfully.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `Error updating share: ${msg}` }],
        };
      }
    },
  );

  // Tool 8: pingvin_revoke_share
  server.tool(
    "pingvin_revoke_share",
    "Immediately revoke public access to a share, invalidating all links, tokens, and existing session cookies.",
    {
      shareId: z.string().describe("ID of the share to revoke"),
    },
    async (args) => {
      try {
        if (!deps.revokeShare) throw new Error("revokeShare not implemented");
        const res = await deps.revokeShare(args.shareId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  shareId: res.shareId,
                  message:
                    "Share revoked successfully. All existing links, tokens, and cookies are now invalid.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `Error revoking share: ${msg}` }],
        };
      }
    },
  );

  // Tool 9: pingvin_delete_share
  server.tool(
    "pingvin_delete_share",
    "Permanently delete an owned share and all associated files. Destructive action requires explicit confirm: true.",
    {
      shareId: z.string().describe("ID of the share to permanently delete"),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Confirmation flag: must be strictly true to delete the share and all files",
        ),
    },
    async (args) => {
      try {
        if (args.confirm !== true) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: false,
                    requiresConfirmation: true,
                    shareId: args.shareId,
                    message:
                      "Confirmation required: set confirm: true to permanently delete this share and all its files.",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        if (!deps.deleteShare) throw new Error("deleteShare not implemented");
        const res = await deps.deleteShare(args.shareId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  shareId: res.shareId,
                  message: "Share and files deleted successfully.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `Error deleting share: ${msg}` }],
        };
      }
    },
  );

  // Tool 10: pingvin_get_upload_status
  server.tool(
    "pingvin_get_upload_status",
    "Get detailed resumable upload progress, completed files, and in-progress chunk state for a share.",
    {
      shareId: z.string().describe("ID of the share to inspect"),
    },
    async (args) => {
      try {
        if (!deps.getUploadStatus) throw new Error("getUploadStatus not implemented");
        const status = await deps.getUploadStatus(args.shareId);
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `Error getting upload status: ${msg}` }],
        };
      }
    },
  );

  return server;
}
