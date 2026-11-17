import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Types } from "mongoose";

import {
  CHAT_CONTEXT_WINDOW_SIZE,
  CHAT_SUMMARY_INITIAL_MESSAGE_LIMIT,
  CHAT_SUMMARY_MESSAGE_LIMIT,
  CHAT_SUMMARY_TRIGGER_INTERVAL,
} from "../common/chat-context";
import { OpenAiService } from "../llm/openai.service";
import { PersonasService } from "../personas/personas.service";
import {
  ContextCacheService,
  ContextMessage,
} from "../redis/context-cache.service";
import { SessionLock, SessionLockService } from "../redis/session-lock.service";
import { SessionDocument } from "../sessions/schemas/session.schema";
import { SessionsService } from "../sessions/sessions.service";
import { UserMemoriesService } from "../users/user-memories.service";
import { MessageDocument, MessageTokenUsage } from "./schemas/message.schema";
import { MessagesService } from "./messages.service";

export interface ChatStreamInput {
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
  content: string;
}

export interface ChatStreamEvent {
  event: string;
  data: unknown;
}

@Injectable()
export class ChatOrchestratorService {
  private readonly logger = new Logger(ChatOrchestratorService.name);
  private readonly contextWindowSize = CHAT_CONTEXT_WINDOW_SIZE;
  private readonly summaryTriggerInterval = CHAT_SUMMARY_TRIGGER_INTERVAL;
  private readonly summaryInitialMessageLimit =
    CHAT_SUMMARY_INITIAL_MESSAGE_LIMIT;
  private readonly summaryMessageLimit = CHAT_SUMMARY_MESSAGE_LIMIT;

  constructor(
    private readonly messagesService: MessagesService,
    private readonly sessionsService: SessionsService,
    private readonly personasService: PersonasService,
    private readonly userMemoriesService: UserMemoriesService,
    private readonly openAiService: OpenAiService,
    private readonly contextCacheService: ContextCacheService,
    private readonly sessionLockService: SessionLockService,
  ) {}

