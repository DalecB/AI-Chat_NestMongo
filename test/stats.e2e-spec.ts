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

describe("Token stats (e2e)", () => {
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

  describe("GET /stats/tokens", () => {
    it("기본 30일 범위. 누적 messageCount/totalTokens 합산", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);

      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["r1"],
        usage: { prompt: 3, completion: 4, total: 7 },
      });
      await postMessageAndCollectSse(ctx, user, sessionId, "1");

      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["r2"],
        usage: { prompt: 1, completion: 2, total: 3 },
      });
      await postMessageAndCollectSse(ctx, user, sessionId, "2");

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      const response = await request
        .get("/stats/tokens")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(200);

      const totalSum = response.body.reduce(
        (acc: number, item: { totalTokens: number }) =>
          acc + item.totalTokens,
        0,
      );
      const messageSum = response.body.reduce(
        (acc: number, item: { messageCount: number }) =>
          acc + item.messageCount,
        0,
      );
      // greeting(0) + 2 assistant 응답 → totalTokens 10, messageCount 2
      // (greeting은 tokenUsage null이라 $ifNull로 0 추가, messageCount는 +1)
      expect(totalSum).toBe(10);
      // greeting + r1 + r2 = 3 assistant 메시지
      expect(messageSum).toBe(3);
    });

    it("from > to → 400", async () => {
      const user = await registerAndLogin(ctx);
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .get("/stats/tokens?from=2026-05-10&to=2026-05-01")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(400);
    });

    it("범위 밖 (과거) 메시지는 집계에 포함되지 않음", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);

      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["r"],
        usage: { prompt: 1, completion: 1, total: 2 },
      });
      await postMessageAndCollectSse(ctx, user, sessionId, "x");

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      const response = await request
        .get("/stats/tokens?from=2020-01-01&to=2020-01-02")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it("다른 사용자의 메시지는 결과에 포함 안 됨", async () => {
      const me = await registerAndLogin(ctx);
      const other = await registerAndLogin(ctx);

      const otherPersona = await createPersona(ctx, other);
      const otherSession = await createSession(ctx, other, otherPersona.id);
      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["r"],
        usage: { prompt: 100, completion: 100, total: 200 },
      });
      await postMessageAndCollectSse(ctx, other, otherSession, "x");

      const myPersona = await createPersona(ctx, me);
      const mySession = await createSession(ctx, me, myPersona.id);
      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["r"],
        usage: { prompt: 1, completion: 1, total: 5 },
      });
      await postMessageAndCollectSse(ctx, me, mySession, "x");

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      const response = await request
        .get("/stats/tokens")
        .set("Authorization", `Bearer ${me.accessToken}`)
        .expect(200);

      const totalSum = response.body.reduce(
        (acc: number, item: { totalTokens: number }) =>
          acc + item.totalTokens,
        0,
      );
      expect(totalSum).toBe(5);
    });

    it("인증 없이 → 401", async () => {
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request.get("/stats/tokens").expect(401);
    });
  });
});
