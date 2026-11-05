import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Request } from "express";
import * as moment from "moment";
import { I18nService } from "nestjs-i18n";
import { PrismaService } from "src/prisma/prisma.service";
import { ShareService } from "src/share/share.service";
import { ConfigService } from "src/config/config.service";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { User } from "@prisma/client";

@Injectable()
export class ShareSecurityGuard extends JwtGuard {
  constructor(
    private shareService: ShareService,
    private prisma: PrismaService,
    private configService: ConfigService,
    private readonly i18n: I18nService,
  ) {
    super(configService);
  }

  protected async authenticateUser(
    context: ExecutionContext,
  ): Promise<User | undefined> {
    await super.canActivate(context);
    const request: Request = context.switchToHttp().getRequest();
    return request.user as User;
  }

  protected async isRecipient(
    share: {
      id: string;
      userRecipients: { userId: string }[];
      recipients: { email: string }[];
    },
    user?: User,
  ): Promise<boolean> {
    if (!user) return false;
    if (!this.configService.get("share.enableUserRecipients")) return false;

    // Already linked as a recipient of this share.
    const isLinked = share.userRecipients.some((r) => r.userId === user.id);
    if (isLinked) return true;

    // Otherwise, if the user's (account-verified) email matches one of the
    // share's recipients, grant access and link them
    const userEmail = user.email?.toLowerCase();
    const isEmailRecipient =
      !!userEmail &&
      share.recipients.some((r) => r.email.toLowerCase() === userEmail);
    if (isEmailRecipient) {
      await this.prisma.shareUserRecipient.upsert({
        where: { userId_shareId: { userId: user.id, shareId: share.id } },
        create: { userId: user.id, shareId: share.id },
        update: {},
      });
      return true;
    }
    return false;
  }

  async canActivate(context: ExecutionContext) {
    const request: Request = context.switchToHttp().getRequest();

    const shareId = Object.prototype.hasOwnProperty.call(
      request.params,
      "shareId",
    )
      ? request.params.shareId
      : request.params.id;

    const shareToken = request.cookies[`share_${shareId}_token`];

    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: {
        security: true,
        reverseShare: true,
        userRecipients: { select: { userId: true } },
        recipients: { select: { email: true } },
      },
    });

    if (!share) throw new NotFoundException(this.i18n.t("share.notFound"));

    if (share.removedReason) {
      throw new NotFoundException(share.removedReason, "share_removed");
    }

    const user = await this.authenticateUser(context);

    // If admin access is enabled and user is admin, allow access
    if (
      user?.isAdmin &&
      this.configService.get("security.allowAdminAccessAllShares")
    ) {
      return true;
    }

    if (
      moment().isAfter(share.expiration) &&
      !moment(share.expiration).isSame(0)
    ) {
      throw new NotFoundException(this.i18n.t("share.notFound"));
    }

    const isCreator = Boolean(user && share.creatorId === user.id);
    if (isCreator) {
      return true;
    }

    // Only the creator and reverse share creator can access the reverse share if it's not public
    if (
      share.reverseShare &&
      !share.reverseShare.publicAccess &&
      share.creatorId !== user?.id &&
      share.reverseShare.creatorId !== user?.id
    )
      throw new ForbiddenException(
        this.i18n.t("share.privateShare"),
        "private_share",
      );

    const isRecipientUser = await this.isRecipient(share, user);

    // If share is restricted to named recipients, block everyone else
    if (share.security?.restrictToRecipients && !isRecipientUser) {
      throw new ForbiddenException(
        this.i18n.t("share.restrictedToRecipients"),
        "share_restricted_to_recipients",
      );
    }

    const hasValidToken =
      Boolean(shareToken) &&
      (await this.shareService.verifyShareToken(share, shareToken));

    if (share.security?.password && !hasValidToken) {
      if (!shareToken) {
        throw new ForbiddenException(
          this.i18n.t("file.passwordProtected"),
          "share_password_required",
        );
      }
      throw new ForbiddenException(
        this.i18n.t("share.tokenRequired"),
        "share_token_required",
      );
    }

    if (isRecipientUser) {
      if (!hasValidToken) {
        const path = request.baseUrl
          ? `${request.baseUrl}${request.path}`
          : request.path;
        const isShareView =
          request.method === "GET" &&
          (path.endsWith(`/shares/${shareId}`) ||
            path.endsWith(`/${shareId}`) ||
            request.route?.path === "/:id" ||
            request.route?.path === "/shares/:id");

        if (isShareView) {
          await this.shareService.handleViewCount(
            share.id,
            share.security?.maxViews,
          );
          const response = context.switchToHttp().getResponse();
          if (response && typeof response.cookie === "function") {
            const token = await this.shareService.generateShareToken(share);
            response.cookie(`share_${share.id}_token`, token, {
              path: "/",
              httpOnly: true,
            });
          }
        }
      }
      return true;
    }

    if (!hasValidToken) {
      throw new ForbiddenException(
        this.i18n.t("share.tokenRequired"),
        "share_token_required",
      );
    }

    return true;
  }
}
