import { BadRequestException } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { Types } from "mongoose";

import {
  clearAllCollections,
  InMemoryMongo,
  startInMemoryMongo,
  stopInMemoryMongo,
} from "../../test/utils/in-memory-mongo";
import { Message, MessageSchema } from "./schemas/message.schema";
import { MessagesService } from "./messages.service";

describe("MessagesService", () => {
  let mongo: InMemoryMongo;
  let service: MessagesService;

  beforeAll(async () => {
    mongo = await startInMemoryMongo();

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.uri),
        MongooseModule.forFeature([
          { name: Message.name, schema: MessageSchema },
        ]),
      ],
      providers: [MessagesService],
    }).compile();

    service = moduleRef.get(MessagesService);
  });

  afterAll(async () => {
    await stopInMemoryMongo(mongo);
  });

  beforeEach(async () => {
    await clearAllCollections(mongo);
  });

  async function seedMessage(
    overrides: Partial<{
      sessionId: Types.ObjectId;
      userId: Types.ObjectId;
      role: "user" | "assistant";
      content: string;
      streamStatus: "completed" | "streaming" | "failed";
      tokenUsage: { prompt: number; completion: number; total: number } | null;
    }> = {},
  ) {
    return service.create({
      sessionId: overrides.sessionId ?? new Types.ObjectId(),
      userId: overrides.userId ?? new Types.ObjectId(),
      role: overrides.role ?? "user",
      content: overrides.content ?? "hi",
      tokenUsage: overrides.tokenUsage ?? null,
      streamStatus: overrides.streamStatus ?? "completed",
    });
  }

  describe("create", () => {
    it("user 메시지 기본 streamStatus='completed', tokenUsage null", async () => {
      const msg = await service.create({
        sessionId: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        role: "user",
        content: "hello",
      });
      expect(msg.streamStatus).toBe("completed");
      expect(msg.tokenUsage).toBeNull();
      expect(msg.content).toBe("hello");
    });

    it("assistant placeholder는 streamStatus='streaming', content='', tokenUsage=null로 insert 가능", async () => {
      const msg = await service.create({
        sessionId: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        role: "assistant",
        content: "",
        tokenUsage: null,
        streamStatus: "streaming",
      });
      expect(msg.streamStatus).toBe("streaming");
      expect(msg.content).toBe("");
    });
  });

  describe("completeAssistantMessage. ADR-6 final update", () => {
    it("streaming → completed, content/tokenUsage 저장", async () => {
      const placeholder = await seedMessage({
        role: "assistant",
        content: "",
        streamStatus: "streaming",
      });

      const completed = await service.completeAssistantMessage(
        placeholder._id,
        "final content",
        { prompt: 3, completion: 5, total: 8 },
      );

      expect(completed.streamStatus).toBe("completed");
      expect(completed.content).toBe("final content");
      expect(completed.tokenUsage).toMatchObject({
        prompt: 3,
        completion: 5,
        total: 8,
      });
    });

    it("존재하지 않는 messageId → BadRequest", async () => {
      await expect(
        service.completeAssistantMessage(
          new Types.ObjectId(),
          "x",
          { prompt: 0, completion: 0, total: 0 },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("failAssistantMessage. ADR-6 실패 경로", () => {
    it("streaming → failed", async () => {
      const placeholder = await seedMessage({
        role: "assistant",
        content: "partial",
        streamStatus: "streaming",
      });

      const failed = await service.failAssistantMessage(placeholder._id);

      expect(failed.streamStatus).toBe("failed");
      // partial content는 그대로 유지. fail이 content를 지우지 않는다
      expect(failed.content).toBe("partial");
    });

    it("존재하지 않는 messageId → BadRequest", async () => {
      await expect(
        service.failAssistantMessage(new Types.ObjectId()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("findRecentBySession. 컨텍스트 윈도우 (ADR-3)", () => {
    it("(sessionId, createdAt desc).limit(N) 후 ascending으로 reverse 반환", async () => {
      const sessionId = new Types.ObjectId();
      const userId = new Types.ObjectId();

      for (let i = 0; i < 5; i += 1) {
        await seedMessage({
          sessionId,
          userId,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `m${i}`,
        });
        await new Promise((resolve) => setTimeout(resolve, 3));
      }

      const recent = await service.findRecentBySession(sessionId, 3);

      expect(recent.length).toBe(3);
      expect(recent.map((m) => m.content)).toEqual(["m2", "m3", "m4"]);
    });

    it("다른 세션 메시지는 섞이지 않음", async () => {
      const a = new Types.ObjectId();
      const b = new Types.ObjectId();
      const userId = new Types.ObjectId();
      await seedMessage({ sessionId: a, userId, content: "a1" });
      await seedMessage({ sessionId: b, userId, content: "b1" });

      const recent = await service.findRecentBySession(a, 8);
      expect(recent.map((m) => m.content)).toEqual(["a1"]);
    });
  });

  describe("findPageBySession. cursor 페이지네이션 (100건)", () => {
    it("100건 미만이면 nextCursor=null, items는 ascending", async () => {
      const sessionId = new Types.ObjectId();
      const userId = new Types.ObjectId();
      for (let i = 0; i < 5; i += 1) {
        await seedMessage({ sessionId, userId, content: `m${i}` });
        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      const page = await service.findPageBySession(sessionId);

      expect(page.nextCursor).toBeNull();
      expect(page.items.length).toBe(5);
      expect(page.items.map((m) => m.content)).toEqual([
        "m0",
        "m1",
        "m2",
        "m3",
        "m4",
      ]);
    });

    it("100건 초과 시 nextCursor가 가장 오래된 아이템 _id", async () => {
      const sessionId = new Types.ObjectId();
      const userId = new Types.ObjectId();
      for (let i = 0; i < 110; i += 1) {
        await seedMessage({ sessionId, userId, content: `m${i}` });
      }

      const page = await service.findPageBySession(sessionId);

      expect(page.items.length).toBe(100);
      expect(page.nextCursor).not.toBeNull();
    });

    it("유효하지 않은 cursor → BadRequest", async () => {
      await expect(
        service.findPageBySession(new Types.ObjectId(), new Types.ObjectId()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("cursor follow → 다음 페이지 정확히 연결", async () => {
      const sessionId = new Types.ObjectId();
      const userId = new Types.ObjectId();
      for (let i = 0; i < 110; i += 1) {
        await seedMessage({ sessionId, userId, content: `m${i}` });
      }

      const firstPage = await service.findPageBySession(sessionId);
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = await service.findPageBySession(
        sessionId,
        new Types.ObjectId(firstPage.nextCursor!),
      );
      expect(secondPage.items.length).toBe(10);
      // 두 페이지가 시간 순으로 이어지고 중복이 없음
      const firstIds = new Set(firstPage.items.map((m) => m._id.toString()));
      for (const item of secondPage.items) {
        expect(firstIds.has(item._id.toString())).toBe(false);
      }
    });
  });

  describe("aggregateTokenStatsByDay. ADR-4 통계", () => {
    it("assistant 메시지의 tokenUsage.total을 일자별 합산, role:'user'는 제외", async () => {
      const userId = new Types.ObjectId();
      const sessionId = new Types.ObjectId();
      await seedMessage({
        sessionId,
        userId,
        role: "assistant",
        tokenUsage: { prompt: 1, completion: 2, total: 3 },
      });
      await seedMessage({
        sessionId,
        userId,
        role: "assistant",
        tokenUsage: { prompt: 4, completion: 5, total: 9 },
      });
      // user 메시지는 합산에서 제외 (tokenUsage null)
      await seedMessage({ sessionId, userId, role: "user", content: "u" });

      const now = new Date();
      const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const to = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const stats = await service.aggregateTokenStatsByDay(userId, from, to);

      const totalSum = stats.reduce((acc, item) => acc + item.totalTokens, 0);
      const messageSum = stats.reduce(
        (acc, item) => acc + item.messageCount,
        0,
      );
      expect(totalSum).toBe(12);
      expect(messageSum).toBe(2);
    });

    it("다른 사용자 메시지는 절대 포함되지 않음", async () => {
      const me = new Types.ObjectId();
      const other = new Types.ObjectId();
      const sessionId = new Types.ObjectId();
      await seedMessage({
        sessionId,
        userId: other,
        role: "assistant",
        tokenUsage: { prompt: 100, completion: 100, total: 200 },
      });
      await seedMessage({
        sessionId,
        userId: me,
        role: "assistant",
        tokenUsage: { prompt: 1, completion: 1, total: 2 },
      });

      const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const stats = await service.aggregateTokenStatsByDay(me, from, to);

      const totalSum = stats.reduce((acc, item) => acc + item.totalTokens, 0);
      expect(totalSum).toBe(2);
    });

    it("기간 밖 메시지는 결과에 포함되지 않음", async () => {
      const userId = new Types.ObjectId();
      const sessionId = new Types.ObjectId();
      await seedMessage({
        sessionId,
        userId,
        role: "assistant",
        tokenUsage: { prompt: 1, completion: 1, total: 5 },
      });

      const past = new Date("2020-01-01");
      const pastEnd = new Date("2020-01-02");
      const stats = await service.aggregateTokenStatsByDay(
        userId,
        past,
        pastEnd,
      );
      expect(stats).toEqual([]);
    });
  });

  describe("toResponse", () => {
    it("ObjectId/Date를 직렬화 가능한 형태로, 내부 필드는 제외", async () => {
      const sessionId = new Types.ObjectId();
      const userId = new Types.ObjectId();
      const msg = await seedMessage({
        sessionId,
        userId,
        content: "ok",
        role: "user",
      });

      const response = service.toResponse(msg);

      expect(response.id).toBe(msg._id.toString());
      expect(response.sessionId).toBe(sessionId.toString());
      expect(response.role).toBe("user");
      expect(response).not.toHaveProperty("userId");
      expect(response).not.toHaveProperty("__v");
    });
  });
});
