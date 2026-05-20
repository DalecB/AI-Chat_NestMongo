import { Inject, Injectable } from "@nestjs/common";
import Redis from "ioredis";

import { CHAT_CONTEXT_WINDOW_SIZE } from "../common/chat-context";
import { REDIS_CLIENT } from "./redis.constants";

export interface ContextMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

@Injectable()
export class ContextCacheService {
  // 윈도우 8개 = user+assistant 4쌍. ADR-3 참조.
  private readonly windowSize = CHAT_CONTEXT_WINDOW_SIZE;
  private readonly ttlSeconds = 60 * 60;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // Mongo가 source of truth. Redis 캐시는 실패해도 무시한다.
  // cache miss는 Mongo fallback 후 Redis refill, Redis read 장애는 Mongo fallback만 수행. ADR-7
  async getContextWithFallback(
    sessionId: string,
    fallback: () => Promise<ContextMessage[]>,
  ): Promise<ContextMessage[]> {
    const key = this.key(sessionId);

    try {
      const cached = await this.redis.lrange(key, 0, this.windowSize - 1);

      if (cached.length > 0) {
        return cached
          .map((item) => JSON.parse(item) as ContextMessage)
          .reverse();
      }
    } catch {
      return fallback();
    }

    const messages = await fallback();
    await this.replace(sessionId, messages);

    return messages;
  }

  async pushMessage(sessionId: string, message: ContextMessage): Promise<void> {
    try {
      await this.redis
        .multi()
        .lpush(this.key(sessionId), JSON.stringify(message))
        .ltrim(this.key(sessionId), 0, this.windowSize - 1)
        .expire(this.key(sessionId), this.ttlSeconds)
        .exec();
    } catch {
      // MongoDB는 source of truth. 캐시 쓰기 실패는 무시한다.
    }
  }

  private async replace(
    sessionId: string,
    messages: ContextMessage[],
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    // multi() 호출 자체가 throw할 수 있으므로 메서드 전체를 try로 감싼다.
    // exec()만 try하면 Redis 다운 시 sync throw가 SSE 응답을 깨뜨린다.
    try {
      const key = this.key(sessionId);
      const pipeline = this.redis.multi().del(key);

      for (const message of messages) {
        pipeline.lpush(key, JSON.stringify(message));
      }

      await pipeline
        .ltrim(key, 0, this.windowSize - 1)
        .expire(key, this.ttlSeconds)
        .exec();
    } catch {
      // Cache fill failures must not block the LLM request path.
    }
  }

  private key(sessionId: string): string {
    return `ctx:${sessionId}`;
  }
}
