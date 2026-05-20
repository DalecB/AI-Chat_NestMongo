import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CreateSessionDto {
  @ApiProperty({
    example: '665f0f8f7b1f2a0012345678',
    description: 'Persona ObjectId.',
  })
  @IsString()
  personaId: string;

  @ApiPropertyOptional({
    example: '첫 상담',
    description: 'Optional session title.',
  })
  @IsOptional()
  @IsString()
  title?: string;
}
