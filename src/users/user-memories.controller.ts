import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { toObjectId } from '../common/mongo/object-id';
import { CreateUserMemoryDto } from './dto/create-user-memory.dto';
import { UserMemoryDocument } from './schemas/user-memory.schema';
import { UserDocument } from './schemas/user.schema';
import { UserMemoriesService } from './user-memories.service';

class UserMemoryResponse {
  @ApiProperty({ example: '665f0f8f7b1f2a0012345678' })
  id: string;

  @ApiProperty({ example: '사용자는 짧고 일상적인 말투를 선호한다.' })
  content: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

@ApiTags('User Memories')
@ApiBearerAuth()
@Controller('users/me/memories')
export class UserMemoriesController {
  constructor(private readonly userMemoriesService: UserMemoriesService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  @ApiOperation({ summary: 'Create current user memory' })
  @ApiCreatedResponse({ type: UserMemoryResponse })
  async create(
    @CurrentUser() user: UserDocument,
    @Body() dto: CreateUserMemoryDto,
  ): Promise<UserMemoryResponse> {
    const memory = await this.userMemoriesService.create({
      userId: user._id,
      content: dto.content,
    });

    return this.toResponse(memory);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  @ApiOperation({ summary: 'List current user memories' })
  @ApiOkResponse({ type: UserMemoryResponse, isArray: true })
  async findMine(
    @CurrentUser() user: UserDocument,
  ): Promise<UserMemoryResponse[]> {
    const memories = await this.userMemoriesService.findMine(user._id);

    return memories.map((memory) => this.toResponse(memory));
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete current user memory' })
  @ApiParam({ name: 'id', description: 'User memory ObjectId' })
  @ApiNoContentResponse()
  async delete(
    @CurrentUser() user: UserDocument,
    @Param('id') id: string,
  ): Promise<void> {
    await this.userMemoriesService.deleteOwned(toObjectId(id), user._id);
  }

  private toResponse(memory: UserMemoryDocument): UserMemoryResponse {
    return {
      id: memory._id.toString(),
      content: memory.content,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    };
  }
}
