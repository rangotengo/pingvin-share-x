import {
  Controller,
  Delete,
  Get,
  HttpStatus,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { Request, Response } from "express";
import { AgentTokenService } from "../agentToken/agentToken.service";
import { McpService } from "./mcp.service";

@Controller("mcp")
@SkipThrottle()
export class McpController {
  constructor(
    private agentTokenService: AgentTokenService,
    private mcpService: McpService,
  ) {}

  private extractToken(req: Request): string | null {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      return authHeader.slice(7).trim();
    }
    const queryToken = req.query?.token;
    if (typeof queryToken === "string" && queryToken.trim().length > 0) {
      return queryToken.trim();
    }
    return null;
  }

  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response): Promise<void> {
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
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // New session on initialize request
    const newSession = await this.mcpService.createSession(user);
    await newSession.transport.handleRequest(req, res, req.body);
  }

  @Get()
  async handleGet(@Req() req: Request, @Res() res: Response): Promise<void> {
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
  }

  @Delete()
  async handleDelete(@Req() req: Request, @Res() res: Response): Promise<void> {
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
