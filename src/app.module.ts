import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { LlmModule } from './llm/llm.module';
import { MessagesModule } from './messages/messages.module';
import { PersonasModule } from './personas/personas.module';
import { RedisModule } from './redis/redis.module';
import { SessionsModule } from './sessions/sessions.module';
import { StatsModule } from './stats/stats.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.getOrThrow<string>('MONGO_URI'),
      }),
    }),
    RedisModule,
    LlmModule,
    UsersModule,
    AuthModule,
    PersonasModule,
    SessionsModule,
    MessagesModule,
    StatsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}

