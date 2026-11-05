import {
  Controller,
  Delete,
  Get,
  HttpStatus,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Request, Response } from "express";
import { AgentTokenService } from "../agentToken/agentToken.service";
import { ConfigService } from "../config/config.service";
import {
  extractBearerToken,
  isInitializeRequest,
  validateOriginHeader,
} from "./mcp.protocol";
import { McpService } from "./mcp.service";

@Controller("mcp")
@Throttle({
  default: {
    limit: 1200,
    ttl: 60 * 1000,
  },
})
export class McpController {
  private agentTokenService: AgentTokenService;
  private mcpService: McpService;
  private configService: ConfigService;

  constructor(
    agentTokenService: AgentTokenService,
    mcpService: McpService,
    configService: ConfigService,
  ) {
    this.agentTokenService = agentTokenService;
    this.mcpService = mcpService;
    this.configService = configService;
  }

  extractToken(req: Request): string | null {
    return extractBearerToken(req.headers.authorization);
  }

  private validateOrigin(req: Request): boolean {
    const appUrl = (this.configService.get("general.appUrl") || "").trim();
    return validateOriginHeader(req.headers.origin, appUrl);
  }

  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!this.validateOrigin(req)) {
      res.status(HttpStatus.FORBIDDEN).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Forbidden: Origin not allowed" },
        id: null,
      });
      return;
    }

    const rawToken = this.extractToken(req);
    if (!rawToken) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="pingvin-mcp"');
      res.status(HttpStatus.UNAUTHORIZED).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Unauthorized: Missing agent token" },
        id: null,
      });
      return;
    }

    const authResult = await this.agentTokenService.validateToken(rawToken);
    if (!authResult || !authResult.valid) {
      res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
      const msg = authResult?.error || "Unauthorized: Invalid agent token";
      res.status(HttpStatus.UNAUTHORIZED).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: msg },
        id: null,
      });
      return;
    }

    const { user } = authResult;
    const sessionIdHeader = req.headers["mcp-session-id"] as string | undefined;

    if (sessionIdHeader) {
      const session = this.mcpService.getSession(sessionIdHeader);
      if (!session) {
        res.status(HttpStatus.NOT_FOUND).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        });
        return;
      }
      if (session.userId !== user.id) {
        res.status(HttpStatus.FORBIDDEN).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session belongs to another user" },
          id: null,
        });
        return;
      }
      this.mcpService.updateSessionUser(sessionIdHeader, user);
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // Require initialize JSON-RPC request before allocating a new session
    const isInitialize = isInitializeRequest(req.body);

    if (!isInitialize) {
      res.status(HttpStatus.BAD_REQUEST).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            "Mcp-Session-Id header is required for non-initialize requests",
        },
        id: req.body?.id ?? null,
      });
      return;
    }

    // New session on valid initialize request
    const newSession = await this.mcpService.createSession(user);
    await newSession.transport.handleRequest(req, res, req.body);
  }

  @Get()
  async handleGet(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!this.validateOrigin(req)) {
      res.status(HttpStatus.FORBIDDEN).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Forbidden: Origin not allowed" },
        id: null,
      });
      return;
    }

    const rawToken = this.extractToken(req);
    if (!rawToken) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="pingvin-mcp"');
      res.status(HttpStatus.UNAUTHORIZED).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Unauthorized: Missing agent token" },
        id: null,
      });
      return;
    }

    const authResult = await this.agentTokenService.validateToken(rawToken);
    if (!authResult || !authResult.valid) {
      res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
      const msg = authResult?.error || "Unauthorized: Invalid agent token";
      res.status(HttpStatus.UNAUTHORIZED).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: msg },
        id: null,
      });
      return;
    }

    const { user } = authResult;
    const sessionIdHeader = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionIdHeader) {
      res.status(HttpStatus.BAD_REQUEST).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Mcp-Session-Id header is required" },
        id: null,
      });
      return;
    }

    const session = this.mcpService.getSession(sessionIdHeader);
    if (!session) {
      res.status(HttpStatus.NOT_FOUND).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      });
      return;
    }

    if (session.userId !== user.id) {
      res.status(HttpStatus.FORBIDDEN).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session belongs to another user" },
        id: null,
      });
      return;
    }

    this.mcpService.updateSessionUser(sessionIdHeader, user);
    await session.transport.handleRequest(req, res, req.body);
  }

  @Delete()
  async handleDelete(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!this.validateOrigin(req)) {
      res.status(HttpStatus.FORBIDDEN).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Forbidden: Origin not allowed" },
        id: null,
      });
      return;
    }

    const rawToken = this.extractToken(req);
    if (!rawToken) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="pingvin-mcp"');
      res.status(HttpStatus.UNAUTHORIZED).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Unauthorized: Missing agent token" },
        id: null,
      });
      return;
    }

    const authResult = await this.agentTokenService.validateToken(rawToken);
    if (!authResult || !authResult.valid) {
      res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
      const msg = authResult?.error || "Unauthorized: Invalid agent token";
      res.status(HttpStatus.UNAUTHORIZED).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: msg },
        id: null,
      });
      return;
    }

    const { user } = authResult;
    const sessionIdHeader = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionIdHeader) {
      res.status(HttpStatus.BAD_REQUEST).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Mcp-Session-Id header is required" },
        id: null,
      });
      return;
    }

    const session = this.mcpService.getSession(sessionIdHeader);
    if (!session) {
      res.status(HttpStatus.NOT_FOUND).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      });
      return;
    }

    if (session.userId !== user.id) {
      res.status(HttpStatus.FORBIDDEN).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session belongs to another user" },
        id: null,
      });
      return;
    }

    await session.transport.handleRequest(req, res, req.body);
    this.mcpService.removeSession(sessionIdHeader);
  }
}
