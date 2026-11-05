import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { AdministratorGuard } from "src/auth/guard/isAdmin.guard";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { StorageService } from "./storage.service";

@Controller("admin/storage")
@UseGuards(JwtGuard, AdministratorGuard)
export class StorageController {
  constructor(private storageService: StorageService) {}

  @Get()
  async getDashboard() {
    return await this.storageService.getDashboardSummary();
  }

  @Post("cleanup-failures/:id/retry")
  async retryCleanup(@Param("id") id: string) {
    return await this.storageService.retryCleanup(id);
  }

  @Post("cleanup-failures/retry-all")
  async retryAllCleanups() {
    return await this.storageService.retryAllCleanups();
  }

  @Delete("cleanup-failures/:id")
  async dismissCleanup(@Param("id") id: string) {
    await this.storageService.dismissCleanup(id);
    return { success: true };
  }

  @Post("active-uploads/:fileId/abort")
  async abortActiveUpload(@Param("fileId") fileId: string) {
    await this.storageService.abortActiveUpload(fileId);
    return { success: true };
  }
}
