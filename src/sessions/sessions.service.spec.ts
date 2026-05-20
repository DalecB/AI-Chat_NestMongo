import {
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import { Message, MessageSchema } from "../messages/schemas/message.schema";
import { Session, SessionSchema } from "./schemas/session.schema";
import { SessionsService } from "./sessions.service";

// ReplSet 필요. deleteOwnedWithMessages가 multi-document transaction 사용 (ADR-5).
describe("SessionsService", () => {
  let mongod: MongoMemoryReplSet;
  let service: SessionsService;

  beforeAll(async () => {
    mongod = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    const uri = mongod.getUri();
    await mongoose.connect(uri);

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Session.name, schema: SessionSchema },
          { name: Message.name, schema: MessageSchema },
        ]),
      ],
      providers: [SessionsService],
    }).compile();

    service = moduleRef.get(SessionsService);
  }, 120000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    const collections = await mongoose.connection.db!.collections();
    for (const collection of collections) {
      await collection.deleteMany({});
    }
  });

  describe("create / createWithGreeting", () => {
    it("create. lastMessageAt 기본값 null", async () => {
      const session = await service.create({
        userId: new Types.ObjectId(),
        personaId: new Types.ObjectId(),
      });
      expect(session.lastMessageAt).toBeNull();
    });

    it("createWithGreeting. 세션 + greeting 메시지, lastMessageAt이 greeting 시각", async () => {
      const userId = new Types.ObjectId();
      const personaId = new Types.ObjectId();

      const session = await service.createWithGreeting({
        userId,
        personaId,
        greetingMessage: "안녕!",
      });

      expect(session.lastMessageAt).not.toBeNull();

      const messages = await mongoose.connection.db!
        .collection("messages")
        .find({ sessionId: session._id })
        .toArray();
      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe("assistant");
      expect(messages[0].content).toBe("안녕!");
      expect(messages[0].streamStatus).toBe("completed");
    });
  });

  describe("findOwnedOrThrow", () => {
    it("존재하지 않으면 NotFound", async () => {
      await expect(
        service.findOwnedOrThrow(new Types.ObjectId(), new Types.ObjectId()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("다른 사용자 소유면 Forbidden", async () => {
      const owner = new Types.ObjectId();
      const stranger = new Types.ObjectId();
      const session = await service.create({
        userId: owner,
        personaId: new Types.ObjectId(),
      });

      await expect(
        service.findOwnedOrThrow(session._id, stranger),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("본인 소유는 정상 반환", async () => {
      const userId = new Types.ObjectId();
      const session = await service.create({
        userId,
        personaId: new Types.ObjectId(),
      });

      const found = await service.findOwnedOrThrow(session._id, userId);
      expect(found._id.equals(session._id)).toBe(true);
    });
  });

  describe("deleteOwnedWithMessages. cascade transaction", () => {
    it("세션 삭제 시 messages도 함께 삭제 (transaction)", async () => {
      const userId = new Types.ObjectId();
      const session = await service.createWithGreeting({
        userId,
        personaId: new Types.ObjectId(),
        greetingMessage: "hi",
      });
      const messageCollection = mongoose.connection.db!.collection("messages");
      await messageCollection.insertOne({
        sessionId: session._id,
        userId,
        role: "user",
        content: "hello",
        streamStatus: "completed",
        tokenUsage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await service.deleteOwnedWithMessages(session._id, userId);

      const sessionGone = await service.findById(session._id);
      expect(sessionGone).toBeNull();
      const remainingMessages = await messageCollection
        .find({ sessionId: session._id })
        .toArray();
      expect(remainingMessages).toEqual([]);
    });

    it("타인의 세션 삭제 시도 → Forbidden, 메시지 그대로", async () => {
      const owner = new Types.ObjectId();
      const stranger = new Types.ObjectId();
      const session = await service.createWithGreeting({
        userId: owner,
        personaId: new Types.ObjectId(),
        greetingMessage: "hi",
      });

      await expect(
        service.deleteOwnedWithMessages(session._id, stranger),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const stillExists = await service.findById(session._id);
      expect(stillExists).not.toBeNull();
    });
  });

  describe("findMinePage. cursor 페이지네이션", () => {
    it("기본 정렬: lastMessageAt desc, tie-break createdAt/_id desc", async () => {
      const userId = new Types.ObjectId();
      const now = Date.now();

      const a = await service.create({
        userId,
        personaId: new Types.ObjectId(),
      });
      const b = await service.create({
        userId,
        personaId: new Types.ObjectId(),
      });
      await service.touchMessageAt(a._id, new Date(now - 5000));
      await service.touchMessageAt(b._id, new Date(now - 1000));

      const page = await service.findMinePage(userId);
      expect(page.items[0]._id.equals(b._id)).toBe(true);
      expect(page.items[1]._id.equals(a._id)).toBe(true);
    });

    it("lastMessageAt=null 세션도 페이지네이션에 포함", async () => {
      const userId = new Types.ObjectId();
      const created = await service.create({
        userId,
        personaId: new Types.ObjectId(),
      });

      const page = await service.findMinePage(userId);
      expect(page.items.some((s) => s._id.equals(created._id))).toBe(true);
    });

    it("21건 이상이면 nextCursor 발급, follow로 두번째 페이지 정상 조회", async () => {
      const userId = new Types.ObjectId();
      const sessions = [];
      for (let i = 0; i < 25; i += 1) {
        const session = await service.create({
          userId,
          personaId: new Types.ObjectId(),
        });
        await service.touchMessageAt(
          session._id,
          new Date(Date.now() + i * 1000),
        );
        sessions.push(session);
      }

      const first = await service.findMinePage(userId);
      expect(first.items.length).toBe(20);
      expect(first.nextCursor).not.toBeNull();

      const second = await service.findMinePage(
        userId,
        new Types.ObjectId(first.nextCursor!),
      );
      expect(second.items.length).toBe(5);

      const firstIds = new Set(first.items.map((s) => s._id.toString()));
      for (const item of second.items) {
        expect(firstIds.has(item._id.toString())).toBe(false);
      }
    });
  });

  describe("touchMessageAt / addTokenUsage. ADR-5 denormalize", () => {
    it("touchMessageAt이 lastMessageAt만 set, 다른 필드는 그대로", async () => {
      const userId = new Types.ObjectId();
      const session = await service.create({
        userId,
        personaId: new Types.ObjectId(),
      });
      const stamp = new Date();

      await service.touchMessageAt(session._id, stamp);

      const reloaded = await service.findById(session._id);
      expect(reloaded?.lastMessageAt?.getTime()).toBe(stamp.getTime());
      expect(reloaded?.tokenUsage).toMatchObject({
        prompt: 0,
        completion: 0,
        total: 0,
      });
    });

    it("addTokenUsage가 prompt/completion/total $inc 누적", async () => {
      const session = await service.create({
        userId: new Types.ObjectId(),
        personaId: new Types.ObjectId(),
      });

      await service.addTokenUsage(session._id, {
        prompt: 3,
        completion: 5,
        total: 8,
      });
      await service.addTokenUsage(session._id, {
        prompt: 1,
        completion: 2,
        total: 3,
      });

      const reloaded = await service.findById(session._id);
      expect(reloaded?.tokenUsage).toMatchObject({
        prompt: 4,
        completion: 7,
        total: 11,
      });
    });
  });

  describe("findSummaryCandidates. ADR-10 트리거", () => {
    async function seedCompletedMessages(
      sessionId: Types.ObjectId,
      userId: Types.ObjectId,
      count: number,
    ) {
      const messageCollection = mongoose.connection.db!.collection("messages");
      const inserted = [];
      for (let i = 0; i < count; i += 1) {
        const result = await messageCollection.insertOne({
          sessionId,
          userId,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `m${i}`,
          tokenUsage: null,
          streamStatus: "completed",
          createdAt: new Date(Date.now() + i * 5),
          updatedAt: new Date(Date.now() + i * 5),
        });
        inserted.push(result.insertedId);
      }
      return inserted;
    }

    it("cursor=null + completed 미달 → shouldUpdate=false", async () => {
      const userId = new Types.ObjectId();
      const session = await service.create({
        userId,
        personaId: new Types.ObjectId(),
      });
      await seedCompletedMessages(session._id, userId, 4);

      const result = await service.findSummaryCandidates(session, 6, 6, 8);
      expect(result.shouldUpdate).toBe(false);
      expect(result.messages).toEqual([]);
    });

    it("cursor=null + completed 6개 → shouldUpdate=true, messages는 처음 6개", async () => {
      const userId = new Types.ObjectId();
      const session = await service.create({
        userId,
        personaId: new Types.ObjectId(),
      });
      await seedCompletedMessages(session._id, userId, 6);

      const result = await service.findSummaryCandidates(session, 6, 6, 8);
      expect(result.shouldUpdate).toBe(true);
      expect(result.messages.length).toBe(6);
      expect(result.summaryCursorMessageId).not.toBeNull();
    });

    it("cursor 이후 추가 6개 → 최신 summaryMessageLimit(8)개 ascending 반환", async () => {
      const userId = new Types.ObjectId();
      const ids = await (async () => {
        const sess = await service.create({
          userId,
          personaId: new Types.ObjectId(),
        });
        return { sess, ids: await seedCompletedMessages(sess._id, userId, 12) };
      })();
      const sessionDoc = await service.findById(ids.sess._id);
      sessionDoc!.summaryCursorMessageId = ids.ids[5] as unknown as Types.ObjectId;
      await sessionDoc!.save();

      const result = await service.findSummaryCandidates(sessionDoc!, 6, 6, 8);
      expect(result.shouldUpdate).toBe(true);
      expect(result.messages.length).toBe(8);
    });

    it("streamStatus='streaming' / 'failed' 메시지는 후보에서 제외", async () => {
      const userId = new Types.ObjectId();
      const session = await service.create({
        userId,
        personaId: new Types.ObjectId(),
      });
      const messageCollection = mongoose.connection.db!.collection("messages");
      // 6 completed 직전에 streaming/failed 메시지 섞임
      for (let i = 0; i < 5; i += 1) {
        await messageCollection.insertOne({
          sessionId: session._id,
          userId,
          role: "user",
          content: `c${i}`,
          tokenUsage: null,
          streamStatus: "completed",
          createdAt: new Date(Date.now() + i * 5),
          updatedAt: new Date(),
        });
      }
      await messageCollection.insertOne({
        sessionId: session._id,
        userId,
        role: "assistant",
        content: "streaming",
        tokenUsage: null,
        streamStatus: "streaming",
        createdAt: new Date(Date.now() + 100),
        updatedAt: new Date(),
      });
      await messageCollection.insertOne({
        sessionId: session._id,
        userId,
        role: "assistant",
        content: "failed",
        tokenUsage: null,
        streamStatus: "failed",
        createdAt: new Date(Date.now() + 200),
        updatedAt: new Date(),
      });

      const result = await service.findSummaryCandidates(session, 6, 6, 8);
      expect(result.shouldUpdate).toBe(false);
    });
  });

  describe("updateStateSummary", () => {
    it("stateSummary, summaryCursorMessageId, summaryUpdatedAt 동시 set", async () => {
      const session = await service.create({
        userId: new Types.ObjectId(),
        personaId: new Types.ObjectId(),
      });
      const cursor = new Types.ObjectId();

      await service.updateStateSummary(session._id, "summary content", cursor);

      const reloaded = await service.findById(session._id);
      expect(reloaded?.stateSummary).toBe("summary content");
      expect(reloaded?.summaryCursorMessageId?.equals(cursor)).toBe(true);
      expect(reloaded?.summaryUpdatedAt).not.toBeNull();
    });
  });
});
