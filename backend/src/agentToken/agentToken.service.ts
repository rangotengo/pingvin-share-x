import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { PrismaService } from "../prisma/prisma.service";

export const AGENT_TOKEN_PREFIX = "psa_";

@Injectable()
export class AgentTokenService {
  private prisma: PrismaService;
  constructor(prisma: PrismaService) {
    this.prisma = prisma;
  }

  async create(userId: string, name: string, expiresAt?: string | Date) {
    if (!name || name.trim().length === 0) {
      throw new BadRequestException("Token name is required");
    }

    const trimmedName = name.trim();
    if (trimmedName.length > 100) {
      throw new BadRequestException(
        "Token name must be at most 100 characters",
      );
    }

    let parsedExpiry: Date | undefined;
    if (expiresAt) {
      parsedExpiry = new Date(expiresAt);
      if (isNaN(parsedExpiry.getTime())) {
        throw new BadRequestException("Invalid expiresAt date format");
      }
      if (parsedExpiry.getTime() <= Date.now()) {
        throw new BadRequestException("expiresAt must be in the future");
      }
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    if (!user.isActivated)
      throw new ForbiddenException("Account is not activated");
    if (user.allowShare === false)
      throw new ForbiddenException("Sharing is disabled for this account");

    const entropy = crypto.randomBytes(32).toString("hex");
    const rawToken = `${AGENT_TOKEN_PREFIX}${entropy}`;
    const tokenPrefix = `${AGENT_TOKEN_PREFIX}${entropy.slice(0, 8)}...`;
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    const created = await this.prisma.agentToken.create({
      data: {
        userId,
        name: trimmedName,
        tokenPrefix,
        tokenHash,
        expiresAt: parsedExpiry,
      },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    // ponytail: raw token is returned once on creation only; never stored or returned again
    return {
      ...created,
      token: rawToken,
    };
  }

  async list(userId: string) {
    return this.prisma.agentToken.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        createdAt: true,
        expiresAt: true,
        lastUsedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async revoke(userId: string, id: string) {
    const existing = await this.prisma.agentToken.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      throw new NotFoundException("Token not found");
    }
    await this.prisma.agentToken.delete({ where: { id } });
    return { success: true };
  }

  async validateToken(rawToken: string) {
    if (
      typeof rawToken !== "string" ||
      !rawToken.startsWith(AGENT_TOKEN_PREFIX) ||
      rawToken.length < 36
    ) {
      return null;
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");
    const agentToken = await this.prisma.agentToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!agentToken) return null;

    if (agentToken.expiresAt && agentToken.expiresAt.getTime() <= Date.now()) {
      return { valid: false as const, error: "Token expired" };
    }

    if (!agentToken.user.isActivated) {
      return { valid: false as const, error: "User account deactivated" };
    }

    if (agentToken.user.allowShare === false) {
      return { valid: false as const, error: "Sharing disabled for this user" };
    }

    // Update lastUsedAt without awaiting
    void this.prisma.agentToken
      .update({
        where: { id: agentToken.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {});

    return {
      valid: true as const,
      user: agentToken.user,
      agentToken,
    };
  }
}
