import {
  closeE2eApp,
  createE2eApp,
  createPersona,
  E2eContext,
  registerAndLogin,
  resetDataBetweenTests,
} from "./utils/test-app";

describe("Personas (e2e)", () => {
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

  describe("POST /personas", () => {
    it("기본 isPublic=false로 생성, response에 systemPrompt 노출 안 됨", async () => {
      const user = await registerAndLogin(ctx);
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );

      const response = await request
        .post("/personas")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({
          name: "테스트",
          profile: "p",
          personality: "x",
          speakingStyle: "y",
          scenario: "z",
          greetingMessage: "hi",
        })
        .expect(201);

      expect(response.body.isPublic).toBe(false);
      expect(response.body).not.toHaveProperty("systemPrompt");
      expect(response.body).not.toHaveProperty("userId");
    });

    it("인증 없이 → 401", async () => {
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .post("/personas")
        .send({
          name: "x",
          profile: "p",
          personality: "x",
          speakingStyle: "y",
          scenario: "z",
          greetingMessage: "hi",
        })
        .expect(401);
    });

    it("DTO validation. 필수 필드 누락 시 400", async () => {
      const user = await registerAndLogin(ctx);
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .post("/personas")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ name: "x" })
        .expect(400);
    });
  });

  describe("GET /personas/:id", () => {
    it("본인 비공개 페르소나 조회 가능", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user, { isPublic: false });
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );

      const response = await request
        .get(`/personas/${persona.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(200);

      expect(response.body.id).toBe(persona.id);
    });

    it("타인 공개 페르소나 조회 가능", async () => {
      const owner = await registerAndLogin(ctx);
      const viewer = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, owner, { isPublic: true });
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );

      await request
        .get(`/personas/${persona.id}`)
        .set("Authorization", `Bearer ${viewer.accessToken}`)
        .expect(200);
    });

    it("타인 비공개 페르소나 조회 → 404", async () => {
      const owner = await registerAndLogin(ctx);
      const stranger = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, owner, { isPublic: false });
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );

      await request
        .get(`/personas/${persona.id}`)
        .set("Authorization", `Bearer ${stranger.accessToken}`)
        .expect(404);
    });
  });

  describe("PATCH /personas/:id. 공개 전 수정 자유", () => {
    it("비공개 페르소나 필드 수정 가능", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user, { isPublic: false });
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );

      const response = await request
        .patch(`/personas/${persona.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ name: "변경됨" })
        .expect(200);

      expect(response.body.name).toBe("변경됨");
    });

    it("비공개 → 공개 전환 가능", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user, { isPublic: false });
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );

      const response = await request
        .patch(`/personas/${persona.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ isPublic: true })
        .expect(200);

      expect(response.body.isPublic).toBe(true);
    });
  });

  describe("PATCH /personas/:id. 공개 후 잠금 (ADR-2)", () => {
    it("공개된 페르소나 어떤 필드 수정도 거부 (400)", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user, { isPublic: true });
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );

      await request
        .patch(`/personas/${persona.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ name: "수정 시도" })
        .expect(400);

      // 상태 그대로 유지 검증
      const stillThere = await request
        .get(`/personas/${persona.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(200);
      expect(stillThere.body.name).not.toBe("수정 시도");
    });

    it("공개 → 비공개 되돌리기 거부 (400)", async () => {
      const user = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, user, { isPublic: true });
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );

      await request
        .patch(`/personas/${persona.id}`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ isPublic: false })
        .expect(400);
    });

    it("타인이 공개 페르소나 수정 시도 → 403", async () => {
      const owner = await registerAndLogin(ctx);
      const stranger = await registerAndLogin(ctx);
      const persona = await createPersona(ctx, owner, { isPublic: true });
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );

      await request
        .patch(`/personas/${persona.id}`)
        .set("Authorization", `Bearer ${stranger.accessToken}`)
        .send({ name: "탈취" })
        .expect(403);
    });
  });

  describe("GET /personas. 공개 목록", () => {
    it("공개 페르소나만 반환, 본인 비공개는 제외", async () => {
      const me = await registerAndLogin(ctx);
      const other = await registerAndLogin(ctx);
      await createPersona(ctx, me, { name: "내 공개", isPublic: true });
      await createPersona(ctx, me, { name: "내 비공개", isPublic: false });
      await createPersona(ctx, other, { name: "남 공개", isPublic: true });

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      const response = await request
        .get("/personas")
        .set("Authorization", `Bearer ${me.accessToken}`)
        .expect(200);

      const names = response.body.map((p: { name: string }) => p.name).sort();
      expect(names).toEqual(["남 공개", "내 공개"]);
    });

    it("name 쿼리로 필터링. 매칭되는 공개 페르소나만", async () => {
      const me = await registerAndLogin(ctx);
      await createPersona(ctx, me, { name: "Sherlock", isPublic: true });
      await createPersona(ctx, me, { name: "Watson", isPublic: true });

      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      const response = await request
        .get("/personas?name=Sherlock")
        .set("Authorization", `Bearer ${me.accessToken}`)
        .expect(200);

      expect(response.body.length).toBe(1);
      expect(response.body[0].name).toBe("Sherlock");
    });
  });
});
