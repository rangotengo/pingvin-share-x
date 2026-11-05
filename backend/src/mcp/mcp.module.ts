import { Module } from "@nestjs/common";
import { AgentTokenModule } from "../agentToken/agentToken.module";
import { FileModule } from "../file/file.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ShareModule } from "../share/share.module";
import { McpController } from "./mcp.controller";
import { McpService } from "./mcp.service";

@Module({
  imports: [AgentTokenModule, PrismaModule, ShareModule, FileModule],
  controllers: [McpController],
  providers: [McpService],
  exports: [McpService],
})
export class McpModule {}
