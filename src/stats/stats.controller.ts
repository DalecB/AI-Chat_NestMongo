import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MessagesService, TokenStatsItem } from '../messages/messages.service';
import { UserDocument } from '../users/schemas/user.schema';
import { TokenStatsQueryDto } from './dto/token-stats-query.dto';

class TokenStatsItemResponse {
  @ApiProperty({ example: '2026-05-19' })
  _id: string;

  @ApiProperty({ example: 12345 })
  totalTokens: number;

  @ApiProperty({ example: 50 })
  messageCount: number;
}

@ApiTags('Stats')
@ApiBearerAuth()
@Controller('stats')
export class StatsController {
  constructor(private readonly messagesService: MessagesService) {}

  @UseGuards(JwtAuthGuard)
  @Get('tokens')
  @ApiOperation({ summary: 'Get current user token usage stats' })
  @ApiQuery({ name: 'from', required: false, example: '2026-05-01' })
  @ApiQuery({ name: 'to', required: false, example: '2026-05-19' })
  @ApiQuery({ name: 'groupBy', required: false, enum: ['day'] })
  @ApiOkResponse({ type: TokenStatsItemResponse, isArray: true })
  async findTokenStats(
    @CurrentUser() user: UserDocument,
    @Query() query: TokenStatsQueryDto,
  ): Promise<TokenStatsItem[]> {
    const now = new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const to = query.to ? new Date(query.to) : now;

    if (from > to) {
      throw new BadRequestException('from must be before to');
    }

    return this.messagesService.aggregateTokenStatsByDay(user._id, from, to);
  }
}
