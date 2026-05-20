import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { LlmModule } from '../llm/llm.module';
import { PersonasModule } from '../personas/personas.module';
import { SessionsModule } from '../sessions/sessions.module';
import { UsersModule } from '../users/users.module';
import { ChatOrchestratorService } from './chat-orchestrator.service';
import { MessagesController } from './messages.controller';
import { Message, MessageSchema } from './schemas/message.schema';
import { MessagesService } from './messages.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Message.name, schema: MessageSchema }]),
    LlmModule,
    PersonasModule,
    SessionsModule,
    UsersModule,
  ],
  controllers: [MessagesController],
  providers: [ChatOrchestratorService, MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
