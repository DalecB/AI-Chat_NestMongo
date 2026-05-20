import { HttpException, ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import { REDIS_CLIENT } from "./redis.constants";
import { SessionLockService } from "./session-lock.service";

interface FakeRedis {
  set: jest.Mock;
  eval: jest.Mock;
}

function createFakeRedis(overrides: Partial<FakeRedis> = {}): FakeRedis {
  return {
    set: jest.fn().mockResolvedValue("OK"),
    eval: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

async function createService(redis: FakeRedis): Promise<SessionLockService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      SessionLockService,
      { provide: REDIS_CLIENT, useValue: redis },
    ],
  }).compile();

  return moduleRef.get(SessionLockService);
}

describe("SessionLockService", () => {
  describe("acquire", () => {
    it("성공 시 lock:session:{id} 키에 ownerId(uuid) 값과 EX 60 NX 옵션으로 SET 호출", async () => {
      const redis = createFakeRedis();
      const service = await createService(redis);

      const lock = await service.acquire("sess1");

      expect(redis.set).toHaveBeenCalledTimes(1);
      const [key, ownerId, exFlag, ttl, nxFlag] = redis.set.mock.calls[0];
      expect(key).toBe("lock:session:sess1");
      expect(typeof ownerId).toBe("string");
      expect(ownerId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(exFlag).toBe("EX");
      expect(ttl).toBe(60);
      expect(nxFlag).toBe("NX");
      expect(lock).toEqual({ key: "lock:session:sess1", ownerId });
    });

    it("ownerId는 매 호출마다 새 uuid", async () => {
      const redis = createFakeRedis();
      const service = await createService(redis);

      const lockA = await service.acquire("sessA");
      const lockB = await service.acquire("sessB");

      expect(lockA.ownerId).not.toBe(lockB.ownerId);
    });

    it("SET 결과가 null(이미 점유)이면 HttpException 429 throw", async () => {
      const redis = createFakeRedis({
        set: jest.fn().mockResolvedValue(null),
      });
      const service = await createService(redis);

      await expect(service.acquire("sess1")).rejects.toMatchObject({
        getStatus: expect.any(Function),
        message: "Session is already processing a message",
      });

      try {
        await service.acquire("sess1");
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(429);
      }
    });

    it("Redis가 throw하면 ServiceUnavailableException으로 변환", async () => {
      const redis = createFakeRedis({
        set: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      });
      const service = await createService(redis);

      await expect(service.acquire("sess1")).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe("release", () => {
    it("자기 ownerId일 때 Lua eval로 KEYS=[lock.key], ARGV=[lock.ownerId] 호출", async () => {
      const redis = createFakeRedis();
      const service = await createService(redis);

      await service.release({ key: "lock:session:sess1", ownerId: "uuid-1" });

      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [script, numKeys, key, ownerId] = redis.eval.mock.calls[0];
      expect(typeof script).toBe("string");
      expect(script).toMatch(/redis\.call\("get", KEYS\[1\]\)/);
      expect(script).toMatch(/redis\.call\("del", KEYS\[1\]\)/);
      expect(numKeys).toBe(1);
      expect(key).toBe("lock:session:sess1");
      expect(ownerId).toBe("uuid-1");
    });

    it("Lua가 0 반환해도 throw하지 않음 (TTL 만료 후 다른 요청이 점유한 케이스)", async () => {
      const redis = createFakeRedis({
        eval: jest.fn().mockResolvedValue(0),
      });
      const service = await createService(redis);

      await expect(
        service.release({ key: "lock:session:sess1", ownerId: "uuid-stale" }),
      ).resolves.toBeUndefined();
    });

    it("Redis가 throw해도 release는 에러를 전파하지 않는다", async () => {
      const redis = createFakeRedis({
        eval: jest.fn().mockRejectedValue(new Error("Redis down")),
      });
      const service = await createService(redis);

      await expect(
        service.release({ key: "lock:session:sess1", ownerId: "uuid-1" }),
      ).resolves.toBeUndefined();
    });
  });
});
