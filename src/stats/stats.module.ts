import { Module } from '@nestjs/common';

import { MessagesModule } from '../messages/messages.module';
import { StatsController } from './stats.controller';

@Module({
  imports: [MessagesModule],
  controllers: [StatsController],
})
export class StatsModule {}
