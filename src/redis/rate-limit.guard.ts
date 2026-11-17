import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  SetMetadata,
  UseGuards,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request, Response } from "express";
import Redis from "ioredis";

import { REDIS_CLIENT } from "./redis.constants";

export interface RateLimitRule {
  name: string;
  limit: number;
  // ip: 인증 전 경로(로그인·가입). user: JwtAuthGuard 뒤에서 사용자 단위.
  by: "ip" | "user";
}

const RATE_LIMIT_RULE = "rateLimitRule";
const WINDOW_SECONDS = 60;

// INCR와 첫 EXPIRE를 한 번에 실행한다. 둘이 갈라져 EXPIRE가 빠지면 TTL 없는 키가 남아 영구 차단된다.
const INCR_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return { count, redis.call("TTL", KEYS[1]) }
`;

// 사용자 단위 규칙은 req.user가 필요하므로 메서드에서 @UseGuards(JwtAuthGuard)보다 위에 둔다
// (데코레이터는 아래부터 적용되어 위에 있는 가드가 나중에 실행된다).
export const RateLimit = (rule: RateLimitRule) =>
  applyDecorators(
    SetMetadata(RATE_LIMIT_RULE, rule),
    UseGuards(RateLimitGuard),
  );

// 고정 윈도(60초) 카운터. 윈도 경계에서 최대 2배 burst를 허용한다. 더 엄격해야 하면 sliding window로 바꾼다.
// IP는 req.ip다. 로드밸런서 뒤에서는 Express 'trust proxy'를 설정해야 클라이언트별로 나뉜다.
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.get<RateLimitRule>(
      RATE_LIMIT_RULE,
      context.getHandler(),
    );
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: { _id: unknown } }>();
    const subject = this.subjectOf(rule, request);
    const key = `rl:${rule.name}:${subject}`;

    let count: number;
    let ttl: number;

    try {
      [count, ttl] = (await this.redis.eval(
        INCR_SCRIPT,
        1,
        key,
        WINDOW_SECONDS,
      )) as [number, number];
    } catch (error) {
      // Redis 장애로 로그인까지 막지 않는다. 메시지 전송은 세션 락이 Redis 장애 시 503으로 막는다.
      this.logger.warn(
        `Rate limit skipped. key=${key} reason=${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }

    if (count > rule.limit) {
      http
        .getResponse<Response>()
        .setHeader("Retry-After", String(Math.max(ttl, 1)));
      throw new HttpException(
        "Too many requests",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private subjectOf(
    rule: RateLimitRule,
    request: Request & { user?: { _id: unknown } },
  ): string {
    if (rule.by === "ip") {
      return request.ip ?? "unknown";
    }

    if (!request.user) {
      throw new Error(
        `RateLimit(${rule.name}) by user must run after JwtAuthGuard`,
      );
    }

    return String(request.user._id);
  }
}
