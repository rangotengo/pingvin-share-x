import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import * as archiver from "archiver";
import * as crypto from "crypto";
import * as mime from "mime-types";
import { I18nService } from "nestjs-i18n";
import * as rangeParser from "range-parser";
import { Readable } from "stream";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";
import { byteToHumanSizeString } from "src/utils/fileSize.util";
import { getUserActiveStorageUsage } from "src/utils/storageQuota.util";
import { validate as isValidUUID } from "uuid";
import { DriveError, GoogleDriveClient } from "./google-drive.client";
import {
  assertDriveFileId,
  chunkBytes,
  classifyChunk,
  deletionTargets,
  expectedChunkIndex,
  planSlices,
  publicDriveStatus,
  redactSecrets,
} from "./google-drive.protocol";
import { File } from "./file.service";

const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class GoogleDriveFileService {
  private readonly logger = new Logger(GoogleDriveFileService.name);
  private readonly locks = new Map<string, Promise<unknown>>();
  private client: GoogleDriveClient | null = null;
  private clientKey = "";

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private readonly i18n: I18nService,
  ) {}

  status() {
    const appUrl = String(this.config.get("general.appUrl") || "")
      .trim()
      .replace(/\/$/, "");
    const creds = this.credentials();
    return publicDriveStatus({
      enabled: this.config.get("googledrive.enabled"),
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: creds.refreshToken,
      email: this.config.get("googledrive.connectedEmail") || "",
      folderId: this.config.get("googledrive.folderId") || "",
      folderName: this.config.get("googledrive.folderName") || "",
      redirectUri: `${appUrl}/api/admin/google-drive/callback`,
    });
  }

  authUrl(state: string) {
    this.assertConfigured();
    return this.getClient().authUrl(this.status().redirectUri, state);
  }

  async connect(code: string) {
    if (!this.configured()) throw new DriveError("not_configured");
    const client = this.getClient();
    const tokens = await client.exchangeCode(code, this.status().redirectUri);
    await this.config.setInternal(
      "googledrive.refreshToken",
      tokens.refreshToken,
    );
    this.client = null;
    const connected = this.getClient();
    const email = await connected.userEmail().catch(() => "");
    await this.config.setInternal("googledrive.connectedEmail", email || null);
    const folder = await this.ensureFolder(connected);
    return publicDriveStatus({
      enabled: this.config.get("googledrive.enabled"),
      clientId: this.config.get("googledrive.clientId") || "",
      clientSecret: this.config.get("googledrive.clientSecret") || "",
      refreshToken: tokens.refreshToken,
      email,
      folderId: folder.id,
      folderName: folder.name,
      redirectUri: this.status().redirectUri,
    });
  }

  async disconnect() {
    const refreshToken = this.config.get("googledrive.refreshToken");
    if (refreshToken && this.connected()) {
      await this.getClient()
        .revoke(refreshToken)
        .catch(() => undefined);
    }
    await this.config.setInternal("googledrive.refreshToken", null);
    await this.config.setInternal("googledrive.connectedEmail", null);
    this.client = null;
    return this.status();
  }

  async create(
    data: string | Buffer,
    chunk: { index: number; total: number },
    file: { id?: string; name: string },
    shareId: string,
  ) {
    if (!file.id) file.id = crypto.randomUUID();
    else if (!isValidUUID(file.id)) {
      throw new BadRequestException(this.i18n.t("file.invalidIdFormat"));
    }
    return this.withLock(file.id, () =>
      this.createLocked(data, chunk, file, shareId),
    );
  }

  async get(
    shareId: string,
    fileId: string,
    range?: { start: number; end?: number } | string,
  ): Promise<File> {
    const fileMetaData = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
    });
    if (!fileMetaData)
      throw new NotFoundException(this.i18n.t("file.notFound"));
    if (!fileMetaData.providerFileId) {
      throw new NotFoundException(this.i18n.t("file.notFound"));
    }

    const totalSize = parseInt(fileMetaData.size, 10);
    let activeRange: { start: number; end: number } | undefined;
    let isRangeNotSatisfiable = false;
    if (typeof range === "string") {
      const ranges = rangeParser(totalSize, range, { combine: true });
      if (ranges === -1) isRangeNotSatisfiable = true;
      else if (Array.isArray(ranges) && ranges.length > 0 && totalSize > 0) {
        activeRange = ranges[0];
      }
    } else if (range) {
      activeRange = { start: range.start, end: range.end ?? totalSize - 1 };
    }

    if (isRangeNotSatisfiable) {
      return {
        metaData: this.meta(fileMetaData),
        range: undefined,
        isRangeNotSatisfiable: true,
      };
    }

    const downloaded = await this.getClient().download(
      fileMetaData.providerFileId,
      activeRange,
    );
    if (downloaded.status === 416) {
      return {
        metaData: this.meta(fileMetaData),
        isRangeNotSatisfiable: true,
      };
    }
    const stream = downloaded.body
      ? Readable.fromWeb(downloaded.body as import("stream/web").ReadableStream)
      : Readable.from([]);
    return {
      metaData: this.meta(fileMetaData),
      file: stream,
      range: downloaded.status === 206 ? activeRange : undefined,
    };
  }

  async remove(shareId: string, fileId: string) {
    const fileMetaData = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
    });
    if (fileMetaData?.providerFileId) {
      await this.getClient().deleteFile(fileMetaData.providerFileId);
      await this.prisma.file.delete({ where: { id: fileId } });
      return;
    }
    const upload = await this.prisma.driveUpload.findUnique({
      where: { id: fileId },
    });
    if (!upload || upload.shareId !== shareId) {
      throw new NotFoundException(this.i18n.t("file.notFound"));
    }
    await this.prisma.driveUpload.delete({ where: { id: fileId } });
  }

  async deleteAllFiles(shareId: string) {
    const files = await this.prisma.file.findMany({
      where: { shareId },
      select: { providerFileId: true },
    });
    const ids = deletionTargets(files);
    const client = this.connected() ? this.getClient() : null;
    for (const id of ids) {
      if (!client) break;
      try {
        await client.deleteFile(id);
      } catch (error) {
        this.logger.warn(
          `Drive delete failed for ${id}: ${this.safeError(error)}`,
        );
      }
    }
    const uploads = await this.prisma.driveUpload.findMany({
      where: { shareId },
    });
    await this.cancelUploads(uploads);
    await this.prisma.driveUpload.deleteMany({ where: { shareId } });
  }

  async getZip(shareId: string): Promise<Readable> {
    const files = await this.prisma.file.findMany({ where: { shareId } });
    if (files.length === 0) {
      throw new NotFoundException(this.i18n.t("file.notFound"));
    }
    const archive = archiver("zip", {
      zlib: { level: parseInt(this.config.get("share.zipCompressionLevel")) },
    });
    archive.on("error", (err) => {
      this.logger.error(`Drive zip failed: ${this.safeError(err)}`);
    });
    void this.appendZip(archive, files);
    return archive;
  }

  async cleanupStaleUploads() {
    const cutoff = new Date(Date.now() - STALE_UPLOAD_MS);
    const stale = await this.prisma.driveUpload.findMany({
      where: { updatedAt: { lt: cutoff } },
    });
    await this.cancelUploads(stale);
    if (stale.length === 0) return 0;
    await this.prisma.driveUpload.deleteMany({
      where: { id: { in: stale.map((upload) => upload.id) } },
    });
    return stale.length;
  }

  private async cancelUploads(uploads: { sessionUri: string | null }[]) {
    if (!this.connected()) return;
    const client = this.getClient();
    for (const upload of uploads) {
      if (!upload.sessionUri) continue;
      await client.cancelSession(upload.sessionUri).catch(() => undefined);
    }
  }

  private async createLocked(
    data: string | Buffer,
    chunk: { index: number; total: number },
    file: { id?: string; name: string },
    shareId: string,
  ) {
    this.assertConnected();
    const buffer = chunkBytes(data);
    const isLast = chunk.index === chunk.total - 1;
    let upload = await this.prisma.driveUpload.findUnique({
      where: { id: file.id },
    });
    if (upload && upload.shareId !== shareId) {
      throw new BadRequestException(this.i18n.t("file.invalidIdFormat"));
    }

    const client = this.getClient();
    if (upload?.sessionUri) {
      const remote = await client
        .querySession(upload.sessionUri)
        .catch(() => null);
      if (remote?.complete && remote.fileId) {
        const size = remote.size ?? (await client.fileSize(remote.fileId));
        return this.finish(file, shareId, remote.fileId, size);
      }
      if (
        remote &&
        (remote.expired || (remote.bytes === 0 && upload.bytesSent > 0))
      ) {
        upload = await this.prisma.driveUpload.update({
          where: { id: file.id },
          data: { sessionUri: null, bytesSent: 0, remainder: null },
        });
      } else if (remote && remote.bytes > upload.bytesSent) {
        upload = await this.prisma.driveUpload.update({
          where: { id: file.id },
          data: { bytesSent: remote.bytes, remainder: null },
        });
      }
    }

    const remainder = upload?.remainder
      ? Buffer.from(upload.remainder)
      : Buffer.alloc(0);
    const accepted = (upload?.bytesSent || 0) + remainder.length;
    const chunkSize = this.config.get("share.chunkSize");
    const kind = classifyChunk({
      index: chunk.index,
      chunkSize,
      byteLength: buffer.length,
      accepted,
    });
    if (kind === "unexpected") {
      throw new BadRequestException({
        message: this.i18n.t("file.unexpectedChunk"),
        error: "unexpected_chunk_index",
        expectedChunkIndex: expectedChunkIndex(accepted, chunkSize),
      });
    }
    if (kind === "duplicate") return { id: file.id, name: file.name };

    const skip = Math.max(0, accepted - chunk.index * chunkSize);
    const incoming = buffer.subarray(skip);
    await this.assertCapacity(shareId, incoming.length, accepted);

    if (
      isLast &&
      accepted === 0 &&
      incoming.length === 0 &&
      remainder.length === 0
    ) {
      const folderId = await this.folderId();
      const driveId = await client.createEmptyFile(
        file.name,
        folderId,
        this.mime(file.name),
      );
      return this.finish(file, shareId, driveId, 0);
    }

    const planned = planSlices(remainder, incoming, isLast);
    let sessionUri = upload?.sessionUri || null;
    let bytesSent = upload?.bytesSent || 0;
    if (!sessionUri) {
      sessionUri = await client.startUpload(
        file.name,
        await this.folderId(),
        this.mime(file.name),
      );
    }
    if (!upload) {
      upload = await this.prisma.driveUpload.create({
        data: {
          id: file.id,
          shareId,
          name: file.name,
          sessionUri,
          bytesSent,
        },
      });
    } else if (upload.sessionUri !== sessionUri) {
      await this.prisma.driveUpload.update({
        where: { id: file.id },
        data: { sessionUri },
      });
    }

    let fileId: string | undefined;
    for (const slice of planned.slices) {
      const total = slice.final ? bytesSent + slice.body.length : null;
      const result = await client.uploadSlice(
        sessionUri,
        bytesSent,
        Buffer.from(slice.body),
        total,
      );
      bytesSent = result.next ?? bytesSent + slice.body.length;
      if (result.fileId) fileId = result.fileId;
    }

    if (fileId || (isLast && planned.slices.length === 0)) {
      if (!fileId)
        throw new InternalServerErrorException(
          this.i18n.t("file.driveUploadFailed"),
        );
      return this.finish(file, shareId, fileId, bytesSent);
    }

    await this.prisma.driveUpload.update({
      where: { id: file.id },
      data: {
        sessionUri,
        bytesSent,
        remainder: planned.remainder.length
          ? Buffer.from(planned.remainder)
          : null,
        name: file.name,
      },
    });
    return { id: file.id, name: file.name };
  }

  private async finish(
    file: { id?: string; name: string },
    shareId: string,
    driveFileId: string,
    size: number,
  ) {
    assertDriveFileId(driveFileId);
    await this.prisma.file.upsert({
      where: { id: file.id },
      update: {
        providerFileId: driveFileId,
        size: size.toString(),
        name: file.name,
      },
      create: {
        id: file.id,
        name: file.name,
        size: size.toString(),
        providerFileId: driveFileId,
        share: { connect: { id: shareId } },
      },
    });
    await this.prisma.driveUpload
      .delete({ where: { id: file.id } })
      .catch(() => {});
    return { id: file.id, name: file.name };
  }

  private async ensureFolder(client: GoogleDriveClient) {
    const existing = this.config.get("googledrive.folderId");
    const folder = existing
      ? await client.getFolder(existing)
      : await client.createFolder(
          this.config.get("googledrive.folderName") || "Pingvin Share",
        );
    await this.config.setInternal("googledrive.folderId", folder.id);
    await this.config.setInternal("googledrive.folderName", folder.name);
    return folder;
  }

  private async folderId() {
    const id = this.config.get("googledrive.folderId");
    if (!id)
      throw new BadRequestException(this.i18n.t("file.driveFolderInvalid"));
    return id;
  }

  private async assertCapacity(
    shareId: string,
    incoming: number,
    alreadyBuffered: number,
  ) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: {
        files: true,
        reverseShare: { include: { creator: true } },
        creator: true,
      },
    });
    if (!share) throw new NotFoundException(this.i18n.t("share.notFound"));
    if (share.uploadLocked) {
      throw new BadRequestException(this.i18n.t("file.alreadyCompleted"));
    }
    const fileSizeSum = share.files.reduce(
      (n, item) => n + parseInt(item.size),
      0,
    );
    const projected = fileSizeSum + alreadyBuffered + incoming;
    let limit = parseInt(this.config.get("share.maxSize"));
    if (share.reverseShare?.maxShareSize) {
      limit = parseInt(share.reverseShare.maxShareSize);
    } else if (share.creator?.shareSizeLimit) {
      limit = parseInt(share.creator.shareSizeLimit);
    }
    if (projected > limit) {
      throw new HttpException(
        this.i18n.t("file.maxSizeExceeded"),
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    const quotaOwner = share.reverseShare
      ? share.reverseShare.creator
      : share.creator;
    const quotaOwnerId = share.reverseShare
      ? share.reverseShare.creatorId
      : share.creatorId;
    if (quotaOwnerId && quotaOwner?.storageQuotaLimit) {
      const quotaLimit = parseInt(quotaOwner.storageQuotaLimit);
      const active = await getUserActiveStorageUsage(this.prisma, quotaOwnerId);
      if (active + alreadyBuffered + incoming > quotaLimit) {
        const exceededSize = byteToHumanSizeString(
          active + alreadyBuffered + incoming - quotaLimit,
        );
        throw new HttpException(
          share.reverseShare
            ? this.i18n.t("file.reverseShareQuotaExceeded", {
                args: { exceededSize },
              })
            : this.i18n.t("file.storageQuotaExceeded", {
                args: { exceededSize },
              }),
          HttpStatus.PAYLOAD_TOO_LARGE,
        );
      }
    }
  }

  private async appendZip(
    archive: archiver.Archiver,
    files: { name: string; providerFileId: string | null }[],
  ) {
    const client = this.getClient();
    try {
      for (const file of files) {
        if (!file.providerFileId) continue;
        const downloaded = await client.download(file.providerFileId);
        if (!downloaded.body) continue;
        const body = Readable.fromWeb(
          downloaded.body as import("stream/web").ReadableStream,
        );
        archive.append(body, { name: file.name });
        await new Promise((resolve, reject) => {
          body.on("end", resolve);
          body.on("error", reject);
        });
      }
      await archive.finalize();
    } catch (error) {
      archive.destroy(error as Error);
      this.logger.error(`Drive zip failed: ${this.safeError(error)}`);
    }
  }

  private meta(fileMetaData: {
    id: string;
    size: string;
    createdAt: Date;
    name: string;
    shareId: string;
  }) {
    return {
      mimeType: mime.contentType(fileMetaData.name.split(".").pop() || ""),
      ...fileMetaData,
    };
  }

  private mime(name: string) {
    return mime.lookup(name) || "application/octet-stream";
  }

  private credentials() {
    return {
      clientId: String(this.config.get("googledrive.clientId") || "").trim(),
      clientSecret: String(
        this.config.get("googledrive.clientSecret") || "",
      ).trim(),
      refreshToken: String(
        this.config.get("googledrive.refreshToken") || "",
      ).trim(),
    };
  }

  private configured() {
    const creds = this.credentials();
    return Boolean(creds.clientId && creds.clientSecret);
  }

  private assertConfigured() {
    if (!this.configured()) {
      throw new BadRequestException(this.i18n.t("file.driveNotConfigured"));
    }
  }

  private assertConnected() {
    this.assertConfigured();
    if (!this.credentials().refreshToken) {
      throw new BadRequestException(this.i18n.t("file.driveNotConnected"));
    }
  }

  private connected() {
    const creds = this.credentials();
    return Boolean(creds.clientId && creds.clientSecret && creds.refreshToken);
  }

  private getClient() {
    const creds = this.credentials();
    const key = [creds.clientId, creds.clientSecret, creds.refreshToken].join(
      "\n",
    );
    if (!this.client || this.clientKey !== key) {
      this.clientKey = key;
      this.client = new GoogleDriveClient(fetch, () => this.credentials());
    }
    return this.client;
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    this.locks.set(id, tail);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }

  private safeError(error: unknown) {
    return redactSecrets(
      error instanceof Error ? error.message : String(error),
    );
  }
}
