// Session 동시성 E2E. ADR-8 (Redis 분산 락) 운영 시나리오 검증.
// 같은 세션 동시 요청이 직렬화되는지, 락이 정상 해제되는지 확인한다.

import { SessionLockService } from "../src/redis/session-lock.service";

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

describe("Session concurrency. Redis 분산 락 (e2e)", () => {
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

  // 첫 청크 yield 전에 인위적 지연을 넣어 두 번째 요청이 락 점유 중 도착하도록 함.
  function setDelayedStreamPlan(delayMs: number, chunks: string[] = ["hi"]) {
    const originalGenerateStream = ctx.openAiMock.generateStream;
    ctx.openAiMock.generateStream = (
      systemPrompt,
      messages,
      options = {},
    ) => {
      ctx.openAiMock.streamCalls.push({ systemPrompt, messages, options });
      async function* iter() {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        for (const content of chunks) {
          yield {
            id: "c",
            object: "chat.completion.chunk",
            created: 0,
            model: "m",
            choices: [
              {
                index: 0,
                delta: { content },
                finish_reason: null,
              },
            ],
          } as never;
        }
        yield {
          id: "u",
          object: "chat.completion.chunk",
          created: 0,
          model: "m",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        } as never;
      }
      return Promise.resolve(iter());
    };
    return () => {
      ctx.openAiMock.generateStream = originalGenerateStream;
    };
  }

  describe("같은 세션 동시 요청 직렬화", () => {
    it("동시 2건 → 1건 성공(done), 1건 429", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);
      const restore = setDelayedStreamPlan(400);

      const [a, b] = await Promise.all([
        postMessageAndCollectSse(ctx, user, sessionId, "first"),
        postMessageAndCollectSse(ctx, user, sessionId, "second"),
      ]);
      restore();

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 429]);

      const successful = [a, b].find((r) => r.status === 201);
      expect(successful?.events.map((e) => e.event)).toContain("done");
    });

    it("동시 5건 → 1건만 성공, 나머지 4건 모두 429", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);
      const restore = setDelayedStreamPlan(400);

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          postMessageAndCollectSse(ctx, user, sessionId, `msg-${i}`),
        ),
      );
      restore();

      const successCount = results.filter((r) => r.status === 201).length;
      const conflictCount = results.filter((r) => r.status === 429).length;
      expect(successCount).toBe(1);
      expect(conflictCount).toBe(4);
    });
  });

  describe("락 데이터 무결성", () => {
    it("동시 처리 중 user 메시지/assistant placeholder가 각 1건만 insert", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);
      const restore = setDelayedStreamPlan(300);

      await Promise.all([
        postMessageAndCollectSse(ctx, user, sessionId, "first"),
        postMessageAndCollectSse(ctx, user, sessionId, "second"),
        postMessageAndCollectSse(ctx, user, sessionId, "third"),
      ]);
      restore();

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      const listResponse = await request
        .get(`/sessions/${sessionId}/messages`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(200);

      const items = listResponse.body.items as Array<{
        role: string;
        streamStatus: string;
      }>;
      // greeting(assistant) + user 1건 + assistant 1건
      expect(items.length).toBe(3);
      const userCount = items.filter((m) => m.role === "user").length;
      const assistantCount = items.filter((m) => m.role === "assistant").length;
      expect(userCount).toBe(1);
      expect(assistantCount).toBe(2);
    });
  });

  describe("다른 세션은 독립", () => {
    it("같은 사용자의 다른 세션 동시 요청은 둘 다 성공", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionA = await createSession(ctx, user, persona.id);
      const sessionB = await createSession(ctx, user, persona.id);
      const restore = setDelayedStreamPlan(200);

      const [a, b] = await Promise.all([
        postMessageAndCollectSse(ctx, user, sessionA, "to A"),
        postMessageAndCollectSse(ctx, user, sessionB, "to B"),
      ]);
      restore();

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
    });
  });

  describe("락 만료/해제", () => {
    it("정상 완료 후 Redis에 lock:session:{id} 키 부재", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);
      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["ok"],
        usage: { prompt: 1, completion: 1, total: 2 },
      });

      await postMessageAndCollectSse(ctx, user, sessionId, "hi");

      const value = await ctx.redis.get(`lock:session:${sessionId}`);
      expect(value).toBeNull();
    });

    it("LLM 실패 후에도 락 해제 → 즉시 재시도 가능", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);

      ctx.openAiMock.setStreamPlan({
        kind: "throw",
        afterChunkIndex: 0,
        error: new Error("LLM down"),
      });
      await postMessageAndCollectSse(ctx, user, sessionId, "first");

      const lockValue = await ctx.redis.get(`lock:session:${sessionId}`);
      expect(lockValue).toBeNull();

      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["ok"],
        usage: { prompt: 1, completion: 1, total: 2 },
      });
      const retry = await postMessageAndCollectSse(
        ctx,
        user,
        sessionId,
        "second",
      );
      expect(retry.status).toBe(201);
      expect(retry.events.map((e) => e.event)).toContain("done");
    });
  });
});