  // 흐름: 권한 검증 → 락 acquire → user message insert → context 조회 → assistant placeholder → OpenAI 스트림 → final update → release.
  // controller는 SSE 전송만 담당하도록 AsyncGenerator로 분리. ADR-6/7/8 참조.
  async *streamMessage(
    input: ChatStreamInput,
  ): AsyncGenerator<ChatStreamEvent> {
    const { sessionId, userId, content: userContent } = input;
    const session = await this.sessionsService.findOwnedOrThrow(
      sessionId,
      userId,
    );
    const persona = await this.personasService.findAccessibleById(
      session.personaId,
      userId,
    );

    if (!persona) {
      throw new NotFoundException("Persona not found");
    }

    // 권한 검증 통과 후 락 점유. 인증되지 않은 요청이 락 키를 차지하지 않도록.
    const lock = await this.sessionLockService.acquire(sessionId.toString());
    let assistantMessage: MessageDocument | null = null;
    // placeholder가 completed/failed로 확정됐는지. 클라이언트 이탈(return)로 끝나면 finally에서 failed로 확정한다.
    let assistantSettled = false;

    try {
      // 소유권 확인과 락 획득 사이 세션이 삭제됐을 수 있고, 직전 턴의 요약 갱신도 락 이후에야 확정된다. 락 안에서 다시 읽는다.
      const lockedSession = await this.sessionsService.findOwned(
        sessionId,
        userId,
      );

      if (!lockedSession) {
        throw new NotFoundException("Session not found");
      }

      const userMessage = await this.messagesService.create({
        sessionId,
        userId,
        role: "user",
        content: userContent,
        tokenUsage: null,
        streamStatus: "completed",
      });

      await this.sessionsService.touchMessageAt(
        sessionId,
        userMessage.createdAt,
      );

      const recentMessages =
        await this.contextCacheService.getContextWithFallback(
          sessionId.toString(),
          async () => {
            const messages =
              await this.messagesService.findRecentBySession(sessionId);

            return messages.map((message) => this.toContextMessage(message));
          },
        );
      // 방금 insert한 user message가 cache fallback 결과에 이미 포함됐는지 확인 후 push.
      // 분산 락 안이라 race는 없지만 fallback이 user insert를 포착하는 시점에 따라 중복/누락 가능. push는 한 번만.
      const userContextMessage = this.toContextMessage(userMessage);
      const hasUserMessage = recentMessages.some(
        (message) => message.id === userContextMessage.id,
      );
      const contextMessages = hasUserMessage
        ? recentMessages
        : [...recentMessages, userContextMessage].slice(
            -this.contextWindowSize,
          );

      if (!hasUserMessage) {
        await this.contextCacheService.pushMessage(
          sessionId.toString(),
          userContextMessage,
        );
      }

      const userMemories =
        await this.userMemoriesService.findPromptMemories(userId);

      // ADR-6: placeholder를 먼저 insert. 클라이언트가 끊겨도 응답 시도 흔적이 남고, 완료 시 final update.
      assistantMessage = await this.messagesService.create({
        sessionId,
        userId,
        role: "assistant",
        content: "",
        tokenUsage: null,
        streamStatus: "streaming",
      });

      await this.sessionsService.touchMessageAt(
        sessionId,
        assistantMessage.createdAt,
      );

      yield {
        event: "user_message_saved",
        data: this.messagesService.toResponse(userMessage),
      };
      yield {
        event: "assistant_message_started",
        data: this.messagesService.toResponse(assistantMessage),
      };

      let assistantContent = "";
      let tokenUsage: MessageTokenUsage = {
        prompt: 0,
        completion: 0,
        total: 0,
      };

      const stream = await this.openAiService.generateStream(
        persona.systemPrompt,
        contextMessages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        { userMemories, sessionSummary: lockedSession.stateSummary },
      );

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta.content ?? "";

        if (delta.length > 0) {
          assistantContent += delta;
          yield { event: "chunk", data: { content: delta } };
        }

        if (chunk.usage) {
          tokenUsage = {
            prompt: chunk.usage.prompt_tokens,
            completion: chunk.usage.completion_tokens,
            total: chunk.usage.total_tokens,
          };
        }
      }

      const completedAssistantMessage =
        await this.messagesService.completeAssistantMessage(
          assistantMessage._id,
          assistantContent,
          tokenUsage,
        );

      assistantSettled = true;

      await this.sessionsService.addTokenUsage(sessionId, tokenUsage);
      await this.contextCacheService.pushMessage(
        sessionId.toString(),
        this.toContextMessage(completedAssistantMessage),
      );
      await this.updateSessionSummaryIfNeeded(lockedSession);

      yield {
        event: "assistant_message_completed",
        data: this.messagesService.toResponse(completedAssistantMessage),
      };
      yield { event: "done", data: {} };
    } catch (error) {
      if (!assistantMessage) {
        throw error;
      }

      const errorMessage = this.toErrorMessage(error);
      this.logger.error(
        `LLM stream failed. sessionId=${sessionId.toString()} assistantMessageId=${assistantMessage._id.toString()} reason=${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );

      const failedAssistantMessage =
        await this.messagesService.failAssistantMessage(assistantMessage._id);
      assistantSettled = true;

      yield {
        event: "assistant_message_failed",
        data: this.messagesService.toResponse(failedAssistantMessage),
      };
      // 에러 원문(OpenAI quota·DB 메시지 등)은 서버 로그에만 남긴다.
      yield {
        event: "error",
        data: { message: "LLM stream failed" },
      };
    } finally {
      // 여기서 yield하면 return() 중인 generator가 멈춰 락이 TTL까지 남는다. yield 없이 정리만 한다.
      if (assistantMessage && !assistantSettled) {
        await this.failAbandonedAssistantMessage(assistantMessage);
      }

      // 락 해제는 orchestrator 책임. HTTP 응답 종료는 controller에서 처리.
      await this.releaseLock(lock);
    }
  }

  private toContextMessage(message: MessageDocument): ContextMessage {
    return {
      id: message._id.toString(),
      role: message.role,
      content: message.content,
    };
  }

  private async failAbandonedAssistantMessage(
    assistantMessage: MessageDocument,
  ): Promise<void> {
    try {
      await this.messagesService.failAssistantMessage(assistantMessage._id);
    } catch (error) {
      this.logger.warn(
        `Abandoned assistant message not marked failed. assistantMessageId=${assistantMessage._id.toString()} reason=${this.toErrorMessage(error)}`,
      );
    }
  }

  private async releaseLock(lock: SessionLock): Promise<void> {
    await this.sessionLockService.release(lock);
  }

  private async updateSessionSummaryIfNeeded(
    session: SessionDocument,
  ): Promise<void> {
    try {
      const page = await this.sessionsService.findSummaryCandidates(
        session,
        this.summaryTriggerInterval,
        this.summaryInitialMessageLimit,
        this.summaryMessageLimit,
      );

      if (!page.shouldUpdate) {
        return;
      }

      const stateSummary = await this.openAiService.generateSessionSummary(
        session.stateSummary,
        page.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      );
      if (!page.summaryCursorMessageId) {
        return;
      }

      await this.sessionsService.updateStateSummary(
        session._id,
        stateSummary,
        page.summaryCursorMessageId,
      );
    } catch (error) {
      this.logger.warn(
        `Session summary update skipped. sessionId=${session._id.toString()} reason=${this.toErrorMessage(error)}`,
      );
    }
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === "string") {
      return error;
    }

    return "Unknown error";
  }
}
