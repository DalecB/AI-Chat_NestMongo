import { HttpException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Types } from "mongoose";

import { OpenAiService } from "../llm/openai.service";
import { PersonasService } from "../personas/personas.service";
import { ContextCacheService } from "../redis/context-cache.service";
import { SessionLockService } from "../redis/session-lock.service";
import { SessionsService } from "../sessions/sessions.service";
import { UserMemoriesService } from "../users/user-memories.service";

import { ChatOrchestratorService, ChatStreamEvent } from "./chat-orchestrator.service";
import { MessagesService } from "./messages.service";

interface MockBundle {
  service: ChatOrchestratorService;
  messages: { [K in keyof MessagesService]?: jest.Mock };
  sessions: { [K in keyof SessionsService]?: jest.Mock };
  personas: { [K in keyof PersonasService]?: jest.Mock };
  userMemories: { [K in keyof UserMemoriesService]?: jest.Mock };
  openAi: { [K in keyof OpenAiService]?: jest.Mock };
  cache: { [K in keyof ContextCacheService]?: jest.Mock };
  lock: { [K in keyof SessionLockService]?: jest.Mock };
}

function makeStreamChunks(parts: string[], usage?: { p: number; c: number; t: number }) {
  return async function* () {
    for (const content of parts) {
      yield { choices: [{ delta: { content } }] };
    }
    if (usage) {
      yield {
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: usage.p,
          completion_tokens: usage.c,
          total_tokens: usage.t,
        },
      };
    }
  };
}

async function buildService(): Promise<MockBundle> {
  const messages = {
    create: jest.fn(),
    completeAssistantMessage: jest.fn(),
    failAssistantMessage: jest.fn(),
    findRecentBySession: jest.fn().mockResolvedValue([]),
    toResponse: jest.fn((m: { _id: Types.ObjectId; role: string }) => ({
      id: m._id.toString(),
      role: m.role,
    })),
  };
  const sessions = {
    findOwnedOrThrow: jest.fn(),
    touchMessageAt: jest.fn().mockResolvedValue(undefined),
    addTokenUsage: jest.fn().mockResolvedValue(undefined),
    findSummaryCandidates: jest
      .fn()
      .mockResolvedValue({ messages: [], shouldUpdate: false, summaryCursorMessageId: null }),
    updateStateSummary: jest.fn().mockResolvedValue(undefined),
  };
  const personas = { findAccessibleById: jest.fn() };
  const userMemories = { findPromptMemories: jest.fn().mockResolvedValue([]) };
  const openAi = {
    generateStream: jest.fn(),
    generateSessionSummary: jest.fn(),
  };
  const cache = {
    getContextWithFallback: jest.fn(),
    pushMessage: jest.fn().mockResolvedValue(undefined),
  };
  const lock = {
    acquire: jest.fn(),
    release: jest.fn().mockResolvedValue(undefined),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      ChatOrchestratorService,
      { provide: MessagesService, useValue: messages },
      { provide: SessionsService, useValue: sessions },
      { provide: PersonasService, useValue: personas },
      { provide: UserMemoriesService, useValue: userMemories },
      { provide: OpenAiService, useValue: openAi },
      { provide: ContextCacheService, useValue: cache },
      { provide: SessionLockService, useValue: lock },
    ],
  }).compile();

  return {
    service: moduleRef.get(ChatOrchestratorService),
    messages,
    sessions,
    personas,
    userMemories,
    openAi,
    cache,
    lock,
  };
}

async function collectEvents(
  generator: AsyncGenerator<ChatStreamEvent>,
): Promise<{ events: ChatStreamEvent[]; error: unknown }> {
  const events: ChatStreamEvent[] = [];

  try {
    for await (const event of generator) {
      events.push(event);
    }
    return { events, error: null };
  } catch (error) {
    return { events, error };
  }
}

function makeMessageDoc(role: "user" | "assistant", id = new Types.ObjectId()) {
  return {
    _id: id,
    role,
    content: "",
    createdAt: new Date(),
  };
}

function setupHappyPath(bundle: MockBundle) {
  const sessionId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const personaId = new Types.ObjectId();
  const session = { _id: sessionId, personaId, stateSummary: null };
  const persona = { _id: personaId, systemPrompt: "system-prompt" };
  const userMessage = makeMessageDoc("user");
  const assistantMessage = makeMessageDoc("assistant");
  const completedAssistant = {
    ...assistantMessage,
    content: "hello world",
    streamStatus: "completed",
  };

  bundle.sessions.findOwnedOrThrow!.mockResolvedValue(session);
  bundle.personas.findAccessibleById!.mockResolvedValue(persona);
  bundle.lock.acquire!.mockResolvedValue({ key: "lock:session:x", ownerId: "uuid-1" });
  bundle.messages.create!
    .mockResolvedValueOnce(userMessage)
    .mockResolvedValueOnce(assistantMessage);
  bundle.cache.getContextWithFallback!.mockImplementation(async (_id, fb) => {
    return fb();
  });
  bundle.messages.completeAssistantMessage!.mockResolvedValue(completedAssistant);

  return { sessionId, userId, session, persona, userMessage, assistantMessage, completedAssistant };
}

