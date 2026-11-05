import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { User } from "@prisma/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as crypto from "crypto";
import { ConfigService } from "../config/config.service";
import { FileService } from "../file/file.service";
import { PrismaService } from "../prisma/prisma.service";
import { ShareService } from "../share/share.service";
import { buildPingvinMcpServer, McpServerDependencies } from "./mcp.protocol";

export interface McpSession {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  userId: string;
  user: User;
  lastActive: number;
}

interface PendingFileInfo {
  name: string;
  totalChunks: number;
  chunks: Set<number>;
}

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private sessions = new Map<string, McpSession>();

  // Resource bounds: max sessions per user and globally
  readonly maxSessionsPerUser = 10;
  readonly maxTotalSessions = 100;
  readonly sessionIdleTimeoutMs = 30 * 60 * 1000;

  // Track in-progress uploads: shareId -> (fileId -> PendingFileInfo)
  private pendingUploads = new Map<string, Map<string, PendingFileInfo>>();

  private prisma: PrismaService;
  private shareService: ShareService;
  private fileService: FileService;
  private configService: ConfigService;

  constructor(
    prisma: PrismaService,
    shareService: ShareService,
    fileService: FileService,
    configService: ConfigService,
  ) {
    this.prisma = prisma;
    this.shareService = shareService;
    this.fileService = fileService;
    this.configService = configService;
    setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000).unref();
  }

  getSession(sessionId: string): McpSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActive = Date.now();
    }
    return session;
  }

  updateSessionUser(sessionId: string, user: User): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.user = user;
      session.lastActive = Date.now();
    }
  }

  removeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      void session.transport.close().catch(() => {});
      this.sessions.delete(sessionId);
      return true;
    }
    return false;
  }

  cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActive > this.sessionIdleTimeoutMs) {
        this.logger.debug(`Cleaning up idle MCP session ${id}`);
        void session.transport.close().catch(() => {});
        this.sessions.delete(id);
      }
    }
  }

  private evictSessionsForUser(userId: string): void {
    const userSessions: McpSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId === userId) {
        userSessions.push(session);
      }
    }
    if (userSessions.length >= this.maxSessionsPerUser) {
      userSessions.sort((a, b) => a.lastActive - b.lastActive);
      const oldest = userSessions[0];
      this.removeSession(oldest.sessionId);
    }
    if (this.sessions.size >= this.maxTotalSessions) {
      const allSessions = Array.from(this.sessions.values()).sort(
        (a, b) => a.lastActive - b.lastActive,
      );
      if (allSessions[0]) {
        this.removeSession(allSessions[0].sessionId);
      }
    }
  }

  async createSession(user: User): Promise<McpSession> {
    this.cleanupExpiredSessions();
    this.evictSessionsForUser(user.id);

    const sessionId = crypto.randomUUID();
    let currentSessionUser = user;

    const deps: McpServerDependencies = {
      getCurrentUser: async () => {
        const fresh = await this.prisma.user.findUnique({
          where: { id: user.id },
        });
        if (fresh) {
          currentSessionUser = fresh;
        }
        return currentSessionUser;
      },
      getAppUrl: () => {
        const configured = this.configService.get("general.appUrl");
        return (configured || "").trim();
      },
      getChunkSize: () => {
        const configured = parseInt(
          this.configService.get("share.chunkSize") || "52428800",
          10,
        );
        if (this.configService.get("s3.enabled")) {
          // S3 multipart parts (except final) must be >= 5MB
          return Math.max(5242880, configured);
        }
        return configured;
      },
      getShareIdLength: () => {
        return parseInt(
          this.configService.get("share.shareIdLength") || "16",
          10,
        );
      },
      getDefaultExpiration: () => {
        const conf: any = this.configService.get("share.defaultExpiration");
        if (typeof conf === "string") return conf;
        if (conf && typeof conf === "object" && conf.value !== undefined) {
          return `${conf.value}-${conf.unit || "days"}`;
        }
        return "7-days";
      },
      getMaxShareSize: () => {
        return parseInt(
          this.configService.get("share.maxSize") || "1000000000",
          10,
        );
      },
      createShare: async (params) => {
        const freshUser = await this.prisma.user.findUnique({
          where: { id: user.id },
        });
        if (!freshUser || freshUser.allowShare === false) {
          throw new ForbiddenException("Sharing is disabled for this user");
        }
        currentSessionUser = freshUser;

        return this.shareService.create(
          {
            id: params.id,
            name: params.name,
            description: params.description,
            expiration: params.expiration,
            security:
              params.password || params.maxViews
                ? {
                    password: params.password,
                    maxViews: params.maxViews,
                    restrictToRecipients: false,
                  }
                : undefined,
            recipients: [],
            size: undefined as any,
          },
          freshUser,
        );
      },
      uploadChunk: async (params) => {
        const share = await this.prisma.share.findUnique({
          where: { id: params.shareId },
          select: { id: true, creatorId: true, uploadLocked: true },
        });

        if (!share) {
          throw new NotFoundException(`Share '${params.shareId}' not found`);
        }
        if (share.creatorId !== user.id) {
          throw new ForbiddenException(
            "Cannot upload to a share owned by another user",
          );
        }
        if (share.uploadLocked) {
          throw new BadRequestException(
            "Share is already completed and locked",
          );
        }

        const existingFile = await this.prisma.file.findFirst({
          where: { shareId: params.shareId, name: params.name },
        });
        if (existingFile && existingFile.id !== params.fileId) {
          throw new BadRequestException(
            `A file named '${params.name}' already exists in this share`,
          );
        }

        let sharePending = this.pendingUploads.get(params.shareId);
        if (!sharePending) {
          sharePending = new Map();
          this.pendingUploads.set(params.shareId, sharePending);
        }
        let pending = sharePending.get(params.fileId);
        if (!pending) {
          pending = {
            name: params.name,
            totalChunks: params.totalChunks,
            chunks: new Set(),
          };
          sharePending.set(params.fileId, pending);
        }
        pending.chunks.add(params.chunkIndex);

        const res = await this.fileService.create(
          params.data as any,
          { index: params.chunkIndex, total: params.totalChunks },
          { id: params.fileId, name: params.name },
          params.shareId,
        );

        if (
          params.chunkIndex === params.totalChunks - 1 &&
          pending.chunks.size >= params.totalChunks
        ) {
          sharePending.delete(params.fileId);
          if (sharePending.size === 0) {
            this.pendingUploads.delete(params.shareId);
          }
        }

        return { id: res?.id || params.fileId, name: params.name };
      },
      completeShare: async (shareId) => {
        const share = await this.prisma.share.findUnique({
          where: { id: shareId },
          include: { files: true, security: true },
        });

        if (!share) {
          throw new NotFoundException(`Share '${shareId}' not found`);
        }
        if (share.creatorId !== user.id) {
          throw new ForbiddenException(
            "Cannot complete a share owned by another user",
          );
        }
        if (share.uploadLocked) {
          throw new BadRequestException("Share is already completed");
        }
        if (share.files.length === 0) {
          throw new BadRequestException(
            "Cannot complete a share without any uploaded files",
          );
        }

        // Check in-memory pending uploads
        const pendingFiles = this.pendingUploads.get(shareId);
        if (pendingFiles && pendingFiles.size > 0) {
          const firstPending = pendingFiles.values().next().value;
          throw new BadRequestException(
            `Cannot complete share: upload for file '${firstPending.name}' is incomplete (${firstPending.chunks.size}/${firstPending.totalChunks} chunks)`,
          );
        }

        // Check storage provider state for incomplete / in-flight uploads (restart safe)
        const hasPendingStorage =
          await this.fileService.hasPendingUploads(shareId);
        if (hasPendingStorage) {
          throw new BadRequestException(
            "Cannot complete share: pending file chunk uploads are still in progress",
          );
        }

        const completed = await this.shareService.complete(shareId);

        return {
          id: completed.id,
          expiration: completed.expiration,
          hasPassword: !!share.security?.password,
          maxViews: share.security?.maxViews,
          files: share.files.map((f) => ({
            id: f.id,
            name: f.name,
            size: f.size,
          })),
        };
      },
      getShareStatus: async (shareId) => {
        const share = await this.prisma.share.findUnique({
          where: { id: shareId },
          include: { files: true },
        });

        if (!share) return null;
        if (share.creatorId !== user.id) {
          throw new ForbiddenException(
            "Cannot inspect a share owned by another user",
          );
        }

        return {
          id: share.id,
          name: share.name,
          uploadLocked: share.uploadLocked,
          files: share.files.map((f) => ({
            id: f.id,
            name: f.name,
            size: f.size,
          })),
        };
      },
      cancelShare: async (shareId) => {
        const share = await this.prisma.share.findUnique({
          where: { id: shareId },
        });

        if (!share) {
          throw new NotFoundException(`Share '${shareId}' not found`);
        }
        if (share.creatorId !== user.id) {
          throw new ForbiddenException(
            "Cannot delete a share owned by another user",
          );
        }

        this.pendingUploads.delete(shareId);
        await this.fileService.abortPendingUploads(shareId);

        if (!share.uploadLocked) {
          await this.shareService.remove(shareId, false);
        }
      },
      listShares: async (params) => {
        const freshUser = await this.prisma.user.findUnique({
          where: { id: user.id },
        });
        if (!freshUser) throw new ForbiddenException("User not found");

        const limit = Math.min(Math.max(params.limit || 20, 1), 100);
        const where: any = {
          creatorId: freshUser.id,
        };

        if (!params.includeExpired) {
          where.removedReason = null;
          where.OR = [
            { expiration: { gt: new Date() } },
            { expiration: { equals: new Date(0) } },
          ];
        }

        if (params.query && params.query.trim()) {
          const q = params.query.trim();
          where.AND = [
            {
              OR: [
                { name: { contains: q } },
                { description: { contains: q } },
              ],
            },
          ];
        }

        const total = await this.prisma.share.count({ where });

        const findArgs: any = {
          where,
          take: limit + 1,
          orderBy: { createdAt: "desc" },
          include: { files: true, security: true },
        };

        if (params.cursor) {
          findArgs.cursor = { id: params.cursor };
          findArgs.skip = 1;
        }

        const items: any[] = await this.prisma.share.findMany(findArgs);
        let nextCursor: string | null = null;
        if (items.length > limit) {
          const nextItem = items.pop();
          nextCursor = nextItem ? nextItem.id : null;
        }

        const appUrl = (this.configService.get("general.appUrl") || "").trim().replace(/\/$/, "");

        const shares = items.map((s) => {
          const totalBytes = s.files.reduce((acc, f) => acc + parseInt(f.size, 10), 0);
          const isExpired =
            s.removedReason !== null ||
            (s.expiration.getTime() !== 0 && s.expiration.getTime() < Date.now());

          return {
            id: s.id,
            name: s.name,
            description: s.description,
            createdAt: s.createdAt,
            expiration: s.expiration,
            isExpired,
            uploadLocked: s.uploadLocked,
            views: s.views,
            filesCount: s.files.length,
            totalBytes,
            hasPassword: !!s.security?.password,
            maxViews: s.security?.maxViews,
            url: appUrl ? `${appUrl}/share/${s.id}` : `/share/${s.id}`,
          };
        });

        return {
          shares,
          nextCursor,
          total,
        };
      },
      updateShare: async (params) => {
        const freshUser = await this.prisma.user.findUnique({
          where: { id: user.id },
        });
        if (!freshUser) throw new ForbiddenException("User not found");

        const share = await this.prisma.share.findUnique({
          where: { id: params.shareId },
          include: { security: true },
        });

        if (!share) {
          throw new NotFoundException(`Share '${params.shareId}' not found`);
        }
        if (share.creatorId !== freshUser.id) {
          throw new ForbiddenException("Cannot update a share owned by another user");
        }

        const updated = await this.shareService.update(
          params.shareId,
          {
            name: params.name,
            description: params.description,
            expiration: params.expiration,
            security:
              params.password !== undefined || params.maxViews !== undefined
                ? {
                    password: params.password,
                    maxViews: params.maxViews,
                  }
                : undefined,
          },
          freshUser,
          share,
        );

        return {
          id: updated.id,
          name: updated.name,
          description: updated.description,
          expiration: updated.expiration,
          hasPassword: !!updated.security?.password,
          maxViews: updated.security?.maxViews,
        };
      },
      revokeShare: async (shareId: string) => {
        const freshUser = await this.prisma.user.findUnique({
          where: { id: user.id },
        });
        if (!freshUser) throw new ForbiddenException("User not found");

        const share = await this.prisma.share.findUnique({
          where: { id: shareId },
        });

        if (!share) {
          throw new NotFoundException(`Share '${shareId}' not found`);
        }
        if (share.creatorId !== freshUser.id) {
          throw new ForbiddenException("Cannot revoke a share owned by another user");
        }

        // Idempotent immediate revocation: set expiration in the past and mark removedReason
        await this.prisma.share.update({
          where: { id: shareId },
          data: {
            expiration: new Date(Date.now() - 60000),
            removedReason: "revoked",
          },
        });

        return { success: true, shareId };
      },
      deleteShare: async (shareId: string) => {
        const freshUser = await this.prisma.user.findUnique({
          where: { id: user.id },
        });
        if (!freshUser) throw new ForbiddenException("User not found");

        const share = await this.prisma.share.findUnique({
          where: { id: shareId },
        });

        if (!share) {
          throw new NotFoundException(`Share '${shareId}' not found`);
        }
        if (share.creatorId !== freshUser.id) {
          throw new ForbiddenException("Cannot delete a share owned by another user");
        }

        this.pendingUploads.delete(shareId);
        await this.fileService.abortPendingUploads(shareId);
        await this.shareService.remove(shareId, false);

        return { success: true, shareId };
      },
      getUploadStatus: async (shareId: string) => {
        const freshUser = await this.prisma.user.findUnique({
          where: { id: user.id },
        });
        if (!freshUser) throw new ForbiddenException("User not found");

        const share = await this.prisma.share.findUnique({
          where: { id: shareId },
          select: { id: true, creatorId: true },
        });

        if (!share) {
          throw new NotFoundException(`Share '${shareId}' not found`);
        }
        if (share.creatorId !== freshUser.id) {
          throw new ForbiddenException("Cannot inspect upload status for a share owned by another user");
        }

        return this.fileService.getUploadStatus(shareId);
      },
    };

    const server = buildPingvinMcpServer(deps);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
    });

    await server.connect(transport);

    const session: McpSession = {
      sessionId,
      transport,
      server,
      userId: user.id,
      user,
      lastActive: Date.now(),
    };

    this.sessions.set(sessionId, session);
    return session;
  }
}
