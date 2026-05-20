// Cache fallback E2E. ADR-7 (Redis Hot Path + Mongo fallback) 동작 검증.

import { ContextCacheService } from "../src/redis/context-cache.service";

import {
  closeE2eApp,
  createE2eApp,
  createPersona,
  createSession,
  E2eContext,
  postMessageAndCollectSse,
  registerAndLogin,
  resetDataBetweenTests,
} from "./utils/test-app";

describe("Context cache fallback (e2e)", () => {
  let ctx: E2eContext;

  beforeAll(async () => {
    ctx = await createE2eApp();
  }, 120000);

  afterAll(async () => {
    await closeE2eApp(ctx);
  });

  beforeEach(async () => {
    await resetDataBetweenTests(ctx);
  });

  describe("Cache miss self-heal", () => {
    it("신규 세션 첫 메시지: Redis 비어있음 → Mongo fallback → 응답 성공, 이후 Redis가 채워짐", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);
      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["ok"],
        usage: { prompt: 1, completion: 1, total: 2 },
      });

      await ctx.redis.del(`ctx:${sessionId}`);
      expect(await ctx.redis.llen(`ctx:${sessionId}`)).toBe(0);

      const result = await postMessageAndCollectSse(
        ctx,
        user,
        sessionId,
        "hi",
      );

      expect(result.status).toBe(201);
      expect(result.events.map((e) => e.event)).toContain("done");

      const cached = await ctx.redis.lrange(`ctx:${sessionId}`, 0, -1);
      expect(cached.length).toBeGreaterThan(0);
      const ttl = await ctx.redis.ttl(`ctx:${sessionId}`);
      expect(ttl).toBeGreaterThan(0);
    });
  });

  describe("Redis 장애 시 동작", () => {
    it("Redis lrange가 throw해도 메시지 전송 성공 (Mongo fallback만)", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);
      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["ok"],
        usage: { prompt: 1, completion: 1, total: 2 },
      });

      const lrangeSpy = jest
        .spyOn(ctx.redis, "lrange")
        .mockRejectedValue(new Error("Redis down"));

      const result = await postMessageAndCollectSse(
        ctx,
        user,
        sessionId,
        "hi",
      );

      expect(result.status).toBe(201);
      expect(result.events.map((e) => e.event)).toContain("done");
      lrangeSpy.mockRestore();
    });

    it("Redis multi가 throw해도 SSE는 정상 완료 (replace 메서드 전체 try-catch 보장)", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);
      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["ok"],
        usage: { prompt: 1, completion: 1, total: 2 },
      });

      const multiSpy = jest.spyOn(ctx.redis, "multi").mockImplementation(() => {
        throw new Error("Redis down");
      });

      const result = await postMessageAndCollectSse(
        ctx,
        user,
        sessionId,
        "hi",
      );

      expect(result.status).toBe(201);
      expect(result.events.map((e) => e.event)).toContain("done");
      multiSpy.mockRestore();
    });
  });

  describe("Cache hit 경로", () => {
    it("Redis에 데이터 있을 때 lrange 결과 사용, fallback closure 호출 안 됨", async () => {
      const cacheService = ctx.app.get(ContextCacheService);
      const sessionId = "session-cache-hit";
      const seed = [
        { id: "m1", role: "user" as const, content: "hello" },
        { id: "m2", role: "assistant" as const, content: "hi back" },
      ];
      for (const message of seed) {
        await cacheService.pushMessage(sessionId, message);
      }
      const fallback = jest.fn();

      const result = await cacheService.getContextWithFallback(
        sessionId,
        fallback,
      );

      expect(fallback).not.toHaveBeenCalled();
      expect(result.map((m) => m.id)).toEqual(["m1", "m2"]);
    });
  });

  describe("LTRIM 윈도우 유지 (ADR-7)", () => {
    it("9건 pushMessage 후 windowSize(8)만 유지, head=최신", async () => {
      const cacheService = ctx.app.get(ContextCacheService);
      const sessionId = "session-ltrim";

      for (let i = 0; i < 9; i += 1) {
        await cacheService.pushMessage(sessionId, {
          id: `m${i}`,
          role: "user",
          content: `c${i}`,
        });
      }

      const cached = await ctx.redis.lrange(`ctx:${sessionId}`, 0, -1);
      expect(cached.length).toBe(8);
      const head = JSON.parse(cached[0]) as { id: string };
      expect(head.id).toBe("m8");
    });
  });
});
