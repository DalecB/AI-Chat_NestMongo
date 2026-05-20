import { NotFoundException } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { Types } from "mongoose";

import {
  clearAllCollections,
  InMemoryMongo,
  startInMemoryMongo,
  stopInMemoryMongo,
} from "../../test/utils/in-memory-mongo";
import { UserMemory, UserMemorySchema } from "./schemas/user-memory.schema";
import { UserMemoriesService } from "./user-memories.service";

describe("UserMemoriesService", () => {
  let mongo: InMemoryMongo;
  let service: UserMemoriesService;

  beforeAll(async () => {
    mongo = await startInMemoryMongo();

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.uri),
        MongooseModule.forFeature([
          { name: UserMemory.name, schema: UserMemorySchema },
        ]),
      ],
      providers: [UserMemoriesService],
    }).compile();

    service = moduleRef.get(UserMemoriesService);
  });

  afterAll(async () => {
    await stopInMemoryMongo(mongo);
  });

  beforeEach(async () => {
    await clearAllCollections(mongo);
  });

  describe("create / findMine", () => {
    it("본인 메모리만 findMine에 노출", async () => {
      const me = new Types.ObjectId();
      const other = new Types.ObjectId();
      await service.create({ userId: me, content: "a" });
      await service.create({ userId: me, content: "b" });
      await service.create({ userId: other, content: "c" });

      const mine = await service.findMine(me);
      expect(mine.map((m) => m.content).sort()).toEqual(["a", "b"]);
    });

    it("findMine은 createdAt desc 정렬 (최신 우선)", async () => {
      const me = new Types.ObjectId();
      await service.create({ userId: me, content: "old" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await service.create({ userId: me, content: "new" });

      const mine = await service.findMine(me);
      expect(mine[0].content).toBe("new");
      expect(mine[1].content).toBe("old");
    });
  });

  describe("findPromptMemories", () => {
    it("최대 promptMemoryLimit(20)개만 반환", async () => {
      const me = new Types.ObjectId();
      for (let i = 0; i < 25; i += 1) {
        await service.create({ userId: me, content: `m${i}` });
      }

      const memories = await service.findPromptMemories(me);
      expect(memories.length).toBe(20);
    });

    it("ascending 순서(오래된 것 → 최신)로 반환. desc 20개 fetch 후 reverse", async () => {
      const me = new Types.ObjectId();
      for (let i = 0; i < 5; i += 1) {
        await service.create({ userId: me, content: `m${i}` });
        await new Promise((resolve) => setTimeout(resolve, 3));
      }

      const memories = await service.findPromptMemories(me);
      // 시간 순으로 m0(오래됨) ... m4(최신)
      expect(memories).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    });

    it("메모리 0개면 빈 배열 반환", async () => {
      const me = new Types.ObjectId();
      const memories = await service.findPromptMemories(me);
      expect(memories).toEqual([]);
    });

    it("타사용자 메모리는 leak되지 않음", async () => {
      const me = new Types.ObjectId();
      const other = new Types.ObjectId();
      await service.create({ userId: me, content: "mine" });
      await service.create({ userId: other, content: "theirs" });

      const memories = await service.findPromptMemories(me);
      expect(memories).toEqual(["mine"]);
    });
  });

  describe("deleteOwned", () => {
    it("본인 메모리 삭제 성공", async () => {
      const me = new Types.ObjectId();
      const memory = await service.create({ userId: me, content: "x" });

      await expect(
        service.deleteOwned(memory._id, me),
      ).resolves.toBeUndefined();

      const mine = await service.findMine(me);
      expect(mine).toEqual([]);
    });

    it("타인 메모리 삭제 시도 → NotFound, DB에 그대로 존재", async () => {
      const me = new Types.ObjectId();
      const other = new Types.ObjectId();
      const memory = await service.create({ userId: other, content: "theirs" });

      await expect(
        service.deleteOwned(memory._id, me),
      ).rejects.toBeInstanceOf(NotFoundException);

      const stillThere = await service.findMine(other);
      expect(stillThere.length).toBe(1);
    });

    it("존재하지 않는 id → NotFound", async () => {
      await expect(
        service.deleteOwned(new Types.ObjectId(), new Types.ObjectId()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("같은 메모리 두 번 삭제 시 두 번째는 NotFound (idempotent 아님)", async () => {
      const me = new Types.ObjectId();
      const memory = await service.create({ userId: me, content: "x" });

      await service.deleteOwned(memory._id, me);
      await expect(
        service.deleteOwned(memory._id, me),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
