import { Test } from "@nestjs/testing";
import RedisMock from "ioredis-mock";

import { ContextCacheService, ContextMessage } from "./context-cache.service";
import { REDIS_CLIENT } from "./redis.constants";

async function createService(redis: unknown): Promise<ContextCacheService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ContextCacheService,
      { provide: REDIS_CLIENT, useValue: redis },
    ],
  }).compile();

  return moduleRef.get(ContextCacheService);
}

const sessionId = "session-abc";
const cacheKey = `ctx:${sessionId}`;

function makeMessage(id: string, content = "msg"): ContextMessage {
  return { id, role: "user", content };
}

// ioredis-mock는 인스턴스 간 데이터를 공유함. 케이스마다 격리하기 위해 flush.
async function freshRedis(): Promise<InstanceType<typeof RedisMock>> {
  const redis = new RedisMock();
  await redis.flushall();
  return redis;
}

describe("ContextCacheService", () => {
  describe("getContextWithFallback. 캐시 hit", () => {
    it("Redis에 데이터 있을 때 head=최신을 reverse해서 ascending 반환, fallback 호출 안 됨", async () => {
      const redis = await freshRedis();
      const messages = [makeMessage("m1", "first"), makeMessage("m2", "second")];
      // head가 최신이므로 m2가 먼저 LPUSH되어야 head에 옴
      for (const message of messages) {
        await redis.lpush(cacheKey, JSON.stringify(message));
      }
      const fallback = jest.fn();
      const service = await createService(redis);

      const result = await service.getContextWithFallback(sessionId, fallback);

      expect(fallback).not.toHaveBeenCalled();
      expect(result.map((m) => m.id)).toEqual(["m1", "m2"]);
    });

    it("stale cache limitation: Redis hit이면 더 최신 Mongo fallback은 호출하지 않음", async () => {
      const redis = await freshRedis();
      const stale = [makeMessage("old-1"), makeMessage("old-2")];
      for (const message of stale) {
        await redis.lpush(cacheKey, JSON.stringify(message));
      }
      const fallback = jest
        .fn()
        .mockResolvedValue([makeMessage("fresh-1"), makeMessage("fresh-2")]);
      const service = await createService(redis);

      const result = await service.getContextWithFallback(sessionId, fallback);

      expect(fallback).not.toHaveBeenCalled();
      expect(result.map((m) => m.id)).toEqual(["old-1", "old-2"]);
    });
  });

  describe("getContextWithFallback. cache miss", () => {
    it("빈 리스트면 fallback 실행 + replace로 채움", async () => {
      const redis = await freshRedis();
      const messages = [makeMessage("m1"), makeMessage("m2")];
      const fallback = jest.fn().mockResolvedValue(messages);
      const service = await createService(redis);

      const result = await service.getContextWithFallback(sessionId, fallback);

      expect(fallback).toHaveBeenCalledTimes(1);
      expect(result).toEqual(messages);

      const cached = await redis.lrange(cacheKey, 0, -1);
      expect(cached.length).toBe(2);
      const ttl = await redis.ttl(cacheKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60 * 60);
    });

    it("fallback 결과가 빈 배열이면 replace skip (메시지 0건 세션)", async () => {
      const redis = await freshRedis();
      const fallback = jest.fn().mockResolvedValue([]);
      const service = await createService(redis);

      const result = await service.getContextWithFallback(sessionId, fallback);

      expect(result).toEqual([]);
      const cached = await redis.lrange(cacheKey, 0, -1);
      expect(cached.length).toBe(0);
    });
  });

  describe("getContextWithFallback. Redis 장애", () => {
    it("Redis가 throw하면 fallback만 실행하고 Redis 채우기 시도 안 함", async () => {
      const messages = [makeMessage("m1")];
      const fallback = jest.fn().mockResolvedValue(messages);
      const lrange = jest.fn().mockRejectedValue(new Error("Redis down"));
      const multi = jest.fn();
      const fakeRedis = {
        lrange,
        multi,
      };
      const service = await createService(fakeRedis);

      const result = await service.getContextWithFallback(sessionId, fallback);

      expect(fallback).toHaveBeenCalledTimes(1);
      expect(result).toEqual(messages);
      expect(multi).not.toHaveBeenCalled();
    });
  });

  describe("pushMessage", () => {
    it("LPUSH → LTRIM 0..windowSize-1 → EXPIRE 3600을 multi 파이프라인 단일 EXEC", async () => {
      const exec = jest.fn().mockResolvedValue([]);
      const expire = jest.fn().mockReturnValue({ exec });
      const ltrim = jest.fn().mockReturnValue({ expire });
      const lpush = jest.fn().mockReturnValue({ ltrim });
      const multi = jest.fn().mockReturnValue({ lpush });
      const fakeRedis = { multi };
      const service = await createService(fakeRedis);
      const message = makeMessage("m1", "hello");

      await service.pushMessage(sessionId, message);

      expect(multi).toHaveBeenCalled();
      expect(lpush).toHaveBeenCalledWith(cacheKey, JSON.stringify(message));
      expect(ltrim).toHaveBeenCalledWith(cacheKey, 0, 7);
      expect(expire).toHaveBeenCalledWith(cacheKey, 3600);
      expect(exec).toHaveBeenCalled();
    });

    it("Redis throw해도 에러를 전파하지 않는다", async () => {
      const fakeRedis = {
        multi: jest.fn().mockImplementation(() => {
          throw new Error("Redis down");
        }),
      };
      const service = await createService(fakeRedis);

      await expect(
        service.pushMessage(sessionId, makeMessage("m1")),
      ).resolves.toBeUndefined();
    });
  });

  describe("windowSize 적용", () => {
    it("실제 Redis에 9건 LPUSH 후 LTRIM이 적용되어 8건만 유지", async () => {
      const redis = await freshRedis();
      const service = await createService(redis);

      for (let i = 1; i <= 9; i += 1) {
        await service.pushMessage(sessionId, makeMessage(`m${i}`));
      }

      const cached = await redis.lrange(cacheKey, 0, -1);
      expect(cached.length).toBe(8);
      const head = JSON.parse(cached[0]) as ContextMessage;
      expect(head.id).toBe("m9");
    });
  });
});
