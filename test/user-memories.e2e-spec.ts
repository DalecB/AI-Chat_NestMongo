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

describe("User memories (e2e)", () => {
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

  async function postMemory(token: string, content: string): Promise<string> {
    const request = (await import("supertest")).default(
      ctx.app.getHttpServer(),
    );
    const response = await request
      .post("/users/me/memories")
      .set("Authorization", `Bearer ${token}`)
      .send({ content })
      .expect(201);
    return response.body.id as string;
  }

  describe("CRUD", () => {
    it("POST /users/me/memories → 201, 본인 메모리로 저장", async () => {
      const user = await registerAndLogin(ctx);
      const id = await postMemory(user.accessToken, "I love coffee");
      expect(typeof id).toBe("string");
    });

    it("GET /users/me/memories → 본인 메모리만, desc 순", async () => {
      const user = await registerAndLogin(ctx);
      await postMemory(user.accessToken, "first");
      await new Promise((resolve) => setTimeout(resolve, 5));
      await postMemory(user.accessToken, "second");

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      const response = await request
        .get("/users/me/memories")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(200);

      const contents = response.body.map((m: { content: string }) => m.content);
      expect(contents).toEqual(["second", "first"]);
    });

    it("DELETE /users/me/memories/:id → 204, 이후 목록에서 사라짐", async () => {
      const user = await registerAndLogin(ctx);
      const id = await postMemory(user.accessToken, "to delete");

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .delete(`/users/me/memories/${id}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(204);

      const listResponse = await request
        .get("/users/me/memories")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(200);
      expect(listResponse.body).toEqual([]);
    });

    it("타인 메모리 DELETE → 404, DB에 그대로", async () => {
      const owner = await registerAndLogin(ctx);
      const stranger = await registerAndLogin(ctx);
      const id = await postMemory(owner.accessToken, "owned");

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .delete(`/users/me/memories/${id}`)
        .set("Authorization", `Bearer ${stranger.accessToken}`)
        .expect(404);

      const ownerList = await request
        .get("/users/me/memories")
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(ownerList.body.length).toBe(1);
    });

    it("DTO validation. content 빈 문자열 → 400", async () => {
      const user = await registerAndLogin(ctx);
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .post("/users/me/memories")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ content: "" })
        .expect(400);
    });
  });

  describe("권한", () => {
    it("인증 없이 GET/POST/DELETE → 401", async () => {
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request.get("/users/me/memories").expect(401);
      await request.post("/users/me/memories").send({ content: "x" }).expect(401);
      await request.delete("/users/me/memories/aaa").expect(401);
    });

    it("다른 사용자 메모리는 GET 결과에 절대 포함 안 됨", async () => {
      const me = await registerAndLogin(ctx);
      const other = await registerAndLogin(ctx);
      await postMemory(me.accessToken, "mine");
      await postMemory(other.accessToken, "theirs");

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      const response = await request
        .get("/users/me/memories")
        .set("Authorization", `Bearer ${me.accessToken}`)
        .expect(200);

      const contents = response.body.map((m: { content: string }) => m.content);
      expect(contents).toEqual(["mine"]);
    });
  });

  describe("LLM 프롬프트 주입", () => {
    it("등록된 메모리들이 generateStream 호출 시 userMemories로 전달 (ascending)", async () => {
      const user = await registerAndLogin(ctx);
      await postMemory(user.accessToken, "memA");
      await new Promise((resolve) => setTimeout(resolve, 5));
      await postMemory(user.accessToken, "memB");

      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);
      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["ok"],
        usage: { prompt: 1, completion: 1, total: 2 },
      });

      await postMessageAndCollectSse(ctx, user, sessionId, "hi");

      const call = ctx.openAiMock.streamCalls.at(-1);
      expect(call?.options.userMemories).toEqual(["memA", "memB"]);
    });

    it("메모리 삭제 후 다음 메시지에서는 prompt에 포함 안 됨", async () => {
      const user = await registerAndLogin(ctx);
      const id = await postMemory(user.accessToken, "transient");

      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);

      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["a"],
        usage: { prompt: 1, completion: 1, total: 2 },
      });
      await postMessageAndCollectSse(ctx, user, sessionId, "hi 1");

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .delete(`/users/me/memories/${id}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(204);

      ctx.openAiMock.streamCalls.length = 0;
      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["b"],
        usage: { prompt: 1, completion: 1, total: 2 },
      });
      await postMessageAndCollectSse(ctx, user, sessionId, "hi 2");

      const call = ctx.openAiMock.streamCalls.at(-1);
      expect(call?.options.userMemories).toEqual([]);
    });

    it("타사용자 메모리는 다른 사용자 generateStream 호출에 절대 leak 안 됨", async () => {
      const me = await registerAndLogin(ctx);
      const other = await registerAndLogin(ctx);
      await postMemory(me.accessToken, "mine-secret");
      await postMemory(other.accessToken, "their-secret");

      const persona = await createPersona(ctx, me);
      const sessionId = await createSession(ctx, me, persona.id);

      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["ok"],
        usage: { prompt: 1, completion: 1, total: 2 },
      });
      await postMessageAndCollectSse(ctx, me, sessionId, "hi");

      const call = ctx.openAiMock.streamCalls.at(-1);
      expect(call?.options.userMemories).toEqual(["mine-secret"]);
      expect(call?.options.userMemories).not.toContain("their-secret");
    });

    it("Phase 1 정책. 사용자 메시지를 보내도 자동 메모리 생성 안 됨", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);
      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["ok"],
        usage: { prompt: 1, completion: 1, total: 2 },
      });

      await postMessageAndCollectSse(
        ctx,
        user,
        sessionId,
        "I love coffee. Remember this.",
      );

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      const memories = await request
        .get("/users/me/memories")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(200);
      expect(memories.body).toEqual([]);
    });
  });
});
