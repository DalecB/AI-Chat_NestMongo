import { ApiProperty } from '@nestjs/swagger';
import { IsByteLength, IsString, MaxLength, MinLength } from 'class-validator';

import { Trim } from '../../common/trim';

export class RegisterDto {
  @ApiProperty({
    example: 'jay1',
    minLength: 3,
    maxLength: 30,
    description: 'Login id entered by the user.',
  })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  id: string;

  @ApiProperty({
    example: 'password1234',
    minLength: 8,
    maxLength: 100,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  // bcrypt는 72바이트 이후를 무시한다. 넘으면 뒷부분이 달라도 같은 비밀번호로 통과한다.
  @IsByteLength(0, 72)
  password: string;
}
