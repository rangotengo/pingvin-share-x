import {
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

export class CreateAgentTokenDTO {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
