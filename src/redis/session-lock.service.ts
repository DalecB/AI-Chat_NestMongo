import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import Redis from "ioredis";

import { REDIS_CLIENT } from "./redis.constants";

export interface SessionLock {
  key: string;
  ownerId: string;
}

@Injectable()
export class SessionLockService {
  // LLM 응답이 평균 5~30초 범위라 60초로 설정. watchdog 패턴은 도입하지 않음.
  private readonly ttlSeconds = 60;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async acquire(sessionId: string): Promise<SessionLock> {
    const key = `lock:session:${sessionId}`;
    const ownerId = randomUUID();

    let result: string | null;

    try {
      result = await this.redis.set(key, ownerId, "EX", this.ttlSeconds, "NX");
    } catch {
      throw new ServiceUnavailableException("Session lock unavailable");
    }

    if (result !== "OK") {
      throw new HttpException(
        "Session is already processing a message",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return { key, ownerId };
  }

  async release(lock: SessionLock): Promise<void> {
    // 소유권 검증과 DEL을 Lua로 묶어 원자적으로 실행. TTL 만료 후 새 락을 잡은 다른 요청을 잘못 해제하지 않도록 한다.
    const releaseScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end

      return 0
    `;

    try {
      await this.redis.eval(releaseScript, 1, lock.key, lock.ownerId);
    } catch {
      // The lock has a TTL. Release failure must not turn a completed SSE
      // response into an application error.
    }
  }
}
