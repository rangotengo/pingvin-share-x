import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { createReadStream } from "fs";
import * as fs from "fs/promises";
import * as mime from "mime-types";
import { I18nService } from "nestjs-i18n";
import { resolve, sep } from "path";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";
import { byteToHumanSizeString } from "src/utils/fileSize.util";
import { getUserActiveStorageUsage } from "src/utils/storageQuota.util";
import { validate as isValidUUID } from "uuid";
import { SHARE_DIRECTORY } from "../constants";
import { Readable } from "stream";
import * as rangeParser from "range-parser";
import { isEnoent, isRecordMissing } from "./delete-plan";
import { File } from "./file.service";

@Injectable()
export class LocalFileService {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private readonly i18n: I18nService,
  ) {}

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) || Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, next);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === next) {
        this.locks.delete(key);
      }
    }
  }

  async create(
    data: string,
    chunk: { index: number; total: number },
    file: { id?: string; name: string },
    shareId: string,
  ) {
    if (!file.id) {
      file.id = crypto.randomUUID();
    } else if (!isValidUUID(file.id)) {
      throw new BadRequestException(this.i18n.t("file.invalidIdFormat"));
    }

    return this.withLock(file.id, () =>
      this.createLocked(data, chunk, file as { id: string; name: string }, shareId),
    );
  }

  private async createLocked(
    data: string,
    chunk: { index: number; total: number },
    file: { id: string; name: string },
    shareId: string,
  ) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: {
        files: true,
        reverseShare: { include: { creator: true } },
        creator: true,
      },
    });

    if (!share) {
      throw new NotFoundException(this.i18n.t("share.notFound"));
    }

    if (share.uploadLocked)
      throw new BadRequestException(this.i18n.t("file.alreadyCompleted"));

    const tmpPath = `${SHARE_DIRECTORY}/${shareId}/${file.id}.tmp-chunk`;
    let diskFileSize: number;
    try {
      diskFileSize = (await fs.stat(tmpPath)).size;
    } catch {
      diskFileSize = 0;
    }

    const chunkSize = this.config.get("share.chunkSize");
    // Handle mid-chunk crash recovery: align back to chunk boundary if interrupted
    if (chunk.index < chunk.total - 1 && diskFileSize % chunkSize !== 0) {
      const alignedSize = Math.floor(diskFileSize / chunkSize) * chunkSize;
      try {
        await fs.truncate(tmpPath, alignedSize);
        diskFileSize = alignedSize;
      } catch {
        // file might not exist or already cleaned
      }
    }

    const expectedChunkIndex = Math.floor(diskFileSize / chunkSize);
    const buffer = Buffer.from(data, "base64");

    // Handle replay under lost ACK: duplicate chunk already committed
    if (chunk.index < expectedChunkIndex) {
      // Validate that the existing file bytes at this chunk offset match to reject file change mid-upload
      try {
        const fd = await fs.open(tmpPath, "r");
        try {
          const checkBuffer = Buffer.alloc(buffer.byteLength);
          const readResult = await fd.read(checkBuffer, 0, buffer.byteLength, chunk.index * chunkSize);
          if (
            readResult.bytesRead === buffer.byteLength &&
            !checkBuffer.equals(buffer)
          ) {
            throw new BadRequestException(
              "File content changed mid-upload; resume collision rejected.",
            );
          }
        } finally {
          await fd.close();
        }
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
      }
      return file;
    }

    if (expectedChunkIndex !== chunk.index) {
      throw new BadRequestException({
        message: this.i18n.t("file.unexpectedChunk"),
        error: "unexpected_chunk_index",
        expectedChunkIndex,
      });
    }

    // Check if there is enough space on the server
    const space = await fs.statfs(SHARE_DIRECTORY);
    const availableSpace = space.bavail * space.bsize;
    if (availableSpace < buffer.byteLength) {
      throw new InternalServerErrorException(
        this.i18n.t("file.notEnoughSpace"),
      );
    }

    // Check if share size limit is exceeded
    const fileSizeSum = share.files.reduce(
      (n, { size }) => n + parseInt(size),
      0,
    );

    const shareSizeSum = fileSizeSum + diskFileSize + buffer.byteLength;

    let limit = parseInt(this.config.get("share.maxSize"));
    if (share.reverseShare?.maxShareSize) {
      limit = parseInt(share.reverseShare.maxShareSize);
    } else if (share.creator?.shareSizeLimit) {
      limit = parseInt(share.creator.shareSizeLimit);
    }

    if (shareSizeSum > limit) {
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
      const activeStorageUsage = await getUserActiveStorageUsage(
        this.prisma,
        quotaOwnerId,
      );
      const projectedUsage =
        activeStorageUsage + diskFileSize + buffer.byteLength;

      if (projectedUsage > quotaLimit) {
        const exceededBytes = projectedUsage - quotaLimit;
        const exceededSize = byteToHumanSizeString(exceededBytes);
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

    await fs.mkdir(`${SHARE_DIRECTORY}/${shareId}`, { recursive: true });
    await fs.appendFile(tmpPath, buffer);

    const isLastChunk = chunk.index == chunk.total - 1;
    if (isLastChunk) {
      await fs.rename(
        tmpPath,
        `${SHARE_DIRECTORY}/${shareId}/${file.id}`,
      );
      const fileSize = (
        await fs.stat(`${SHARE_DIRECTORY}/${shareId}/${file.id}`)
      ).size;
      await this.prisma.file.create({
        data: {
          id: file.id,
          name: file.name,
          size: fileSize.toString(),
          share: { connect: { id: shareId } },
        },
      });
      await this.prisma.uploadSession.deleteMany({
        where: { id: file.id },
      });
    } else {
      await this.prisma.uploadSession.upsert({
        where: { id: file.id },
        create: {
          id: file.id,
          shareId,
          name: file.name,
          storageProvider: "LOCAL",
          totalChunks: chunk.total,
          expectedChunkIndex: chunk.index + 1,
          committedBytes: diskFileSize + buffer.byteLength,
        },
        update: {
          expectedChunkIndex: chunk.index + 1,
          committedBytes: diskFileSize + buffer.byteLength,
          totalChunks: chunk.total,
        },
      });
    }

    return file;
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

    const totalSize = parseInt(fileMetaData.size, 10);
    let activeRange: { start: number; end: number } | undefined;
    let isRangeNotSatisfiable = false;

    if (typeof range === "string") {
      const ranges = rangeParser(totalSize, range, { combine: true });
      if (ranges === -1) {
        isRangeNotSatisfiable = true;
      } else if (Array.isArray(ranges) && ranges.length > 0 && totalSize > 0) {
        activeRange = ranges[0];
      }
    } else if (range && typeof range === "object") {
      activeRange = {
        start: range.start,
        end: range.end ?? totalSize - 1,
      };
    }

    const filePath = this.getSafeFilePath(shareId, fileId);

    const file = isRangeNotSatisfiable
      ? undefined
      : createReadStream(
          filePath,
          activeRange
            ? { start: activeRange.start, end: activeRange.end }
            : undefined,
        );

    return {
      metaData: {
        mimeType: mime.contentType(fileMetaData.name.split(".").pop()),
        ...fileMetaData,
        size: fileMetaData.size,
      },
      file,
      range: activeRange,
      isRangeNotSatisfiable,
    };
  }

  async remove(shareId: string, fileId: string) {
    const fileMetaData = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
    });
    const filePath = this.getSafeFilePath(shareId, fileId);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (!isEnoent(error)) {
        await this.prisma.cleanupFailure.create({
          data: {
            provider: "LOCAL",
            shareId,
            fileId,
            targetId: filePath,
            action: "delete_file",
            error: (error as Error).message || String(error),
          },
        }).catch(() => {});
        throw error;
      }
    }
    // Also clean up any pending tmp-chunk
    try {
      await fs.unlink(`${SHARE_DIRECTORY}/${shareId}/${fileId}.tmp-chunk`);
    } catch {
      // ignore
    }
    await this.prisma.uploadSession.deleteMany({ where: { id: fileId } }).catch(() => {});

    if (!fileMetaData) return;
    await this.prisma.file.delete({ where: { id: fileId } }).catch((error) => {
      if (!isRecordMissing(error)) throw error;
    });
  }

  private getSafeFilePath(shareId: string, fileId: string): string {
    const baseDir = resolve(SHARE_DIRECTORY, shareId);
    const resolvedPath = resolve(baseDir, fileId);

    if (!resolvedPath.startsWith(baseDir + sep)) {
      throw new BadRequestException(this.i18n.t("file.invalidIdFormat"));
    }

    return resolvedPath;
  }

  async deleteAllFiles(shareId: string) {
    const dir = `${SHARE_DIRECTORY}/${shareId}`;
    try {
      await fs.rm(dir, {
        recursive: true,
        force: true,
      });
    } catch (error) {
      await this.prisma.cleanupFailure.create({
        data: {
          provider: "LOCAL",
          shareId,
          targetId: dir,
          action: "delete_folder",
          error: (error as Error).message || String(error),
        },
      }).catch(() => {});
    }
    await this.prisma.uploadSession.deleteMany({ where: { shareId } }).catch(() => {});
  }

  async getZip(shareId: string): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const zipStream = createReadStream(
        `${SHARE_DIRECTORY}/${shareId}/archive.zip`,
      );

      zipStream.on("error", (err) => {
        reject(new InternalServerErrorException(err));
      });

      zipStream.on("open", () => {
        resolve(zipStream);
      });
    });
  }
}
