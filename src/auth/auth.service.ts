import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";

import { UserDocument } from "../users/schemas/user.schema";
import { UsersService } from "../users/users.service";

export interface JwtPayload {
  sub: string;
}

export interface AuthTokenResponse {
  accessToken: string;
}

export interface RegisterResponse {
  id: string;
  loginId: string;
}

@Injectable()
export class AuthService {
  // bcrypt cost 12. 해시 1회당 약 250ms.
  private readonly saltRounds = 12;

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async register(loginId: string, password: string): Promise<RegisterResponse> {
    const normalizedLoginId = loginId.trim();
    const existingUser =
      await this.usersService.findByLoginId(normalizedLoginId);

    if (existingUser) {
      throw new ConflictException("Already registered id");
    }

    const passwordHash = await bcrypt.hash(password, this.saltRounds);
    let user: UserDocument;

    try {
      user = await this.usersService.create({
        loginId: normalizedLoginId,
        passwordHash,
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new ConflictException("Already registered id");
      }

      throw error;
    }

    return {
      id: user._id.toString(),
      loginId: user.loginId,
    };
  }

  async login(loginId: string, password: string): Promise<AuthTokenResponse> {
    const normalizedLoginId = loginId.trim();
    const user = await this.usersService.findByLoginId(normalizedLoginId);

    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    return this.issueToken(user);
  }

  private issueToken(user: UserDocument): AuthTokenResponse {
    const payload: JwtPayload = {
      sub: user._id.toString(),
    };

    return {
      accessToken: this.jwtService.sign(payload),
    };
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
