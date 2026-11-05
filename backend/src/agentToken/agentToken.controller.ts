import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { User } from "@prisma/client";
import { GetUser } from "../auth/decorator/getUser.decorator";
import { JwtGuard } from "../auth/guard/jwt.guard";
import { AgentTokenService } from "./agentToken.service";
import { CreateAgentTokenDTO } from "./dto/createAgentToken.dto";

@Controller("agent-tokens")
export class AgentTokenController {
  constructor(private agentTokenService: AgentTokenService) {}

  @Get()
  @UseGuards(JwtGuard)
  async list(@GetUser() user?: User) {
    if (!user) throw new UnauthorizedException();
    return this.agentTokenService.list(user.id);
  }

  @Post()
  @UseGuards(JwtGuard)
  async create(
    @GetUser() user: User | undefined,
    @Body() body: CreateAgentTokenDTO,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.agentTokenService.create(user.id, body.name, body.expiresAt);
  }

  @Delete(":id")
  @UseGuards(JwtGuard)
  async revoke(@GetUser() user: User | undefined, @Param("id") id: string) {
    if (!user) throw new UnauthorizedException();
    return this.agentTokenService.revoke(user.id, id);
  }
}
