import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional } from 'class-validator';

export class TokenStatsQueryDto {
  @ApiPropertyOptional({
    example: '2026-05-01',
    description: 'Inclusive ISO date/datetime lower bound.',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-05-19',
    description: 'Inclusive ISO date/datetime upper bound.',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
    enum: ['day'],
    example: 'day',
  })
  @IsOptional()
  @IsIn(['day'])
  groupBy?: 'day';
}