describe("ChatOrchestratorService.streamMessage", () => {
  describe("성공 경로", () => {
    it("SSE 이벤트 시퀀스: user_message_saved → assistant_message_started → chunk* → assistant_message_completed → done", async () => {
      const bundle = await buildService();
      const { sessionId, userId } = setupHappyPath(bundle);
      bundle.openAi.generateStream!.mockResolvedValue(
        makeStreamChunks(["hello ", "world"], { p: 5, c: 7, t: 12 })(),
      );

      const { events, error } = await collectEvents(
        bundle.service.streamMessage({ sessionId, userId, content: "hi" }),
      );

      expect(error).toBeNull();
      const names = events.map((e) => e.event);
      expect(names).toEqual([
        "user_message_saved",
        "assistant_message_started",
        "chunk",
        "chunk",
        "assistant_message_completed",
        "done",
      ]);
      const chunkContents = events
        .filter((e) => e.event === "chunk")
        .map((e) => (e.data as { content: string }).content);
      expect(chunkContents.join("")).toBe("hello world");
    });

    it("권한 검증이 락 acquire보다 먼저", async () => {
      const bundle = await buildService();
      const userId = new Types.ObjectId();
      const sessionId = new Types.ObjectId();
      bundle.sessions.findOwnedOrThrow!.mockResolvedValue({
        _id: sessionId,
        personaId: new Types.ObjectId(),
        stateSummary: null,
      });
      bundle.personas.findAccessibleById!.mockResolvedValue(null);

      const { error } = await collectEvents(
        bundle.service.streamMessage({ sessionId, userId, content: "hi" }),
      );

      expect(error).toBeInstanceOf(NotFoundException);
      expect(bundle.lock.acquire).not.toHaveBeenCalled();
      expect(bundle.messages.create).not.toHaveBeenCalled();
    });

    it("OpenAI generateStream에 systemPrompt + contextMessages + userMemories + sessionSummary 전달", async () => {
      const bundle = await buildService();
      const ctx = setupHappyPath(bundle);
      ctx.session.stateSummary = "prior state" as never;
      bundle.userMemories.findPromptMemories!.mockResolvedValue(["likes coffee"]);
      bundle.openAi.generateStream!.mockResolvedValue(
        makeStreamChunks(["ok"], { p: 1, c: 1, t: 2 })(),
      );

      await collectEvents(
        bundle.service.streamMessage({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          content: "hi",
        }),
      );

      const [systemPrompt, contextMessages, options] =
        bundle.openAi.generateStream!.mock.calls[0];
      expect(systemPrompt).toBe("system-prompt");
      expect(Array.isArray(contextMessages)).toBe(true);
      expect(options).toEqual({
        userMemories: ["likes coffee"],
        sessionSummary: "prior state",
      });
    });

    it("assistant placeholder를 LLM 호출 전에 insert (streaming 상태)", async () => {
      const bundle = await buildService();
      const ctx = setupHappyPath(bundle);
      let placeholderInsertedBeforeStream = false;
      bundle.openAi.generateStream!.mockImplementation(async () => {
        placeholderInsertedBeforeStream =
          bundle.messages.create!.mock.calls.length === 2;
        return makeStreamChunks(["a"], { p: 1, c: 1, t: 2 })();
      });

      await collectEvents(
        bundle.service.streamMessage({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          content: "hi",
        }),
      );

      expect(placeholderInsertedBeforeStream).toBe(true);
      const placeholderCall = bundle.messages.create!.mock.calls[1][0];
      expect(placeholderCall).toMatchObject({
        role: "assistant",
        content: "",
        streamStatus: "streaming",
      });
    });

    it("마지막 청크 usage가 도착하면 completeAssistantMessage에 tokenUsage 전달, addTokenUsage 누적", async () => {
      const bundle = await buildService();
      const ctx = setupHappyPath(bundle);
      bundle.openAi.generateStream!.mockResolvedValue(
        makeStreamChunks(["hi"], { p: 5, c: 7, t: 12 })(),
      );

      await collectEvents(
        bundle.service.streamMessage({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          content: "hi",
        }),
      );

      expect(bundle.messages.completeAssistantMessage).toHaveBeenCalledWith(
        ctx.assistantMessage._id,
        "hi",
        { prompt: 5, completion: 7, total: 12 },
      );
      expect(bundle.sessions.addTokenUsage).toHaveBeenCalledWith(ctx.sessionId, {
        prompt: 5,
        completion: 7,
        total: 12,
      });
    });

    it("usage 누락 시 tokenUsage default(0,0,0)로 저장 (클라이언트 early abort 시뮬레이션)", async () => {
      const bundle = await buildService();
      const ctx = setupHappyPath(bundle);
      bundle.openAi.generateStream!.mockResolvedValue(
        makeStreamChunks(["hi"])(),
      );

      await collectEvents(
        bundle.service.streamMessage({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          content: "hi",
        }),
      );

      expect(bundle.messages.completeAssistantMessage).toHaveBeenCalledWith(
        ctx.assistantMessage._id,
        "hi",
        { prompt: 0, completion: 0, total: 0 },
      );
    });

    it("완료된 assistant 메시지를 contextCache에 push", async () => {
      const bundle = await buildService();
      const ctx = setupHappyPath(bundle);
      bundle.openAi.generateStream!.mockResolvedValue(
        makeStreamChunks(["hi"], { p: 1, c: 1, t: 2 })(),
      );

      await collectEvents(
        bundle.service.streamMessage({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          content: "hi",
        }),
      );

      // 첫 push는 user 메시지(fallback에 없을 때), 두 번째는 완료된 assistant
      const pushCalls = bundle.cache.pushMessage!.mock.calls;
      const lastPush = pushCalls[pushCalls.length - 1];
      expect(lastPush[1]).toMatchObject({
        id: ctx.completedAssistant._id.toString(),
        role: "assistant",
      });
    });
  });

  describe("실패 경로 (ADR-6)", () => {
    it("LLM 스트림 중간 throw → failAssistantMessage + assistant_message_failed + error 이벤트", async () => {
      const bundle = await buildService();
      const ctx = setupHappyPath(bundle);
      const failedDoc = {
        ...ctx.assistantMessage,
        streamStatus: "failed",
      };
      bundle.messages.failAssistantMessage!.mockResolvedValue(failedDoc);
      bundle.openAi.generateStream!.mockResolvedValue(
        (async function* () {
          yield { choices: [{ delta: { content: "partial" } }] };
          throw new Error("LLM down");
        })(),
      );

      const { events, error } = await collectEvents(
        bundle.service.streamMessage({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          content: "hi",
        }),
      );

      expect(error).toBeNull();
      const names = events.map((e) => e.event);
      expect(names).toContain("chunk");
      expect(names).toContain("assistant_message_failed");
      expect(names).toContain("error");
      expect(names).not.toContain("assistant_message_completed");
      expect(names).not.toContain("done");
      expect(bundle.messages.failAssistantMessage).toHaveBeenCalledWith(
        ctx.assistantMessage._id,
      );
    });

    it("권한 검증 실패는 그대로 상위로 throw, 락 미획득", async () => {
      const bundle = await buildService();
      bundle.sessions.findOwnedOrThrow!.mockRejectedValue(
        new NotFoundException("Session not found"),
      );

      const { error } = await collectEvents(
        bundle.service.streamMessage({
          sessionId: new Types.ObjectId(),
          userId: new Types.ObjectId(),
          content: "hi",
        }),
      );

      expect(error).toBeInstanceOf(NotFoundException);
      expect(bundle.lock.acquire).not.toHaveBeenCalled();
    });

    it("락 acquire 실패(429)는 그대로 throw, 메시지 insert 없음", async () => {
      const bundle = await buildService();
      const ctx = setupHappyPath(bundle);
      bundle.lock.acquire!.mockReset();
      bundle.lock.acquire!.mockRejectedValue(
        new HttpException("Session is already processing a message", 429),
      );

      const { error } = await collectEvents(
        bundle.service.streamMessage({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          content: "hi",
        }),
      );

      expect(error).toBeInstanceOf(HttpException);
      expect(bundle.messages.create).not.toHaveBeenCalled();
    });
  });

  describe("락 해제 (ADR-8)", () => {
    it("성공 경로에서 finally release", async () => {
      const bundle = await buildService();
      const ctx = setupHappyPath(bundle);
      bundle.openAi.generateStream!.mockResolvedValue(
        makeStreamChunks(["hi"], { p: 1, c: 1, t: 2 })(),
      );

      await collectEvents(
        bundle.service.streamMessage({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          content: "hi",
        }),
      );

      expect(bundle.lock.release).toHaveBeenCalledTimes(1);
    });

    it("LLM 실패 경로에서도 finally release", async () => {
      const bundle = await buildService();
      const ctx = setupHappyPath(bundle);
      bundle.messages.failAssistantMessage!.mockResolvedValue(ctx.assistantMessage);
      bundle.openAi.generateStream!.mockResolvedValue(
        (async function* () {
          yield* [];
          throw new Error("LLM down");
        })(),
      );

      await collectEvents(
        bundle.service.streamMessage({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          content: "hi",
        }),
      );

      expect(bundle.lock.release).toHaveBeenCalledTimes(1);
    });

    it("권한 검증 실패 경로에서는 release 호출 안 됨 (acquire 자체가 없었음)", async () => {
      const bundle = await buildService();
      bundle.sessions.findOwnedOrThrow!.mockRejectedValue(new NotFoundException());

      await collectEvents(
        bundle.service.streamMessage({
          sessionId: new Types.ObjectId(),
          userId: new Types.ObjectId(),
          content: "hi",
        }),
      );

      expect(bundle.lock.release).not.toHaveBeenCalled();
    });
  });

  describe("summary 트리거 (ADR-10)", () => {
    it("shouldUpdate=false면 generateSessionSummary 호출 안 함", async () => {
      const bundle = await buildService();
      const ctx = setupHappyPath(bundle);
      bundle.openAi.generateStream!.mockResolvedValue(
        makeStreamChunks(["hi"], { p: 1, c: 1, t: 2 })(),
      );
      bundle.sessions.findSummaryCandidates!.mockResolvedValue({
        messages: [],
        shouldUpdate: false,
        summaryCursorMessageId: null,
      });

      await collectEvents(
        bundle.service.streamMessage({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          content: "hi",
        }),
      );

      expect(bundle.openAi.generateSessionSummary).not.toHaveBeenCalled();
      expect(bundle.sessions.updateStateSummary).not.toHaveBeenCalled();
    });

    it("shouldUpdate=true면 summary 생성 + updateStateSummary 호출", async () => {
      const bundle = await buildService();
      const ctx = setupHappyPath(bundle);
      const cursorId = new Types.ObjectId();
      bundle.openAi.generateStream!.mockResolvedValue(
        makeStreamChunks(["hi"], { p: 1, c: 1, t: 2 })(),
      );
      bundle.sessions.findSummaryCandidates!.mockResolvedValue({
        messages: [
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
        ],
        shouldUpdate: true,
        summaryCursorMessageId: cursorId,
      });
      bundle.openAi.generateSessionSummary!.mockResolvedValue("new summary");

      await collectEvents(
        bundle.service.streamMessage({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          content: "hi",
        }),
      );

      expect(bundle.openAi.generateSessionSummary).toHaveBeenCalled();
      expect(bundle.sessions.updateStateSummary).toHaveBeenCalledWith(
        ctx.sessionId,
        "new summary",
        cursorId,
      );
    });

    it("generateSessionSummary throw 시 채팅은 done까지 정상 종료 (warn log)", async () => {
      const bundle = await buildService();
      const ctx = setupHappyPath(bundle);
      bundle.openAi.generateStream!.mockResolvedValue(
        makeStreamChunks(["hi"], { p: 1, c: 1, t: 2 })(),
      );
      bundle.sessions.findSummaryCandidates!.mockResolvedValue({
        messages: [{ role: "user", content: "u1" }],
        shouldUpdate: true,
        summaryCursorMessageId: new Types.ObjectId(),
      });
      bundle.openAi.generateSessionSummary!.mockRejectedValue(
        new Error("summary down"),
      );

      const { events, error } = await collectEvents(
        bundle.service.streamMessage({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          content: "hi",
        }),
      );

      expect(error).toBeNull();
      expect(events.map((e) => e.event)).toContain("done");
      expect(bundle.sessions.updateStateSummary).not.toHaveBeenCalled();
    });

    it("summaryCursorMessageId가 null이면 updateStateSummary 호출 안 함", async () => {
      const bundle = await buildService();
      const ctx = setupHappyPath(bundle);
      bundle.openAi.generateStream!.mockResolvedValue(
        makeStreamChunks(["hi"], { p: 1, c: 1, t: 2 })(),
      );
      bundle.sessions.findSummaryCandidates!.mockResolvedValue({
        messages: [{ role: "user", content: "u1" }],
        shouldUpdate: true,
        summaryCursorMessageId: null,
      });
      bundle.openAi.generateSessionSummary!.mockResolvedValue("summary");

      await collectEvents(
        bundle.service.streamMessage({
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          content: "hi",
        }),
      );

      expect(bundle.sessions.updateStateSummary).not.toHaveBeenCalled();
    });
  });
});
