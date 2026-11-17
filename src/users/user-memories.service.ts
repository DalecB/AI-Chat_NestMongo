import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";

import { UserMemory, UserMemoryDocument } from "./schemas/user-memory.schema";

export interface CreateUserMemoryInput {
  userId: Types.ObjectId;
  content: string;
}

@Injectable()
export class UserMemoriesService {
  private readonly promptMemoryLimit = 20;
  private readonly maxMemoriesPerUser = 100;

  constructor(
    @InjectModel(UserMemory.name)
    private readonly userMemoryModel: Model<UserMemory>,
  ) {}

  async create(input: CreateUserMemoryInput): Promise<UserMemoryDocument> {
    // 목록 조회(limit 없음)와 저장량의 상한. 동시 요청이 겹치면 몇 개 넘칠 수 있지만 상한 목적에는 충분하다.
    const count = await this.userMemoryModel
      .countDocuments({ userId: input.userId })
      .exec();

    if (count >= this.maxMemoriesPerUser) {
      throw new BadRequestException("User memory limit reached");
    }

    return this.userMemoryModel.create(input);
  }

  async findMine(userId: Types.ObjectId): Promise<UserMemoryDocument[]> {
    return this.userMemoryModel.find({ userId }).sort({ createdAt: -1 }).exec();
  }

  async findPromptMemories(userId: Types.ObjectId): Promise<string[]> {
    const memories = await this.userMemoryModel
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(this.promptMemoryLimit)
      .select("content")
      .exec();

    // desc로 최신 N개 뽑은 뒤 ascending으로 뒤집어 프롬프트에 주입. 시간 순으로 보여줘야 LLM이 "최근일수록 더 유효"로 가중치를 자연스럽게 인식
    return memories.map((memory) => memory.content).reverse();
  }

  async deleteOwned(
    memoryId: Types.ObjectId,
    userId: Types.ObjectId,
  ): Promise<void> {
    const result = await this.userMemoryModel
      .deleteOne({ _id: memoryId, userId })
      .exec();

    if (result.deletedCount === 0) {
      throw new NotFoundException("User memory not found");
    }
  }
}
