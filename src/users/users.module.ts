import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { UserMemory, UserMemorySchema } from './schemas/user-memory.schema';
import { User, UserSchema } from './schemas/user.schema';
import { UserMemoriesController } from './user-memories.controller';
import { UserMemoriesService } from './user-memories.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: UserMemory.name, schema: UserMemorySchema },
    ]),
  ],
  controllers: [UsersController, UserMemoriesController],
  providers: [UsersService, UserMemoriesService],
  exports: [UsersService, UserMemoriesService],
})
export class UsersModule {}
