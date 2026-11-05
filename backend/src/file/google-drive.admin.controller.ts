import {
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { User } from "@prisma/client";
import * as crypto from "crypto";
import { Request, Response } from "express";
import { AdministratorGuard } from "src/auth/guard/isAdmin.guard";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { ConfigService } from "src/config/config.service";
import {
  connectErrorLog,
  connectReason,
  oauthCallbackReason,
} from "./google-drive.protocol";
import { GoogleDriveFileService } from "./google-drive.service";

type OauthState = { userId: string; exp: number };

@Controller("admin/google-drive")
@UseGuards(JwtGuard, AdministratorGuard)
export class GoogleDriveAdminController {
  private readonly logger = new Logger(GoogleDriveAdminController.name);
  // ponytail: in-memory OAuth state, one backend process. Move to cache for multiple replicas.
  private readonly states = new Map<string, OauthState>();

  constructor(
    private drive: GoogleDriveFileService,
    private config: ConfigService,
  ) {}

  @Get("status")
  @SkipThrottle()
  status() {
    return this.drive.status();
  }

  @Get("connect")
  @SkipThrottle()
  connect(@Req() req: Request & { user: User }) {
    this.pruneStates();
    const state = crypto.randomBytes(32).toString("hex");
    this.states.set(state, {
      userId: req.user.id,
      exp: Date.now() + 10 * 60 * 1000,
    });
    return { url: this.drive.authUrl(state) };
  }

  @Get("callback")
  @SkipThrottle()
  async callback(
    @Req() req: Request & { user: User },
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string,
    @Res() res: Response,
  ) {
    const back = `${String(this.config.get("general.appUrl") || "")
      .trim()
      .replace(/\/$/, "")}/admin/config/googledrive`;
    const saved = state ? this.states.get(state) : undefined;
    if (state) this.states.delete(state);
    const rejected = oauthCallbackReason({
      error,
      code,
      stateUserId: saved?.userId,
      requestUserId: req.user?.id,
      exp: saved?.exp,
      now: Date.now(),
    });
    if (rejected) {
      this.logger.warn(`Google Drive connect rejected: ${rejected}`);
      res.redirect(`${back}?drive=error&reason=${rejected}`);
      return;
    }
    try {
      await this.drive.connect(code);
      res.redirect(`${back}?drive=connected`);
    } catch (error) {
      const detail = connectErrorLog(error);
      this.logger.warn(`Google Drive connect failed: ${detail}`);
      const reason = connectReason(detail.split(" ")[0]);
      res.redirect(
        reason ? `${back}?drive=error&reason=${reason}` : `${back}?drive=error`,
      );
    }
  }

  private pruneStates() {
    const now = Date.now();
    for (const [key, value] of this.states) {
      if (value.exp < now) this.states.delete(key);
    }
  }

  @Post("disconnect")
  disconnect() {
    return this.drive.disconnect();
  }
}
