import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({
    example: 'jay1',
    minLength: 3,
    maxLength: 30,
    description: 'Login id entered by the user.',
  })
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
  password: string;
}
