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
  const normalized = filePath.replace(/\\/g, "/").trim();
  const segments = normalized
    .split("/")
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
  if (segments.length === 0) {
    throw new Error("Invalid path: file name cannot be empty");
  }
  return segments.join("/");
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
  user: {
    id: string;
    username?: string;
    allowShare?: boolean;
    shareSizeLimit?: string | null;
  };
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
        if (deps.user.allowShare === false) {
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
        const maxShareSize = deps.user.shareSizeLimit
          ? parseInt(deps.user.shareSizeLimit, 10)
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
      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error creating share: ${error.message || String(error)}`,
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
        const safeName = sanitizeRelativePath(args.name);

        if (args.chunkIndex >= args.totalChunks) {
          throw new Error(
            `chunkIndex (${args.chunkIndex}) must be strictly less than totalChunks (${args.totalChunks})`,
          );
        }

        const configuredChunkSize = deps.getChunkSize();
        const buffer = Buffer.from(args.dataBase64, "base64");
        if (buffer.length > configuredChunkSize * 1.5) {
          throw new Error(
            `Chunk payload byte length (${buffer.length}) exceeds server chunk size limit`,
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
      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error uploading chunk: ${error.message || String(error)}`,
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
      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error finalizing share: ${error.message || String(error)}`,
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
      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error getting share status: ${error.message || String(error)}`,
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
      } catch (error: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error canceling share: ${error.message || String(error)}`,
            },
          ],
        };
      }
    },
  );

  return server;
}
