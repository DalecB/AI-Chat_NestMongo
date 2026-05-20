import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { toObjectId } from '../common/mongo/object-id';
import { PersonasService } from '../personas/personas.service';
import { UserDocument } from '../users/schemas/user.schema';
import { CreateSessionDto } from './dto/create-session.dto';
import { ListSessionsQueryDto } from './dto/list-sessions-query.dto';
import { SessionDocument, SessionTokenUsage } from './schemas/session.schema';
import { SessionsService } from './sessions.service';

class SessionTokenUsageResponse {
  @ApiProperty({ example: 10 })
  prompt: number;

  @ApiProperty({ example: 20 })
  completion: number;

  @ApiProperty({ example: 30 })
  total: number;
}

class SessionResponse {
  @ApiProperty({ example: '665f0f8f7b1f2a0012345678' })
  id: string;

  @ApiProperty({ example: '665f0f8f7b1f2a0012345678' })
  personaId: string;

  @ApiPropertyOptional({ example: '첫 상담', nullable: true })
  title: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
  })
  lastMessageAt: Date | null;

  @ApiProperty({ type: SessionTokenUsageResponse })
  tokenUsage: SessionTokenUsage;
}

class ListSessionsResponse {
  @ApiProperty({ type: SessionResponse, isArray: true })
  items: SessionResponse[];

  @ApiPropertyOptional({
    example: '665f0f8f7b1f2a0012345678',
    nullable: true,
  })
  nextCursor: string | null;
}

@ApiTags('Sessions')
@ApiBearerAuth()
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessionsService: SessionsService,
    private readonly personasService: PersonasService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  @ApiOperation({ summary: 'List current user sessions' })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Cursor session id from the previous page.',
  })
  @ApiOkResponse({ type: ListSessionsResponse })
  async findMine(
    @CurrentUser() user: UserDocument,
    @Query() query: ListSessionsQueryDto,
  ): Promise<ListSessionsResponse> {
    const page = await this.sessionsService.findMinePage(
      user._id,
      query.cursor ? toObjectId(query.cursor) : undefined,
    );

    return {
      items: page.items.map((session) => this.toResponse(session)),
      nextCursor: page.nextCursor,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  @ApiOperation({ summary: 'Get owned session' })
  @ApiParam({ name: 'id', description: 'Session ObjectId' })
  @ApiOkResponse({ type: SessionResponse })
  async findOne(
    @CurrentUser() user: UserDocument,
    @Param('id') id: string,
  ): Promise<SessionResponse> {
    const session = await this.sessionsService.findOwnedOrThrow(
      toObjectId(id),
      user._id,
    );

    return this.toResponse(session);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  @ApiOperation({ summary: 'Create session with persona greeting message' })
  @ApiCreatedResponse({ type: SessionResponse })
  async create(
    @CurrentUser() user: UserDocument,
    @Body() dto: CreateSessionDto,
  ): Promise<SessionResponse> {
    const personaId = toObjectId(dto.personaId);
    const persona = await this.personasService.findAccessibleById(
      personaId,
      user._id,
    );

    if (!persona) {
      throw new NotFoundException('Persona not found');
    }

    const session = await this.sessionsService.createWithGreeting({
      userId: user._id,
      personaId,
      title: dto.title ?? null,
      greetingMessage: persona.greetingMessage,
    });

    return this.toResponse(session);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete owned session and its messages' })
  @ApiParam({ name: 'id', description: 'Session ObjectId' })
  @ApiNoContentResponse()
  async remove(
    @CurrentUser() user: UserDocument,
    @Param('id') id: string,
  ): Promise<void> {
    await this.sessionsService.deleteOwnedWithMessages(toObjectId(id), user._id);
  }

  private toResponse(session: SessionDocument): SessionResponse {
    return {
      id: session._id.toString(),
      personaId: session.personaId.toString(),
      title: session.title,
      lastMessageAt: session.lastMessageAt,
      tokenUsage: session.tokenUsage,
    };
  }
}
