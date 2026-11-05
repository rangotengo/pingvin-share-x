import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  UploadPartCommand,
  UploadPartCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as contentDisposition from "content-disposition";
import { PrismaService } from "src/prisma/prisma.service";
import { ConfigService } from "src/config/config.service";
import { I18nService } from "nestjs-i18n";
import * as crypto from "crypto";
import * as mime from "mime-types";
import { byteToHumanSizeString } from "src/utils/fileSize.util";
import { getUserActiveStorageUsage } from "src/utils/storageQuota.util";
import {
  isMissingObject,
  isMissingObjectCode,
  isRecordMissing,
} from "./delete-plan";
import { File } from "./file.service";
import { Readable } from "stream";
import { validate as isValidUUID } from "uuid";
import * as archiver from "archiver";

@Injectable()
export class S3FileService {
  private readonly logger = new Logger(S3FileService.name);

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
    const buffer = Buffer.from(data, "base64");
    const key = `${this.getS3Path()}${shareId}/${file.name}`;
    const bucketName = this.config.get("s3.bucketName");
    const s3Instance = this.getS3Instance();
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: {
        creator: true,
        reverseShare: { include: { creator: true } },
      },
    });

    let s3Upload = await this.prisma.s3Upload.findUnique({
      where: { id: file.id },
    });

    try {
      if (!s3Upload) {
        const multipartInitResponse = await s3Instance.send(
          new CreateMultipartUploadCommand({
            Bucket: bucketName,
            Key: key,
          }),
        );

        const uploadId = multipartInitResponse.UploadId;
        if (!uploadId) {
          throw new Error(this.i18n.t("file.s3UploadInitError"));
        }

        s3Upload = await this.prisma.s3Upload.create({
          data: {
            id: file.id,
            shareId,
            name: file.name,
            uploadId,
            parts: "[]",
            uploadedBytes: 0,
          },
        });
      }

      let parts: Array<{ ETag: string; PartNumber: number }> = [];
      try {
        parts = JSON.parse(s3Upload.parts);
      } catch {
        parts = [];
      }

      const partNumber = chunk.index + 1;
      const existingPart = parts.find((p) => p.PartNumber === partNumber);
      if (existingPart) {
        return file;
      }

      const quotaOwner = share?.reverseShare
        ? share.reverseShare.creator
        : share?.creator;
      const quotaOwnerId = share?.reverseShare
        ? share.reverseShare.creatorId
        : share?.creatorId;

      if (quotaOwnerId && quotaOwner?.storageQuotaLimit) {
        const quotaLimit = parseInt(quotaOwner.storageQuotaLimit);
        const activeStorageUsage = await getUserActiveStorageUsage(
          this.prisma,
          quotaOwnerId,
        );
        const projectedUsage =
          activeStorageUsage +
          s3Upload.uploadedBytes +
          buffer.byteLength;

        if (projectedUsage > quotaLimit) {
          const exceededBytes = projectedUsage - quotaLimit;
          const exceededSize = byteToHumanSizeString(exceededBytes);
          throw new BadRequestException(
            share?.reverseShare
              ? this.i18n.t("file.reverseShareQuotaExceeded", {
                  args: { exceededSize },
                })
              : this.i18n.t("file.storageQuotaExceeded", {
                  args: { exceededSize },
                }),
          );
        }
      }

      if (
        chunk.index < chunk.total - 1 &&
        buffer.byteLength < 5 * 1024 * 1024
      ) {
        throw new BadRequestException(
          "S3 multipart non-final chunk must be at least 5MB",
        );
      }

      const uploadPartResponse: UploadPartCommandOutput = await s3Instance.send(
        new UploadPartCommand({
          Bucket: bucketName,
          Key: key,
          PartNumber: partNumber,
          UploadId: s3Upload.uploadId,
          Body: buffer,
        }),
      );

      parts.push({
        ETag: uploadPartResponse.ETag!,
        PartNumber: partNumber,
      });
      parts.sort((a, b) => a.PartNumber - b.PartNumber);
      const newUploadedBytes = s3Upload.uploadedBytes + buffer.byteLength;

      await this.prisma.s3Upload.update({
        where: { id: file.id },
        data: {
          parts: JSON.stringify(parts),
          uploadedBytes: newUploadedBytes,
        },
      });

      await this.prisma.uploadSession.upsert({
        where: { id: file.id },
        create: {
          id: file.id,
          shareId,
          name: file.name,
          storageProvider: "S3",
          totalChunks: chunk.total,
          expectedChunkIndex: chunk.index + 1,
          committedBytes: newUploadedBytes,
        },
        update: {
          expectedChunkIndex: chunk.index + 1,
          committedBytes: newUploadedBytes,
          totalChunks: chunk.total,
        },
      });

      if (chunk.index === chunk.total - 1) {
        await s3Instance.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucketName,
            Key: key,
            UploadId: s3Upload.uploadId,
            MultipartUpload: {
              Parts: parts,
            },
          }),
        );

        await this.prisma.s3Upload.deleteMany({ where: { id: file.id } }).catch(() => {});
        await this.prisma.uploadSession.deleteMany({ where: { id: file.id } }).catch(() => {});
      }
    } catch (error) {
      if (s3Upload && !(error instanceof BadRequestException) && !(error instanceof HttpException)) {
        try {
          await s3Instance.send(
            new AbortMultipartUploadCommand({
              Bucket: bucketName,
              Key: key,
              UploadId: s3Upload.uploadId,
            }),
          );
          await this.prisma.s3Upload.deleteMany({ where: { id: file.id } }).catch(() => {});
          await this.prisma.uploadSession.deleteMany({ where: { id: file.id } }).catch(() => {});
        } catch (abortError) {
          await this.prisma.cleanupFailure.create({
            data: {
              provider: "S3",
              shareId,
              fileId: file.id,
              targetId: `${key}::${s3Upload.uploadId}`,
              action: "abort_upload",
              error: (abortError as Error).message || String(abortError),
            },
          }).catch(() => {});
        }
      }
      this.logger.error(error);
      if (error instanceof HttpException) throw error;
      throw new Error(this.i18n.t("file.s3UploadFailed"));
    }

    const isLastChunk = chunk.index == chunk.total - 1;
    if (isLastChunk) {
      const fileSize: number = await this.getFileSize(shareId, file.name);

      await this.prisma.file.create({
        data: {
          id: file.id,
          name: file.name,
          size: fileSize.toString(),
          share: { connect: { id: shareId } },
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
    const file = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
    });

    if (!file) throw new NotFoundException(this.i18n.t("file.notFound"));

    const fileName = file.name;

    let rangeString: string | undefined;
    if (typeof range === "string") {
      rangeString = range;
    } else if (range && typeof range === "object") {
      rangeString = `bytes=${range.start}-${range.end ?? ""}`;
    }

    const s3Instance = this.getS3Instance();
    const key = `${this.getS3Path()}${shareId}/${fileName}`;
    const response = await s3Instance.send(
      new GetObjectCommand({
        Bucket: this.config.get("s3.bucketName"),
        Key: key,
        Range: rangeString,
      }),
    );

    return {
      metaData: {
        id: fileId,
        size: response.ContentLength?.toString() || "0",
        name: fileName,
        shareId: shareId,
        createdAt: response.LastModified || new Date(),
        mimeType:
          mime.contentType(fileId.split(".").pop()) ||
          "application/octet-stream",
      },
      file: response.Body as Readable,
    } as File;
  }

  async remove(shareId: string, fileId: string) {
    const fileMetaData = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
    });
    if (!fileMetaData) return;

    const key = `${this.getS3Path()}${shareId}/${fileMetaData.name}`;
    const s3Instance = this.getS3Instance();

    try {
      await s3Instance.send(
        new DeleteObjectCommand({
          Bucket: this.config.get("s3.bucketName"),
          Key: key,
        }),
      );
    } catch (error) {
      if (!isMissingObject(error)) {
        await this.prisma.cleanupFailure.create({
          data: {
            provider: "S3",
            shareId,
            fileId,
            targetId: key,
            action: "delete_file",
            error: (error as Error).message || String(error),
          },
        }).catch(() => {});
        throw new Error(this.i18n.t("file.s3DeleteError"));
      }
    }

    await this.prisma.file.delete({ where: { id: fileId } }).catch((error) => {
      if (!isRecordMissing(error)) throw error;
    });
  }

  async deleteAllFiles(shareId: string) {
    const prefix = `${this.getS3Path()}${shareId}/`;
    const s3Instance = this.getS3Instance();
    const bucketName = this.config.get("s3.bucketName");

    const fallbackDeleteByDb = async (reason: string) => {
      const files = await this.prisma.file.findMany({
        where: { shareId },
        select: { name: true },
      });
      void reason;

      for (const f of files) {
        const key = `${this.getS3Path()}${shareId}/${f.name}`;
        try {
          await s3Instance.send(
            new DeleteObjectCommand({
              Bucket: bucketName,
              Key: key,
            }),
          );
        } catch (error) {
          if (!isMissingObject(error)) {
            throw new Error(this.i18n.t("file.s3DeleteError"));
          }
        }
      }
    };

    try {
      // List all objects under the given prefix
      const listResponse = await s3Instance.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: prefix,
        }),
      );

      if (!listResponse.Contents || listResponse.Contents.length === 0) {
        return;
      }

      // Extract the keys of the files to be deleted
      const objectsToDelete = listResponse.Contents.map((file) => ({
        Key: file.Key!,
      }));

      // Delete all files in a single request (up to 1000 objects at once)
      const deleted = await s3Instance.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: {
            Objects: objectsToDelete,
          },
        }),
      );
      const failed = (deleted.Errors || []).filter(
        (item) => !isMissingObjectCode(item.Code),
      );
      if (failed.length > 0) {
        throw new Error(this.i18n.t("file.s3DeleteError"));
      }
    } catch (error) {
      if (isMissingObject(error)) return;
      if (
        error instanceof Error &&
        error.message === this.i18n.t("file.s3DeleteError")
      ) {
        throw error;
      }
      await fallbackDeleteByDb("list_or_bulk_delete_failed");
    }
  }

  async getFileSize(shareId: string, fileName: string): Promise<number> {
    const key = `${this.getS3Path()}${shareId}/${fileName}`;
    const s3Instance = this.getS3Instance();

    try {
      // Get metadata of the file using HeadObjectCommand
      const headObjectResponse = await s3Instance.send(
        new HeadObjectCommand({
          Bucket: this.config.get("s3.bucketName"),
          Key: key,
        }),
      );

      // Return ContentLength which is the file size in bytes
      return headObjectResponse.ContentLength ?? 0;
    } catch {
      throw new Error(this.i18n.t("file.s3SizeError"));
    }
  }

  getS3Instance(): S3Client {
    const checksumCalculation =
      this.config.get("s3.useChecksum") === true ? null : "WHEN_REQUIRED";

    return new S3Client({
      endpoint: this.config.get("s3.endpoint"),
      region: this.config.get("s3.region"),
      credentials: {
        accessKeyId: this.config.get("s3.key"),
        secretAccessKey: this.config.get("s3.secret"),
      },
      forcePathStyle: true,
      requestChecksumCalculation: checksumCalculation,
      responseChecksumValidation: checksumCalculation,
    });
  }

  async getZip(shareId: string) {
    const files = await this.prisma.file.findMany({
      where: { shareId },
    });

    if (files.length === 0) {
      throw new NotFoundException(`No files found for share ${shareId}`);
    }

    const s3Instance = this.getS3Instance();
    const bucketName = this.config.get("s3.bucketName");
    const compressionLevel = this.config.get("share.zipCompressionLevel");
    const s3Path = this.getS3Path();

    const archive = archiver("zip", {
      zlib: { level: parseInt(compressionLevel) },
    });

    archive.on("error", (err) => {
      this.logger.error("Archive error", err);
    });

    const processFiles = async () => {
      for (const file of files) {
        const key = `${s3Path}${shareId}/${file.name}`;
        try {
          const response = await s3Instance.send(
            new GetObjectCommand({
              Bucket: bucketName,
              Key: key,
            }),
          );

          if (response.Body instanceof Readable) {
            const body = response.Body as Readable;
            archive.append(body, { name: file.name });
            // Wait for this file to be fully appended before moving to the next one to avoid overwhelming memory/connections
            await new Promise((resolve, reject) => {
              body.on("end", resolve);
              body.on("error", reject);
            });
          }
        } catch (error) {
          this.logger.error(`Error processing file ${file.name}`, error);
        }
      }
      archive.finalize();
    };

    processFiles();

    return archive;
  }

  async createPreSignedUploadUrls(
    shareId: string,
    fileName: string,
    totalChunks: number,
  ): Promise<{ uploadId: string; key: string; urls: string[] }> {
    const key = `${this.getS3Path()}${shareId}/${fileName}`;
    const bucketName = this.config.get("s3.bucketName");
    const s3Instance = this.getS3Instance();

    try {
      const multipartInitResponse = await s3Instance.send(
        new CreateMultipartUploadCommand({
          Bucket: bucketName,
          Key: key,
        }),
      );

      const uploadId = multipartInitResponse.UploadId;
      if (!uploadId) {
        throw new InternalServerErrorException(
          this.i18n.t("file.s3UploadInitError"),
        );
      }

      const urls: string[] = [];
      for (let i = 0; i < totalChunks; i++) {
        const partNumber = i + 1;
        const command = new UploadPartCommand({
          Bucket: bucketName,
          Key: key,
          PartNumber: partNumber,
          UploadId: uploadId,
        });
        const url = await getSignedUrl(s3Instance, command, {
          expiresIn: 3600,
        });
        urls.push(url);
      }

      await this.prisma.s3Upload.upsert({
        where: { id: `${shareId}_${fileName}` },
        create: {
          id: `${shareId}_${fileName}`,
          shareId,
          name: fileName,
          uploadId,
          parts: "[]",
          uploadedBytes: 0,
        },
        update: {
          uploadId,
          parts: "[]",
        },
      }).catch(() => {});

      return { uploadId, key, urls };
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(
        this.i18n.t("file.s3UploadInitError"),
      );
    }
  }

  async completePreSignedUpload(
    shareId: string,
    fileId: string,
    fileName: string,
    uploadId: string,
    parts: Array<{ ETag: string; PartNumber: number }>,
  ): Promise<{ id: string; name: string }> {
    if (!fileId) {
      fileId = crypto.randomUUID();
    } else if (!isValidUUID(fileId)) {
      throw new BadRequestException(this.i18n.t("file.invalidIdFormat"));
    }

    const key = `${this.getS3Path()}${shareId}/${fileName}`;
    const bucketName = this.config.get("s3.bucketName");
    const s3Instance = this.getS3Instance();

    const sortedParts = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);

    try {
      await s3Instance.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucketName,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: sortedParts,
          },
        }),
      );
      await this.prisma.s3Upload.deleteMany({
        where: { shareId, name: fileName },
      }).catch(() => {});
      await this.prisma.uploadSession.deleteMany({
        where: { id: fileId },
      }).catch(() => {});
    } catch (error) {
      this.logger.error("Failed to complete S3 multipart upload:", error);
      throw new BadRequestException(this.i18n.t("file.s3UploadFailed"));
    }

    try {
      const fileSize = await this.getFileSize(shareId, fileName);

      const existingFile = await this.prisma.file.findUnique({
        where: { id: fileId },
      });

      if (!existingFile) {
        await this.prisma.file.create({
          data: {
            id: fileId,
            name: fileName,
            size: fileSize.toString(),
            share: { connect: { id: shareId } },
          },
        });
      }

      return { id: fileId, name: fileName };
    } catch (error) {
      this.logger.error(
        "Error creating database record after S3 upload completion:",
        error,
      );
      throw new InternalServerErrorException(
        this.i18n.t("file.s3UploadFailed"),
      );
    }
  }

  async abortPreSignedUpload(
    shareId: string,
    fileName: string,
    uploadId: string,
  ): Promise<void> {
    const key = `${this.getS3Path()}${shareId}/${fileName}`;
    const bucketName = this.config.get("s3.bucketName");
    const s3Instance = this.getS3Instance();

    try {
      await s3Instance.send(
        new AbortMultipartUploadCommand({
          Bucket: bucketName,
          Key: key,
          UploadId: uploadId,
        }),
      );
      await this.prisma.s3Upload.deleteMany({
        where: { shareId, name: fileName },
      }).catch(() => {});
    } catch (error) {
      this.logger.error("Error aborting multipart upload:", error);
      await this.prisma.cleanupFailure.create({
        data: {
          provider: "S3",
          shareId,
          targetId: `${key}::${uploadId}`,
          action: "abort_upload",
          error: (error as Error).message || String(error),
        },
      }).catch(() => {});
    }
  }

  async getPreSignedDownloadUrl(
    shareId: string,
    fileId: string,
    isDownload: boolean,
  ): Promise<string> {
    const fileRecord = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
    });
    if (!fileRecord) {
      throw new NotFoundException(this.i18n.t("file.notFound"));
    }

    const key = `${this.getS3Path()}${shareId}/${fileRecord.name}`;
    const bucketName = this.config.get("s3.bucketName");
    const s3Instance = this.getS3Instance();

    const getObjectCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
      ResponseContentDisposition: contentDisposition(
        fileRecord.name,
        isDownload ? undefined : { type: "inline" },
      ),
    });

    return await getSignedUrl(s3Instance, getObjectCommand, { expiresIn: 300 });
  }

  getS3Path(): string {
    const configS3Path = this.config.get("s3.bucketPath");
    if (!configS3Path) return "";
    const normalized = `${configS3Path}`.replace(/^\/+|\/+$/g, "");
    return normalized ? `${normalized}/` : "";
  }

  async hasPendingUploads(shareId: string): Promise<boolean> {
    const count = await this.prisma.s3Upload.count({
      where: { shareId },
    });
    return count > 0;
  }

  async abortShareMultipartUploads(shareId: string): Promise<void> {
    const bucketName = this.config.get("s3.bucketName");
    const s3Instance = this.getS3Instance();
    const uploads = await this.prisma.s3Upload.findMany({
      where: { shareId },
    });
    for (const upload of uploads) {
      const key = `${this.getS3Path()}${shareId}/${upload.name}`;
      try {
        await s3Instance.send(
          new AbortMultipartUploadCommand({
            Bucket: bucketName,
            Key: key,
            UploadId: upload.uploadId,
          }),
        );
      } catch (err) {
        await this.prisma.cleanupFailure.create({
          data: {
            provider: "S3",
            shareId,
            fileId: upload.id,
            targetId: `${key}::${upload.uploadId}`,
            action: "abort_upload",
            error: (err as Error).message || String(err),
          },
        }).catch(() => {});
      }
    }
    await this.prisma.s3Upload.deleteMany({ where: { shareId } }).catch(() => {});
    await this.prisma.uploadSession.deleteMany({ where: { shareId } }).catch(() => {});
  }
}
