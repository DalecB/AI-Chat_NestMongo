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
        // socketTimeout=5000 → half-open 소켓(FIN 없이 죽은 연결: 배포 재시작·네트워크 파티션·LB idle drop)을
        //   바운딩. maxRetriesPerRequest는 close/error 이벤트가 떠야 세므로, 이벤트 없이 매달리는 소켓은
        //   못 막는다(keepAlive=0라 OS 탐지도 없음) → 명령이 무한 hang → catch/fallback이 아예 안 돎.
        //   Redis 명령은 sub-ms 응답이라 5s는 순수 안전 마진(정상 연결 오살 없이 hang만 상한). fail-fast 완성.
        //   ⚠ ioredis>=6.0.0 필수: 5.x는 재연결 시 옛 socketTimeout 타이머가 새 스트림을 죽이는 버그(#2148 미포함).
        return new Redis(redisUrl, {
          maxRetriesPerRequest: 1,
          lazyConnect: true,
          socketTimeout: 5000,
        });
      },
    },
    ContextCacheService,
    SessionLockService,
  ],
  exports: [REDIS_CLIENT, ContextCacheService, SessionLockService],
})
export class RedisModule {}
