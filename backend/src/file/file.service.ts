import {
  Inject,
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Cache } from "cache-manager";
import { selectNewShareProvider } from "./google-drive.protocol";
import { GoogleDriveFileService } from "./google-drive.service";
import { LocalFileService } from "./local.service";
import { S3FileService } from "./s3.service";
import { ConfigService } from "src/config/config.service";
import { Readable } from "stream";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "src/email/email.service";
import { I18nService } from "nestjs-i18n";
import * as fs from "node:fs";
import { SHARE_DIRECTORY } from "../constants";

const UPDATED_AT_THROTTLE_MS = 5 * 60 * 1000;
const DOWNLOAD_NOTIFICATION_COOLDOWN_MS = 15 * 60 * 1000;

@Injectable()
export class FileService {
  constructor(
    private prisma: PrismaService,
    private localFileService: LocalFileService,
    private s3FileService: S3FileService,
    private googleDriveFileService: GoogleDriveFileService,
    private configService: ConfigService,
    private emailService: EmailService,
    private readonly i18n: I18nService,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {}
  private readonly logger = new Logger(FileService.name);

  // Determine which service to use based on the current config value
  // shareId is optional -> can be used to overwrite a storage provider
  private getStorageService(
    storageProvider?: string,
  ): S3FileService | LocalFileService | GoogleDriveFileService {
    const provider = storageProvider ?? this.resolveNewShareProvider();
    if (provider === "S3") return this.s3FileService;
    if (provider === "GOOGLE_DRIVE") return this.googleDriveFileService;
    return this.localFileService;
  }

  resolveNewShareProvider(): "LOCAL" | "S3" | "GOOGLE_DRIVE" {
    try {
      return selectNewShareProvider(
        Boolean(this.configService.get("googledrive.enabled")),
        Boolean(this.configService.get("s3.enabled")),
      );
    } catch {
      throw new BadRequestException(this.i18n.t("file.driveAndS3"));
    }
  }

  cleanupStaleDriveUploads() {
    return this.googleDriveFileService.cleanupStaleUploads();
  }

  async create(
    data: string,
    chunk: { index: number; total: number },
    file: {
      id?: string;
      name: string;
    },
    shareId: string,
  ) {
    await this.touchShare(shareId);
    const share = await this.prisma.share.findFirst({
      where: { id: shareId },
      select: { storageProvider: true },
    });
    const storageService = this.getStorageService(
      share?.storageProvider || this.resolveNewShareProvider(),
    );
    return storageService.create(data, chunk, file, shareId);
  }

  private async touchShare(shareId: string) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      select: { updatedAt: true },
    });
    if (!share) return;
    if (
      share.updatedAt &&
      Date.now() - share.updatedAt.getTime() < UPDATED_AT_THROTTLE_MS
    )
      return;
    await this.prisma.share.update({
      where: { id: shareId },
      data: { updatedAt: new Date() },
    });
  }

  async createPreSignedUploadUrls(
    shareId: string,
    fileName: string,
    totalChunks: number,
  ) {
    await this.touchShare(shareId);
    const share = await this.prisma.share.findFirst({
      where: { id: shareId },
      select: { storageProvider: true },
    });
    if (share?.storageProvider !== "S3") {
      return { directToS3: false };
    }
    const res = await this.s3FileService.createPreSignedUploadUrls(
      shareId,
      fileName,
      totalChunks,
    );
    return { directToS3: true, ...res };
  }

  async completePreSignedUpload(
    shareId: string,
    fileId: string,
    fileName: string,
    uploadId: string,
    parts: Array<{ ETag: string; PartNumber: number }>,
  ) {
    await this.touchShare(shareId);
    const share = await this.prisma.share.findFirst({
      where: { id: shareId },
      select: { storageProvider: true },
    });
    if (share?.storageProvider !== "S3") {
      throw new BadRequestException(this.i18n.t("file.s3NotSupported"));
    }
    return this.s3FileService.completePreSignedUpload(
      shareId,
      fileId,
      fileName,
      uploadId,
      parts,
    );
  }

  async abortPreSignedUpload(
    shareId: string,
    fileName: string,
    uploadId: string,
  ) {
    const share = await this.prisma.share.findFirst({
      where: { id: shareId },
      select: { storageProvider: true },
    });
    if (share?.storageProvider !== "S3") {
      throw new BadRequestException(this.i18n.t("file.s3NotSupported"));
    }
    return this.s3FileService.abortPreSignedUpload(shareId, fileName, uploadId);
  }

  async getPreSignedDownloadUrl(
    shareId: string,
    fileId: string,
    isDownload: boolean,
  ): Promise<string> {
    const share = await this.prisma.share.findFirst({
      where: { id: shareId },
      select: { storageProvider: true },
    });
    if (share?.storageProvider !== "S3") {
      throw new BadRequestException(this.i18n.t("file.s3NotSupported"));
    }
    return this.s3FileService.getPreSignedDownloadUrl(
      shareId,
      fileId,
      isDownload,
    );
  }

  async get(
    shareId: string,
    fileId: string,
    range?: { start: number; end?: number } | string,
  ): Promise<File> {
    const share = await this.prisma.share.findFirst({
      where: { id: shareId },
    });
    const storageService = this.getStorageService(share?.storageProvider);
    return storageService.get(shareId, fileId, range);
  }

  async remove(shareId: string, fileId: string) {
    const share = await this.prisma.share.findFirst({
      where: { id: shareId },
      select: { storageProvider: true },
    });
    const storageService = this.getStorageService(share?.storageProvider);
    return storageService.remove(shareId, fileId);
  }

  async deleteAllFiles(shareId: string) {
    const share = await this.prisma.share.findFirst({
      where: { id: shareId },
      select: { id: true, storageProvider: true },
    });
    const storageService = this.getStorageService(share?.storageProvider);
    return storageService.deleteAllFiles(shareId);
  }

  async getZip(shareId: string): Promise<Readable> {
    const share = await this.prisma.share.findFirst({
      where: { id: shareId },
      select: { storageProvider: true },
    });
    const storageService = this.getStorageService(share?.storageProvider);
    return await storageService.getZip(shareId);
  }

  async notifyRecipientDownload(
    shareId: string,
    fileName: string,
    recipientId?: string,
  ) {
    try {
      if (
        !recipientId ||
        !this.configService.get("smtp.enabled") ||
        !this.configService.get("share.enableShareEmailRecipients") ||
        !this.configService.get("share.enableShareDownloadNotifications")
      )
        return;

      const notificationKey = `share-download-notification:${shareId}:${recipientId}`;
      if (await this.cache.get<true>(notificationKey)) return;

      const share = await this.prisma.share.findUnique({
        where: { id: shareId },
        select: {
          id: true,
          creator: {
            select: { email: true, username: true, displayName: true },
          },
          recipients: {
            where: { id: recipientId },
            select: { email: true },
          },
        },
      });

      const recipient = share?.recipients[0];
      if (!share?.creator?.email || !recipient) return;

      const recipientUser = await this.prisma.user.findUnique({
        where: { email: recipient.email },
        select: { displayName: true, username: true },
      });

      await this.cache.set(
        notificationKey,
        true,
        DOWNLOAD_NOTIFICATION_COOLDOWN_MS,
      );

      await this.emailService.sendShareDownloadNotification(
        share.creator.email,
        share.id,
        fileName,
        recipient.email,
        share.creator?.displayName || share.creator?.username,
        recipientUser?.displayName || recipientUser?.username,
      );
    } catch (e) {
      this.logger.error(
        `Failed to notify recipient download for share ${shareId}`,
        e instanceof Error ? e.stack : String(e),
      );
    }
  }

  async getStorageProvider(shareId: string): Promise<string> {
    const share = await this.prisma.share.findFirst({
      where: { id: shareId },
      select: { storageProvider: true },
    });
    return share?.storageProvider || "LOCAL";
  }

  async getFileName(shareId: string, fileId: string): Promise<string> {
    const file = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
      select: { name: true },
    });
    if (!file) throw new NotFoundException(this.i18n.t("file.notFound"));
    return file.name;
  }

  private async streamToUint8Array(stream: Readable): Promise<Uint8Array> {
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
      stream.on("error", reject);
    });
  }

  async hasPendingUploads(shareId: string): Promise<boolean> {
    const uploadSessionCount = await this.prisma.uploadSession.count({
      where: { shareId },
    });
    if (uploadSessionCount > 0) return true;

    const shareDir = `${SHARE_DIRECTORY}/${shareId}`;
    try {
      if (fs.existsSync(shareDir)) {
        const files = await fs.promises.readdir(shareDir);
        if (files.some((f) => f.endsWith(".tmp-chunk"))) {
          return true;
        }
      }
    } catch {
      // Ignore
    }

    if (await this.s3FileService.hasPendingUploads(shareId)) {
      return true;
    }

    const driveUploadCount = await this.prisma.driveUpload.count({
      where: { shareId },
    });
    if (driveUploadCount > 0) {
      return true;
    }

    return false;
  }

  async abortPendingUploads(shareId: string): Promise<void> {
    const shareDir = `${SHARE_DIRECTORY}/${shareId}`;
    try {
      if (fs.existsSync(shareDir)) {
        const files = await fs.promises.readdir(shareDir);
        for (const file of files) {
          if (file.endsWith(".tmp-chunk")) {
            await fs.promises.rm(`${shareDir}/${file}`, { force: true }).catch(() => {});
          }
        }
      }
    } catch {
      // Ignore
    }

    await this.s3FileService.abortShareMultipartUploads(shareId).catch(() => {});

    const driveUploads = await this.prisma.driveUpload.findMany({
      where: { shareId },
      select: { sessionUri: true },
    });
    if (driveUploads.length > 0) {
      await this.googleDriveFileService.cleanupStaleUploads().catch(() => {});
      await this.prisma.driveUpload.deleteMany({ where: { shareId } }).catch(() => {});
    }

    await this.prisma.uploadSession.deleteMany({ where: { shareId } }).catch(() => {});
  }

  async getUploadStatus(shareId: string) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: { files: true },
    });
    if (!share) {
      throw new NotFoundException(`Share '${shareId}' not found`);
    }

    const chunkSize = parseInt(
      this.configService.get("share.chunkSize") || "52428800",
      10,
    );

    const pendingUploads = await this.prisma.uploadSession.findMany({
      where: { shareId },
      orderBy: { createdAt: "asc" },
    });

    const pendingFiles = pendingUploads.map((u) => ({
      id: u.id,
      name: u.name,
      storageProvider: u.storageProvider,
      totalChunks: u.totalChunks,
      expectedChunkIndex: u.expectedChunkIndex,
      committedBytes: u.committedBytes,
      updatedAt: u.updatedAt,
    }));

    const files = share.files.map((f) => ({
      id: f.id,
      name: f.name,
      size: f.size,
    }));

    const hasPending = (await this.hasPendingUploads(shareId)) || pendingFiles.length > 0;
    const canComplete = !share.uploadLocked && files.length > 0 && !hasPending;

    return {
      shareId: share.id,
      storageProvider: share.storageProvider,
      isCompleted: share.uploadLocked,
      chunkSize,
      files,
      pendingFiles,
      canComplete,
    };
  }
}

export interface File {
  metaData: {
    id: string;
    size: string;
    createdAt: Date;
    mimeType: string | false;
    name: string;
    shareId: string;
  };
  file?: Readable;
  range?: { start: number; end: number };
  isRangeNotSatisfiable?: boolean;
}
