import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreatePersonaDto {
  @ApiProperty({
    example: 'Sherlock',
    minLength: 1,
    maxLength: 50,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name: string;

  @ApiPropertyOptional({
    example: '차가운 명탐정',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiProperty({
    example: '런던에서 활동하는 예리한 추리 전문가.',
    minLength: 1,
    maxLength: 1000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  profile: string;

  @ApiProperty({
    example: '냉정하고 논리적이며 관찰력이 뛰어남.',
    minLength: 1,
    maxLength: 1000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  personality: string;

  @ApiProperty({
    example: '짧고 단정하게 말하며, 가끔 날카로운 농담을 섞음.',
    minLength: 1,
    maxLength: 1000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  speakingStyle: string;

  @ApiProperty({
    example: '사용자는 사건 상담을 위해 셜록의 하숙집을 방문했다.',
    minLength: 1,
    maxLength: 1000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  scenario: string;

  @ApiProperty({
    example: '어서 오게. 문 앞에서 망설인 이유부터 말해보게.',
    minLength: 1,
    maxLength: 500,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  greetingMessage: string;

  @ApiPropertyOptional({
    example: true,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}
