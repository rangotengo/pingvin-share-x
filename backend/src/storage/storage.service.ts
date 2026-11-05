import {
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigService } from "../config/config.service";
import { FileService } from "../file/file.service";
import { GoogleDriveFileService } from "../file/google-drive.service";
import { S3FileService } from "../file/s3.service";
import { SHARE_DIRECTORY } from "../constants";
import * as fs from "fs/promises";
import * as path from "path";
import checkDiskSpace from "check-disk-space";
import { HeadBucketCommand } from "@aws-sdk/client-s3";

export interface StorageDashboardSummary {
  defaultProvider: "LOCAL" | "S3" | "GOOGLE_DRIVE";
  providers: {
    LOCAL: {
      configured: boolean;
      enabled: boolean;
      connected: boolean;
      connectionError: string | null;
      sharesCount: number;
      filesCount: number;
      logicalBytes: number;
    };
    S3: {
      configured: boolean;
      enabled: boolean;
      connected: boolean;
      connectionError: string | null;
      sharesCount: number;
      filesCount: number;
      logicalBytes: number;
    };
    GOOGLE_DRIVE: {
      configured: boolean;
      enabled: boolean;
      connected: boolean;
      connectionError: string | null;
      connectedEmail: string | null;
      folderName: string | null;
      sharesCount: number;
      filesCount: number;
      logicalBytes: number;
      quota: {
        limit?: number;
        usage?: number;
        usageInDrive?: number;
      } | null;
    };
  };
  localDisk: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    persistentBytes: number;
    temporaryBytes: number;
    trackedLogicalQuota: number;
  };
  activeUploads: Array<{
    id: string;
    shareId: string;
    name: string;
    provider: string;
    committedBytes: number;
    totalChunks: number | null;
    expectedChunkIndex: number;
    updatedAt: Date;
    status: "active" | "interrupted" | "stale";
  }>;
  cleanupFailures: Array<{
    id: string;
    provider: string;
    shareId: string | null;
    fileId: string | null;
    targetId: string;
    action: string;
    error: string | null;
    attempts: number;
    createdAt: Date;
    lastAttemptAt: Date;
  }>;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private fileService: FileService,
    private googleDriveFileService: GoogleDriveFileService,
    private s3FileService: S3FileService,
  ) {}

  async getDashboardSummary(): Promise<StorageDashboardSummary> {
    const defaultProvider = this.fileService.resolveNewShareProvider();

    // 1. Providers aggregation from DB
    const [localShares, localFiles] = await Promise.all([
      this.prisma.share.count({ where: { storageProvider: "LOCAL" } }),
      this.prisma.file.findMany({
        where: { share: { storageProvider: "LOCAL" } },
        select: { size: true },
      }),
    ]);
    const localLogicalBytes = localFiles.reduce(
      (acc, f) => acc + (parseInt(f.size, 10) || 0),
      0,
    );

    const [s3Shares, s3Files] = await Promise.all([
      this.prisma.share.count({ where: { storageProvider: "S3" } }),
      this.prisma.file.findMany({
        where: { share: { storageProvider: "S3" } },
        select: { size: true },
      }),
    ]);
    const s3LogicalBytes = s3Files.reduce(
      (acc, f) => acc + (parseInt(f.size, 10) || 0),
      0,
    );

    const [driveShares, driveFiles] = await Promise.all([
      this.prisma.share.count({ where: { storageProvider: "GOOGLE_DRIVE" } }),
      this.prisma.file.findMany({
        where: { share: { storageProvider: "GOOGLE_DRIVE" } },
        select: { size: true },
      }),
    ]);
    const driveLogicalBytes = driveFiles.reduce(
      (acc, f) => acc + (parseInt(f.size, 10) || 0),
      0,
    );

    // 2. S3 status
    const s3Configured = Boolean(
      this.configService.get("s3.bucketName") &&
        this.configService.get("s3.endpoint") &&
        this.configService.get("s3.key"),
    );
    const s3Enabled = Boolean(this.configService.get("s3.enabled"));
    let s3Connected = false;
    let s3ConnectionError: string | null = null;
    if (s3Enabled && s3Configured) {
      try {
        const s3 = this.s3FileService.getS3Instance();
        await s3.send(
          new HeadBucketCommand({
            Bucket: this.configService.get("s3.bucketName"),
          }),
        );
        s3Connected = true;
      } catch (err: unknown) {
        s3Connected = false;
        const msg = err instanceof Error ? err.message : String(err);
        s3ConnectionError = msg.slice(0, 160);
      }
    }

    // 3. Drive status
    const driveStatus = this.googleDriveFileService.status();
    const driveQuota = await this.googleDriveFileService.storageQuota().catch(() => null);

    // 4. Local disk space
    let totalBytes = 0;
    let freeBytes = 0;
    let usedBytes = 0;
    try {
      const diskSpace = await checkDiskSpace(SHARE_DIRECTORY);
      totalBytes = diskSpace.size;
      freeBytes = diskSpace.free;
      usedBytes = diskSpace.size - diskSpace.free;
    } catch {
      // fallback
    }

    // Temporary bytes calculation (tmp-chunk and zip files)
    let temporaryBytes = 0;
    try {
      const entries = await fs.readdir(SHARE_DIRECTORY, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const shareSubDir = path.join(SHARE_DIRECTORY, entry.name);
          const subFiles = await fs.readdir(shareSubDir).catch(() => []);
          for (const sf of subFiles) {
            if (sf.endsWith(".tmp-chunk") || sf.endsWith(".zip")) {
              const stat = await fs.stat(path.join(shareSubDir, sf)).catch(() => null);
              if (stat) temporaryBytes += stat.size;
            }
          }
        }
      }
    } catch {
      // ignore
    }

    // 5. Active uploads from UploadSession
    const uploadSessions = await this.prisma.uploadSession.findMany({
      orderBy: { updatedAt: "desc" },
      take: 50,
    });

    const now = Date.now();
    const activeUploads = uploadSessions.map((u) => {
      const ageMs = now - u.updatedAt.getTime();
      let status: "active" | "interrupted" | "stale" = "active";
      if (ageMs > 24 * 60 * 60 * 1000) {
        status = "stale";
      } else if (ageMs > 5 * 60 * 1000) {
        status = "interrupted";
      }

      return {
        id: u.id,
        shareId: u.shareId,
        name: u.name,
        provider: u.storageProvider,
        committedBytes: u.committedBytes,
        totalChunks: u.totalChunks,
        expectedChunkIndex: u.expectedChunkIndex,
        updatedAt: u.updatedAt,
        status,
      };
    });

    // 6. Cleanup failures
    const cleanupFailures = await this.prisma.cleanupFailure.findMany({
      orderBy: { lastAttemptAt: "desc" },
      take: 50,
    });

    return {
      defaultProvider,
      providers: {
        LOCAL: {
          configured: true,
          enabled: true,
          connected: true,
          connectionError: null,
          sharesCount: localShares,
          filesCount: localFiles.length,
          logicalBytes: localLogicalBytes,
        },
        S3: {
          configured: s3Configured,
          enabled: s3Enabled,
          connected: s3Connected,
          connectionError: s3ConnectionError,
          sharesCount: s3Shares,
          filesCount: s3Files.length,
          logicalBytes: s3LogicalBytes,
        },
        GOOGLE_DRIVE: {
          configured: driveStatus.configured,
          enabled: driveStatus.enabled,
          connected: driveStatus.connected,
          connectionError: null,
          connectedEmail: driveStatus.email || null,
          folderName: driveStatus.folderName || null,
          sharesCount: driveShares,
          filesCount: driveFiles.length,
          logicalBytes: driveLogicalBytes,
          quota: driveQuota,
        },
      },
      localDisk: {
        totalBytes,
        freeBytes,
        usedBytes,
        persistentBytes: localLogicalBytes,
        temporaryBytes,
        trackedLogicalQuota: localLogicalBytes + s3LogicalBytes + driveLogicalBytes,
      },
      activeUploads,
      cleanupFailures,
    };
  }

  async retryCleanup(id: string): Promise<{ success: boolean; message: string }> {
    const item = await this.prisma.cleanupFailure.findUnique({ where: { id } });
    if (!item) throw new NotFoundException(`Cleanup failure item '${id}' not found`);

    try {
      if (item.provider === "LOCAL") {
        await fs.rm(item.targetId, { force: true, recursive: true }).catch(() => {});
      } else if (item.provider === "GOOGLE_DRIVE") {
        await this.googleDriveFileService.remove("", item.targetId);
      } else if (item.provider === "S3") {
        if (item.action === "abort_upload") {
          const [, uploadId] = item.targetId.split("::");
          if (uploadId && item.shareId) {
            await this.s3FileService.abortPreSignedUpload(item.shareId, item.fileId || "", uploadId);
          }
        } else if (item.shareId && item.fileId) {
          await this.s3FileService.remove(item.shareId, item.fileId);
        }
      }

      await this.prisma.cleanupFailure.delete({ where: { id } });
      return { success: true, message: "Cleanup completed successfully." };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.prisma.cleanupFailure.update({
        where: { id },
        data: {
          attempts: { increment: 1 },
          lastAttemptAt: new Date(),
          error: msg.slice(0, 200),
        },
      });
      return { success: false, message: `Retry failed: ${msg}` };
    }
  }

  async retryAllCleanups(): Promise<{ total: number; succeeded: number; failed: number }> {
    const items = await this.prisma.cleanupFailure.findMany();
    let succeeded = 0;
    let failed = 0;

    for (const item of items) {
      const res = await this.retryCleanup(item.id);
      if (res.success) succeeded++;
      else failed++;
    }

    return { total: items.length, succeeded, failed };
  }

  async dismissCleanup(id: string): Promise<void> {
    await this.prisma.cleanupFailure.deleteMany({ where: { id } });
  }

  async abortActiveUpload(fileId: string): Promise<void> {
    const session = await this.prisma.uploadSession.findUnique({
      where: { id: fileId },
    });
    if (!session) {
      throw new NotFoundException(`Upload session '${fileId}' not found`);
    }

    if (session.storageProvider === "LOCAL") {
      const tmpPath = `${SHARE_DIRECTORY}/${session.shareId}/${fileId}.tmp-chunk`;
      await fs.rm(tmpPath, { force: true }).catch(() => {});
    } else if (session.storageProvider === "S3") {
      const s3Upload = await this.prisma.s3Upload.findUnique({ where: { id: fileId } });
      if (s3Upload) {
        await this.s3FileService.abortPreSignedUpload(session.shareId, session.name, s3Upload.uploadId).catch(() => {});
      }
    } else if (session.storageProvider === "GOOGLE_DRIVE") {
      await this.googleDriveFileService.remove(session.shareId, fileId).catch(() => {});
    }

    await this.prisma.uploadSession.deleteMany({ where: { id: fileId } }).catch(() => {});
    await this.prisma.s3Upload.deleteMany({ where: { id: fileId } }).catch(() => {});
  }
}
