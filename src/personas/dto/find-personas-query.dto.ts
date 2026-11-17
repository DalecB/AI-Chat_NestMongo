import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class FindPersonasQueryDto {
  @ApiPropertyOptional({
    example: 'Sherlock',
    maxLength: 50,
    description: 'Exact public persona name.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;
}
