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
  lastActive: number;
}

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private sessions = new Map<string, McpSession>();

  constructor(
    private prisma: PrismaService,
    private shareService: ShareService,
    private fileService: FileService,
    private configService: ConfigService,
  ) {
    setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000).unref();
  }

  getSession(sessionId: string): McpSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActive = Date.now();
    }
    return session;
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

  private cleanupExpiredSessions() {
    const now = Date.now();
    const timeout = 30 * 60 * 1000;
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActive > timeout) {
        this.logger.debug(`Cleaning up idle MCP session ${id}`);
        void session.transport.close().catch(() => {});
        this.sessions.delete(id);
      }
    }
  }

  async createSession(user: User): Promise<McpSession> {
    const sessionId = crypto.randomUUID();

    const deps: McpServerDependencies = {
      user: {
        id: user.id,
        username: user.username,
        allowShare: user.allowShare,
        shareSizeLimit: user.shareSizeLimit,
      },
      getAppUrl: () => {
        const configured = this.configService.get("general.appUrl");
        return (configured || "").trim();
      },
      getChunkSize: () => {
        return parseInt(
          this.configService.get("share.chunkSize") || "52428800",
          10,
        );
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
          user,
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

        const res = await this.fileService.create(
          params.data as any,
          { index: params.chunkIndex, total: params.totalChunks },
          { id: params.fileId, name: params.name },
          params.shareId,
        );

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

        const completed = await this.shareService.complete(shareId);
        void this.shareService.createZip(shareId);

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

        if (!share.uploadLocked) {
          await this.shareService.remove(shareId, false);
        }
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
      lastActive: Date.now(),
    };

    this.sessions.set(sessionId, session);
    return session;
  }
}
