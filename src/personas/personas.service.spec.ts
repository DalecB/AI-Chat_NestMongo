import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { Types } from "mongoose";

import {
  clearAllCollections,
  InMemoryMongo,
  startInMemoryMongo,
  stopInMemoryMongo,
} from "../../test/utils/in-memory-mongo";
import { Persona, PersonaSchema } from "./schemas/persona.schema";
import { PersonasService } from "./personas.service";

describe("PersonasService", () => {
  let mongo: InMemoryMongo;
  let service: PersonasService;

  beforeAll(async () => {
    mongo = await startInMemoryMongo();

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.uri),
        MongooseModule.forFeature([
          { name: Persona.name, schema: PersonaSchema },
        ]),
      ],
      providers: [PersonasService],
    }).compile();

    service = moduleRef.get(PersonasService);
  });

  afterAll(async () => {
    await stopInMemoryMongo(mongo);
  });

  beforeEach(async () => {
    await clearAllCollections(mongo);
  });

  function baseInput(
    userId: Types.ObjectId,
    overrides: Partial<Parameters<typeof service.create>[0]> = {},
  ) {
    return {
      name: "테스트 페르소나",
      description: "desc",
      profile: "profile",
      personality: "personality",
      speakingStyle: "casual",
      scenario: "scenario",
      greetingMessage: "hi",
      userId,
      isPublic: false,
      ...overrides,
    };
  }

  describe("create", () => {
    it("기본 isPublic=false, systemPrompt가 빌드되어 저장됨", async () => {
      const userId = new Types.ObjectId();
      const persona = await service.create(baseInput(userId));

      expect(persona.isPublic).toBe(false);
      expect(persona.userId.equals(userId)).toBe(true);
      expect(persona.systemPrompt.length).toBeGreaterThan(0);
      expect(persona.systemPrompt).toContain("테스트 페르소나");
    });
  });

  describe("updateOwned. 비공개 페르소나 수정", () => {
    it("소유자가 비공개 페르소나 필드 수정 가능", async () => {
      const userId = new Types.ObjectId();
      const persona = await service.create(baseInput(userId));

      const updated = await service.updateOwned(persona._id, userId, {
        name: "변경된 이름",
        personality: "차분함",
      });

      expect(updated.name).toBe("변경된 이름");
      expect(updated.personality).toBe("차분함");
      expect(updated.systemPrompt).toContain("변경된 이름");
    });

    it("비공개 → 공개 전환 가능", async () => {
      const userId = new Types.ObjectId();
      const persona = await service.create(baseInput(userId));

      const updated = await service.updateOwned(persona._id, userId, {
        isPublic: true,
      });

      expect(updated.isPublic).toBe(true);
    });

    it("타인의 비공개 페르소나 수정 시 Forbidden", async () => {
      const owner = new Types.ObjectId();
      const stranger = new Types.ObjectId();
      const persona = await service.create(baseInput(owner));

      await expect(
        service.updateOwned(persona._id, stranger, { name: "탈취" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("존재하지 않는 personaId → NotFound", async () => {
      await expect(
        service.updateOwned(new Types.ObjectId(), new Types.ObjectId(), {
          name: "x",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("updateOwned. 공개 후 잠금 (ADR-2 핵심)", () => {
    it("공개된 페르소나의 어떤 필드든 수정 시 BadRequest", async () => {
      const userId = new Types.ObjectId();
      const persona = await service.create(
        baseInput(userId, { isPublic: true }),
      );

      await expect(
        service.updateOwned(persona._id, userId, { name: "rename" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.updateOwned(persona._id, userId, { personality: "x" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("공개 → 비공개 되돌리기도 거부 (이미 다른 사용자가 대화 중일 수 있음)", async () => {
      const userId = new Types.ObjectId();
      const persona = await service.create(
        baseInput(userId, { isPublic: true }),
      );

      await expect(
        service.updateOwned(persona._id, userId, { isPublic: false }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("잠금 거부 후 DB 상태 그대로 유지", async () => {
      const userId = new Types.ObjectId();
      const persona = await service.create(
        baseInput(userId, { isPublic: true }),
      );

      await service
        .updateOwned(persona._id, userId, { name: "rename" })
        .catch(() => undefined);

      const reloaded = await service.findById(persona._id);
      expect(reloaded?.name).toBe("테스트 페르소나");
      expect(reloaded?.isPublic).toBe(true);
    });
  });

  describe("findAccessibleById", () => {
    it("내 비공개 페르소나 조회 가능", async () => {
      const userId = new Types.ObjectId();
      const persona = await service.create(baseInput(userId));

      const found = await service.findAccessibleById(persona._id, userId);
      expect(found?._id.equals(persona._id)).toBe(true);
    });

    it("타인의 공개 페르소나 조회 가능", async () => {
      const owner = new Types.ObjectId();
      const viewer = new Types.ObjectId();
      const persona = await service.create(
        baseInput(owner, { isPublic: true }),
      );

      const found = await service.findAccessibleById(persona._id, viewer);
      expect(found?._id.equals(persona._id)).toBe(true);
    });

    it("타인의 비공개 페르소나 조회 시 null", async () => {
      const owner = new Types.ObjectId();
      const viewer = new Types.ObjectId();
      const persona = await service.create(baseInput(owner));

      const found = await service.findAccessibleById(persona._id, viewer);
      expect(found).toBeNull();
    });
  });

  describe("findMine / findPublicRecent", () => {
    it("findMine은 본인 소유만 반환 (public/private 모두)", async () => {
      const me = new Types.ObjectId();
      const other = new Types.ObjectId();
      await service.create(baseInput(me, { name: "내 비공개" }));
      await service.create(baseInput(me, { name: "내 공개", isPublic: true }));
      await service.create(
        baseInput(other, { name: "남의 공개", isPublic: true }),
      );

      const mine = await service.findMine(me);
      const names = mine.map((p) => p.name).sort();
      expect(names).toEqual(["내 공개", "내 비공개"]);
    });

    it("findPublicRecent는 공개 페르소나만, 소유자 무관", async () => {
      const a = new Types.ObjectId();
      const b = new Types.ObjectId();
      await service.create(baseInput(a, { name: "공개1", isPublic: true }));
      await service.create(baseInput(a, { name: "비공개", isPublic: false }));
      await service.create(baseInput(b, { name: "공개2", isPublic: true }));

      const list = await service.findPublicRecent();
      const names = list.map((p) => p.name).sort();
      expect(names).toEqual(["공개1", "공개2"]);
    });
  });
});
