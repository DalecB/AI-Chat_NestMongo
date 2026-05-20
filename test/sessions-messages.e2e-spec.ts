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

describe("Sessions + Messages (e2e)", () => {
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

  describe("세션 생성", () => {
    it("세션 생성 시 페르소나 greetingMessage가 assistant 메시지로 저장", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user, { greetingMessage: "안녕!" });
      const sessionId = await createSession(ctx, user, persona.id);

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      const listResponse = await request
        .get(`/sessions/${sessionId}/messages`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(200);

      expect(listResponse.body.items.length).toBe(1);
      expect(listResponse.body.items[0]).toMatchObject({
        role: "assistant",
        content: "안녕!",
        streamStatus: "completed",
      });
    });

    it("Session.lastMessageAt이 greeting createdAt으로 설정됨", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      const sessionResponse = await request
        .get(`/sessions/${sessionId}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(200);

      expect(sessionResponse.body.lastMessageAt).toBeTruthy();
    });

    it("타인의 비공개 페르소나로 세션 생성 시도 → 404", async () => {
      const owner = await registerAndLogin(ctx);
      const stranger = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, owner, { isPublic: false });

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .post("/sessions")
        .set("Authorization", `Bearer ${stranger.accessToken}`)
        .send({ personaId: persona.id })
        .expect(404);
    });
  });

  describe("메시지 SSE 흐름 (ADR-6)", () => {
    it("이벤트 시퀀스: user_message_saved → assistant_message_started → chunk* → assistant_message_completed → done", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);
      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["안녕", " 반가워"],
        usage: { prompt: 10, completion: 8, total: 18 },
      });

      const result = await postMessageAndCollectSse(
        ctx,
        user,
        sessionId,
        "hi",
      );

      expect(result.status).toBe(201);
      const names = result.events.map((e) => e.event);
      expect(names).toContain("user_message_saved");
      expect(names).toContain("assistant_message_started");
      expect(names.filter((n) => n === "chunk").length).toBe(2);
      expect(names).toContain("assistant_message_completed");
      expect(names[names.length - 1]).toBe("done");
    });

    it("응답 후 DB에 user 메시지 1건 + assistant 메시지 1건 + greeting", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);
      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["hello"],
        usage: { prompt: 3, completion: 2, total: 5 },
      });

      await postMessageAndCollectSse(ctx, user, sessionId, "hi");

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      const listResponse = await request
        .get(`/sessions/${sessionId}/messages`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(200);

      const items = listResponse.body.items;
      expect(items.length).toBe(3);
      const roles = items.map((m: { role: string }) => m.role);
      expect(roles).toEqual(["assistant", "user", "assistant"]);
      const last = items[items.length - 1];
      expect(last.content).toBe("hello");
      expect(last.streamStatus).toBe("completed");
      expect(last.tokenUsage).toMatchObject({ prompt: 3, completion: 2, total: 5 });
    });

    it("usage 누락 시 tokenUsage default(0,0,0)로 저장", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);
      ctx.openAiMock.setStreamPlan({ kind: "ok", chunks: ["hello"] });

      await postMessageAndCollectSse(ctx, user, sessionId, "hi");

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      const listResponse = await request
        .get(`/sessions/${sessionId}/messages`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(200);

      const assistant = listResponse.body.items[2];
      expect(assistant.tokenUsage).toMatchObject({
        prompt: 0,
        completion: 0,
        total: 0,
      });
    });
  });

  describe("Session denormalize (ADR-5)", () => {
    it("여러 번 메시지 전송 시 Session.tokenUsage 누적", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);
      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["r1"],
        usage: { prompt: 3, completion: 2, total: 5 },
      });

      await postMessageAndCollectSse(ctx, user, sessionId, "hi 1");
      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["r2"],
        usage: { prompt: 4, completion: 3, total: 7 },
      });
      await postMessageAndCollectSse(ctx, user, sessionId, "hi 2");

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      const sessionResponse = await request
        .get(`/sessions/${sessionId}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(200);

      expect(sessionResponse.body.tokenUsage).toMatchObject({
        prompt: 7,
        completion: 5,
        total: 12,
      });
    });
  });

  describe("세션 삭제 cascade", () => {
    it("DELETE /sessions/:id → 세션 + messages 모두 삭제 (transaction)", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);
      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["hi"],
        usage: { prompt: 1, completion: 1, total: 2 },
      });
      await postMessageAndCollectSse(ctx, user, sessionId, "msg");

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .delete(`/sessions/${sessionId}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(204);

      await request
        .get(`/sessions/${sessionId}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(404);

      // messages 컬렉션 직접 조회. sessionId 기준 0건
      const { Types } = await import("mongoose");
      const messageCollection = ctx.connection.db!.collection("messages");
      const count = await messageCollection.countDocuments({
        sessionId: new Types.ObjectId(sessionId),
      });
      expect(count).toBe(0);
    });

    it("타인의 세션 삭제 시도 → 403, 세션과 messages는 그대로 유지", async () => {
      const owner = await registerAndLogin(ctx);
      const stranger = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, owner);
      const sessionId = await createSession(ctx, owner, persona.id);
      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["hi"],
        usage: { prompt: 1, completion: 1, total: 2 },
      });
      await postMessageAndCollectSse(ctx, owner, sessionId, "msg");

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .delete(`/sessions/${sessionId}`)
        .set("Authorization", `Bearer ${stranger.accessToken}`)
        .expect(403);

      await request
        .get(`/sessions/${sessionId}`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .expect(200);

      const { Types } = await import("mongoose");
      const messageCollection = ctx.connection.db!.collection("messages");
      const count = await messageCollection.countDocuments({
        sessionId: new Types.ObjectId(sessionId),
      });
      expect(count).toBe(3);
    });
  });

  describe("LLM 실패 (ADR-6 실패 경로)", () => {
    it("mid-stream throw → assistant_message_failed + error 이벤트, done 없음", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);
      ctx.openAiMock.setStreamPlan({
        kind: "throw",
        afterChunkIndex: 1,
        error: new Error("LLM down"),
      });

      const result = await postMessageAndCollectSse(
        ctx,
        user,
        sessionId,
        "hi",
      );

      const names = result.events.map((e) => e.event);
      expect(names).toContain("assistant_message_failed");
      expect(names).toContain("error");
      expect(names).not.toContain("done");

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      const listResponse = await request
        .get(`/sessions/${sessionId}/messages`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(200);
      const lastAssistant = listResponse.body.items[listResponse.body.items.length - 1];
      expect(lastAssistant.streamStatus).toBe("failed");
    });

    it("실패해도 락은 release되어 재시도 가능", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user);
      const sessionId = await createSession(ctx, user, persona.id);

      ctx.openAiMock.setStreamPlan({
        kind: "throw",
        afterChunkIndex: 0,
        error: new Error("LLM down"),
      });
      await postMessageAndCollectSse(ctx, user, sessionId, "first");

      ctx.openAiMock.setStreamPlan({
        kind: "ok",
        chunks: ["recovered"],
        usage: { prompt: 1, completion: 1, total: 2 },
      });
      const retry = await postMessageAndCollectSse(
        ctx,
        user,
        sessionId,
        "second",
      );
      expect(retry.events.map((e) => e.event)).toContain("done");
    });
  });
});
