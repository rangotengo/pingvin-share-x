import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { EmailModule } from "src/email/email.module";
import { ReverseShareModule } from "src/reverseShare/reverseShare.module";
import { ShareModule } from "src/share/share.module";
import { FileController } from "./file.controller";
import { FileService } from "./file.service";
import { GoogleDriveAdminController } from "./google-drive.admin.controller";
import { GoogleDriveFileService } from "./google-drive.service";
import { LocalFileService } from "./local.service";
import { S3FileService } from "./s3.service";

@Module({
  imports: [
    JwtModule.register({}),
    EmailModule,
    ReverseShareModule,
    ShareModule,
  ],
  controllers: [FileController, GoogleDriveAdminController],
  providers: [FileService, LocalFileService, S3FileService, GoogleDriveFileService],
  exports: [FileService, GoogleDriveFileService, S3FileService],
})
export class FileModule {}
