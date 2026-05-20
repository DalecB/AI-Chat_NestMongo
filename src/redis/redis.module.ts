import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

import { ContextCacheService } from "./context-cache.service";
import { REDIS_CLIENT } from "./redis.constants";
import { SessionLockService } from "./session-lock.service";

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.getOrThrow<string>("REDIS_URL");
        // maxRetriesPerRequest=1 → fail fast (재시도 누적으로 응답 지연 방지, ContextCache의 fallback이 받음).
        // lazyConnect=true → 부팅 시 Redis 없어도 Mongo만으로 boot 가능
        return new Redis(redisUrl, {
          maxRetriesPerRequest: 1,
          lazyConnect: true,
        });
      },
    },
    ContextCacheService,
    SessionLockService,
  ],
  exports: [REDIS_CLIENT, ContextCacheService, SessionLockService],
})
export class RedisModule {}
