import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ListMessagesQueryDto {
  @ApiPropertyOptional({
    example: '665f0f8f7b1f2a0012345678',
    description: 'Cursor message id from the previous page.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
