import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcrypt";
import { Types } from "mongoose";

import { UsersService } from "../users/users.service";
import { AuthService } from "./auth.service";

type UserStub = {
  _id: Types.ObjectId;
  loginId: string;
  passwordHash: string;
};

function makeUser(overrides: Partial<UserStub> = {}): UserStub {
  return {
    _id: new Types.ObjectId(),
    loginId: "alice",
    passwordHash: "hashed-pw",
    ...overrides,
  };
}

interface Deps {
  service: AuthService;
  usersService: {
    findByLoginId: jest.Mock;
    create: jest.Mock;
  };
  jwtService: { sign: jest.Mock };
}

async function createDeps(): Promise<Deps> {
  const usersService = {
    findByLoginId: jest.fn(),
    create: jest.fn(),
  };
  const jwtService = { sign: jest.fn().mockReturnValue("signed-token") };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AuthService,
      { provide: UsersService, useValue: usersService },
      { provide: JwtService, useValue: jwtService },
    ],
  }).compile();

  return {
    service: moduleRef.get(AuthService),
    usersService,
    jwtService,
  };
}

describe("AuthService", () => {
  describe("register", () => {
    it("loginId trim 후 저장, bcrypt cost=12 적용 (hash prefix로 검증)", async () => {
      const { service, usersService } = await createDeps();
      const user = makeUser({ loginId: "alice" });
      usersService.findByLoginId.mockResolvedValue(null);
      usersService.create.mockResolvedValue(user);

      const result = await service.register("  alice  ", "password1234");

      expect(usersService.findByLoginId).toHaveBeenCalledWith("alice");
      expect(usersService.create).toHaveBeenCalledTimes(1);
      const createArg = usersService.create.mock.calls[0][0];
      expect(createArg.loginId).toBe("alice");
      // bcrypt hash 포맷: $2b$12$.... prefix의 12가 cost
      expect(createArg.passwordHash).toMatch(/^\$2[aby]\$12\$/);
      expect(result).toEqual({
        id: user._id.toString(),
        loginId: "alice",
      });
    }, 10000);

    it("이미 동일 loginId 존재 시 ConflictException", async () => {
      const { service, usersService } = await createDeps();
      usersService.findByLoginId.mockResolvedValue(makeUser());

      await expect(
        service.register("alice", "password1234"),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(usersService.create).not.toHaveBeenCalled();
    });

    it("동시 등록 race로 Mongo duplicate key가 발생해도 ConflictException", async () => {
      const { service, usersService } = await createDeps();
      usersService.findByLoginId.mockResolvedValue(null);
      usersService.create.mockRejectedValue({ code: 11000 });

      await expect(
        service.register("alice", "password1234"),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("응답에 passwordHash가 leak되지 않음", async () => {
      const { service, usersService } = await createDeps();
      const user = makeUser({ passwordHash: "secret-hash" });
      usersService.findByLoginId.mockResolvedValue(null);
      usersService.create.mockResolvedValue(user);

      const result = (await service.register(
        "alice",
        "password1234",
      )) as unknown as Record<string, unknown>;

      expect(Object.keys(result)).toEqual(
        expect.arrayContaining(["id", "loginId"]),
      );
      expect(result).not.toHaveProperty("passwordHash");
    });
  });

  describe("login", () => {
    it("정상 로그인 시 JWT 발급 ({ sub: userId })", async () => {
      const { service, usersService, jwtService } = await createDeps();
      const passwordHash = await bcrypt.hash("password1234", 4);
      const user = makeUser({ loginId: "alice", passwordHash });
      usersService.findByLoginId.mockResolvedValue(user);

      const result = await service.login("alice", "password1234");

      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: user._id.toString(),
      });
      expect(result).toEqual({ accessToken: "signed-token" });
    });

    it("loginId trim 후 조회 (등록과 일관)", async () => {
      const { service, usersService } = await createDeps();
      const passwordHash = await bcrypt.hash("password1234", 4);
      usersService.findByLoginId.mockResolvedValue(
        makeUser({ loginId: "alice", passwordHash }),
      );

      await service.login("  alice  ", "password1234");

      expect(usersService.findByLoginId).toHaveBeenCalledWith("alice");
    });

    it("미등록 loginId → Unauthorized, 동일 문구 사용 (user enumeration 방지)", async () => {
      const { service, usersService } = await createDeps();
      usersService.findByLoginId.mockResolvedValue(null);

      await expect(
        service.login("ghost", "password1234"),
      ).rejects.toMatchObject({
        message: "Invalid credentials",
      });
      await expect(
        service.login("ghost", "password1234"),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("비밀번호 불일치 → Unauthorized, 미등록과 같은 문구", async () => {
      const { service, usersService } = await createDeps();
      const passwordHash = await bcrypt.hash("correct-password", 4);
      usersService.findByLoginId.mockResolvedValue(
        makeUser({ passwordHash }),
      );

      await expect(
        service.login("alice", "wrong-password"),
      ).rejects.toMatchObject({
        message: "Invalid credentials",
      });
    });
  });
});
