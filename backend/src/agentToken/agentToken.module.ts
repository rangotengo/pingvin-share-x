import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AgentTokenController } from "./agentToken.controller";
import { AgentTokenService } from "./agentToken.service";

@Module({
  imports: [PrismaModule],
  controllers: [AgentTokenController],
  providers: [AgentTokenService],
  exports: [AgentTokenService],
})
export class AgentTokenModule {}
