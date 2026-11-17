import { Types } from "mongoose";

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

describe("Rate limit (e2e)", () => {
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

  async function http() {
    return (await import("supertest")).default(ctx.app.getHttpServer());
  }

  it("같은 IP의 로그인 시도는 분당 10회까지, 넘으면 429 + Retry-After", async () => {
    const request = await http();
    for (let i = 0; i < 10; i += 1) {
      await request
        .post("/auth/login")
        .send({ id: "nobody", password: "wrong-password" })
        .expect(401);
    }

    const blocked = await request
      .post("/auth/login")
      .send({ id: "nobody", password: "wrong-password" })
      .expect(429);

    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("Redis 장애 시 auth 제한은 통과시킨다 (fail-open)", async () => {
    const evalSpy = jest
      .spyOn(ctx.redis, "eval")
      .mockRejectedValue(new Error("Redis down"));
    try {
      await (await http())
        .post("/auth/register")
        .send({ id: "failopen", password: "password1234" })
        .expect(201);
    } finally {
      evalSpy.mockRestore();
    }
  });

  it("메시지 전송은 사용자당 분당 20회, 다른 사용자는 영향 없음", async () => {
    const user = await registerAndLogin(ctx);
    const other = await registerAndLogin(ctx);
    const persona = await createPersona(ctx, user, { isPublic: true });
    const sessionId = await createSession(ctx, user, persona.id);
    const otherSessionId = await createSession(ctx, other, persona.id);

    for (let i = 0; i < 20; i += 1) {
      const result = await postMessageAndCollectSse(ctx, user, sessionId, `m${i}`);
      expect(result.status).toBe(201);
    }

    const blocked = await postMessageAndCollectSse(ctx, user, sessionId, "over");
    expect(blocked.status).toBe(429);

    const otherResult = await postMessageAndCollectSse(
      ctx,
      other,
      otherSessionId,
      "hi",
    );
    expect(otherResult.status).toBe(201);
  });

  it("메모리 생성도 사용자당 분당 30회", async () => {
    const user = await registerAndLogin(ctx);
    const request = await http();
    for (let i = 0; i < 30; i += 1) {
      await request
        .post("/users/me/memories")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ content: `memo ${i}` })
        .expect(201);
    }

    await request
      .post("/users/me/memories")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ content: "over" })
      .expect(429);
  });

  it("메모리는 사용자당 100개까지 (목록·프롬프트 크기 상한)", async () => {
    const user = await registerAndLogin(ctx);
    const userId = new Types.ObjectId(user.id);
    await ctx.connection.collection("usermemories").insertMany(
      Array.from({ length: 100 }, (_, i) => ({
        userId,
        content: `seed ${i}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );

    await (await http())
      .post("/users/me/memories")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ content: "one more" })
      .expect(400);
  });
});
