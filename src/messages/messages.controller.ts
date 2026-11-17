import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Response } from "express";

import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { toObjectId } from "../common/mongo/object-id";
import { SessionsService } from "../sessions/sessions.service";
import { UserDocument } from "../users/schemas/user.schema";
import { ChatOrchestratorService } from "./chat-orchestrator.service";
import { CreateMessageDto } from "./dto/create-message.dto";
import { ListMessagesQueryDto } from "./dto/list-messages-query.dto";
import { MessageResponse, MessagesService } from "./messages.service";
import { RateLimit } from "../redis/rate-limit.guard";

class MessageTokenUsageResponse {
  @ApiProperty({ example: 10 })
  prompt: number;

  @ApiProperty({ example: 20 })
  completion: number;

  @ApiProperty({ example: 30 })
  total: number;
}

class MessageResponseDto {
  @ApiProperty({ example: "665f0f8f7b1f2a0012345678" })
  id: string;

  @ApiProperty({ example: "665f0f8f7b1f2a0012345678" })
  sessionId: string;

  @ApiProperty({ enum: ["user", "assistant"], example: "assistant" })
  role: MessageResponse["role"];

  @ApiProperty({ example: "안녕하세요." })
  content: string;

  @ApiPropertyOptional({ type: MessageTokenUsageResponse, nullable: true })
  tokenUsage: MessageResponse["tokenUsage"];

  @ApiProperty({
    enum: ["pending", "streaming", "completed", "failed"],
    example: "completed",
  })
  streamStatus: MessageResponse["streamStatus"];

  @ApiProperty({ type: String, format: "date-time" })
  createdAt: Date;
}

class ListMessagesResponse {
  @ApiProperty({ type: MessageResponseDto, isArray: true })
  items: MessageResponse[];

  @ApiPropertyOptional({
    example: "665f0f8f7b1f2a0012345678",
    nullable: true,
  })
  nextCursor: string | null;
}

@ApiTags("Messages")
@ApiBearerAuth()
@Controller("sessions/:sessionId/messages")
export class MessagesController {
  private readonly logger = new Logger(MessagesController.name);

  constructor(
    private readonly messagesService: MessagesService,
    private readonly sessionsService: SessionsService,
    private readonly chatOrchestratorService: ChatOrchestratorService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  @ApiOperation({ summary: "List session messages" })
  @ApiParam({ name: "sessionId", description: "Session ObjectId" })
  @ApiQuery({
    name: "cursor",
    required: false,
    description: "Cursor message id from the previous page.",
  })
  @ApiOkResponse({ type: ListMessagesResponse })
  async findBySession(
    @CurrentUser() user: UserDocument,
    @Param("sessionId") sessionIdParam: string,
    @Query() query: ListMessagesQueryDto,
  ): Promise<ListMessagesResponse> {
    const sessionId = toObjectId(sessionIdParam);
    await this.sessionsService.findOwnedOrThrow(sessionId, user._id);

    const page = await this.messagesService.findPageBySession(
      sessionId,
      query.cursor ? toObjectId(query.cursor) : undefined,
    );

    return {
      items: page.items.map((message) =>
        this.messagesService.toResponse(message),
      ),
      nextCursor: page.nextCursor,
    };
  }

  // orchestrator의 AsyncGenerator를 SSE로 전달한다.
  // 첫 yield 전까지 헤더 전송을 미뤄, 시작 전 에러는 일반 HTTP 예외로, 시작 후 에러는 SSE error 이벤트로 전달한다.
  @RateLimit({ name: "message", limit: 20, by: "user" })
  @UseGuards(JwtAuthGuard)
  @Post()
  @ApiOperation({ summary: "Send message and stream assistant response" })
  @ApiParam({ name: "sessionId", description: "Session ObjectId" })
  @ApiBody({ type: CreateMessageDto })
  @ApiProduces("text/event-stream")
  @ApiResponse({
    status: 200,
    description:
      "Server-Sent Events: user_message_saved, assistant_message_started, chunk, assistant_message_completed, done, or error.",
    content: {
      "text/event-stream": {
        schema: {
          type: "string",
          example:
            'event: chunk\ndata: {"content":"안녕"}\n\nevent: done\ndata: {}\n\n',
        },
      },
    },
  })
  async create(
    @CurrentUser() user: UserDocument,
    @Param("sessionId") sessionIdParam: string,
    @Body() dto: CreateMessageDto,
    @Res() response: Response,
  ): Promise<void> {
    const sessionId = toObjectId(sessionIdParam);
    let responseStarted = false;

    try {
      const events = this.chatOrchestratorService.streamMessage({
        sessionId,
        userId: user._id,
        content: dto.content,
      });

      for await (const streamEvent of events) {
        // 클라이언트가 끊겼으면 중단한다. break가 generator.return()을 불러 LLM 스트림 abort,
        // 미완 placeholder failed 처리, 락 해제를 generator의 finally에서 실행한다.
        // request의 'close'는 body를 다 읽으면 바로 발생하므로 response 상태를 본다.
        if (response.destroyed) {
          break;
        }

        if (!responseStarted) {
          this.setSseHeaders(response);
          responseStarted = true;
        }

        this.writeSse(response, streamEvent.event, streamEvent.data);
      }
    } catch (error) {
      // SSE 헤더가 나간 뒤에는 HTTP throw가 통하지 않으므로 error 이벤트로 전달.
      // 시작 전이면 일반 예외 처리에 맡긴다.
      if (!responseStarted) {
        throw error;
      }

      // 에러 원문은 서버 로그에만 남긴다.
      this.logger.error(
        `Message stream failed. sessionId=${sessionId.toString()}`,
        error instanceof Error ? error.stack : String(error),
      );
      this.writeSse(response, "error", { message: "Message stream failed" });
    } finally {
      // 헤더가 나간 응답만 명시적으로 end. 시작 전 응답은 Nest 응답 처리 흐름에 맡긴다.
      if (responseStarted) {
        response.end();
      }
    }
  }

  private setSseHeaders(response: Response): void {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
  }

  private writeSse(response: Response, event: string, data: unknown): void {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
