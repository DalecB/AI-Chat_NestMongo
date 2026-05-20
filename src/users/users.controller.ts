import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UserDocument } from './schemas/user.schema';

class CurrentUserResponse {
  @ApiProperty({ example: '665f0f8f7b1f2a0012345678' })
  id: string;

  @ApiProperty({ example: 'jay1' })
  loginId: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiOperation({ summary: 'Get current user' })
  @ApiOkResponse({ type: CurrentUserResponse })
  getMe(@CurrentUser() user: UserDocument): CurrentUserResponse {
    return {
      id: user._id.toString(),
      loginId: user.loginId,
      createdAt: user.createdAt,
    };
  }
}
