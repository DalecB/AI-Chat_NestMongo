import { JwtService } from "@nestjs/jwt";

import {
  closeE2eApp,
  createE2eApp,
  E2eContext,
  registerAndLogin,
  resetDataBetweenTests,
} from "./utils/test-app";

describe("Auth (e2e)", () => {
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

  describe("POST /auth/register", () => {
    it("정상 등록 → 201, body에 id/loginId, passwordHash 없음", async () => {
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );

      const response = await request
        .post("/auth/register")
        .send({ id: "alice", password: "password1234" })
        .expect(201);

      expect(response.body).toHaveProperty("id");
      expect(response.body.loginId).toBe("alice");
      expect(response.body).not.toHaveProperty("passwordHash");
    });

    it("동일 loginId 중복 등록 → 409", async () => {
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .post("/auth/register")
        .send({ id: "alice", password: "password1234" })
        .expect(201);

      await request
        .post("/auth/register")
        .send({ id: "alice", password: "different-1234" })
        .expect(409);
    });

    it("동일 loginId 동시 등록 race → 1건만 성공, 나머지는 409", async () => {
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );

      const [first, second] = await Promise.all([
        request
          .post("/auth/register")
          .send({ id: "race-user", password: "password1234" }),
        request
          .post("/auth/register")
          .send({ id: "race-user", password: "password1234" }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
    });

    it("DTO validation. password 길이 부족 → 400", async () => {
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .post("/auth/register")
        .send({ id: "alice", password: "short" })
        .expect(400);
    });

    it("DTO validation. id 누락 → 400", async () => {
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .post("/auth/register")
        .send({ password: "password1234" })
        .expect(400);
    });

    it("앞뒤 공백 포함 loginId는 trim된 형태로 저장", async () => {
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );

      const response = await request
        .post("/auth/register")
        .send({ id: "  bob  ", password: "password1234" })
        .expect(201);

      expect(response.body.loginId).toBe("bob");

      // trim된 id로 로그인 가능
      await request
        .post("/auth/login")
        .send({ id: "bob", password: "password1234" })
        .expect(200);
    });
  });

  describe("POST /auth/login", () => {
    it("등록한 계정으로 로그인 → 200 + accessToken", async () => {
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .post("/auth/register")
        .send({ id: "alice", password: "password1234" })
        .expect(201);

      const response = await request
        .post("/auth/login")
        .send({ id: "alice", password: "password1234" })
        .expect(200);

      expect(typeof response.body.accessToken).toBe("string");
      expect(response.body.accessToken.length).toBeGreaterThan(10);
    });

    it("미등록 loginId → 401", async () => {
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .post("/auth/login")
        .send({ id: "ghost", password: "password1234" })
        .expect(401);
    });

    it("잘못된 비밀번호 → 401 (동일 메시지)", async () => {
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .post("/auth/register")
        .send({ id: "alice", password: "password1234" })
        .expect(201);

      const response = await request
        .post("/auth/login")
        .send({ id: "alice", password: "wrong-password" })
        .expect(401);

      expect(response.body.message).toMatch(/credentials/i);
    });
  });

  describe("JWT 보호 엔드포인트", () => {
    it("토큰 없이 GET /sessions → 401", async () => {
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request.get("/sessions").expect(401);
    });

    it("유효한 Bearer 토큰으로 GET /sessions → 200", async () => {
      const user = await registerAndLogin(ctx);
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .get("/sessions")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .expect(200);
    });

    it("위조 토큰(다른 secret) → 401", async () => {
      const otherJwt = new JwtService({ secret: "different-secret" });
      const forged = otherJwt.sign({ sub: "anyone" });
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .get("/sessions")
        .set("Authorization", `Bearer ${forged}`)
        .expect(401);
    });

    it("만료된 토큰 → 401", async () => {
      const user = await registerAndLogin(ctx);
      const expired = ctx.jwtService.sign(
        { sub: user.id },
        { expiresIn: "-1s" },
      );
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .get("/sessions")
        .set("Authorization", `Bearer ${expired}`)
        .expect(401);
    });

    it("Authorization 헤더 format 불일치 → 401", async () => {
      const user = await registerAndLogin(ctx);
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .get("/sessions")
        .set("Authorization", `Token ${user.accessToken}`)
        .expect(401);
    });

    it("토큰의 sub가 존재하지 않는 user를 가리키면 → 401", async () => {
      const orphanToken = ctx.jwtService.sign({
        sub: "012345678901234567890123",
      });
      const request = (await import("supertest")).default(
        ctx.app.getHttpServer(),
      );
      await request
        .get("/sessions")
        .set("Authorization", `Bearer ${orphanToken}`)
        .expect(401);
    });
  });
});
