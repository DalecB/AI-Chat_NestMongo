import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";

import { CHAT_CONTEXT_WINDOW_SIZE } from "../common/chat-context";
import {
  Message,
  MessageDocument,
  MessageRole,
  MessageTokenUsage,
  StreamStatus,
} from "./schemas/message.schema";

export interface CreateMessageInput {
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
  role: MessageRole;
  content: string;
  tokenUsage?: MessageTokenUsage | null;
  streamStatus?: StreamStatus;
}

export interface ListBySessionPage {
  items: MessageDocument[];
  nextCursor: string | null;
}

export interface TokenStatsItem {
  _id: string;
  totalTokens: number;
  messageCount: number;
}

export interface MessageResponse {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  tokenUsage: MessageTokenUsage | null;
  streamStatus: StreamStatus;
  createdAt: Date;
}

@Injectable()
export class MessagesService {
  private readonly pageSize = 100;

  constructor(
    @InjectModel(Message.name) private readonly messageModel: Model<Message>,
  ) {}

  async create(input: CreateMessageInput): Promise<MessageDocument> {
    return this.messageModel.create(input);
  }

  toResponse(message: MessageDocument): MessageResponse {
    return {
      id: message._id.toString(),
      sessionId: message.sessionId.toString(),
      role: message.role,
      content: message.content,
      tokenUsage: message.tokenUsage,
      streamStatus: message.streamStatus,
      createdAt: message.createdAt,
    };
  }

  async completeAssistantMessage(
    messageId: Types.ObjectId,
    content: string,
    tokenUsage: MessageTokenUsage,
  ): Promise<MessageDocument> {
    const message = await this.messageModel
      .findByIdAndUpdate(
        messageId,
        {
          $set: {
            content,
            tokenUsage,
            streamStatus: "completed",
          },
        },
        { new: true },
      )
      .exec();

    if (!message) {
      throw new BadRequestException("Invalid assistant message");
    }

    return message;
  }

  async failAssistantMessage(
    messageId: Types.ObjectId,
  ): Promise<MessageDocument> {
    const message = await this.messageModel
      .findByIdAndUpdate(
        messageId,
        {
          $set: {
            streamStatus: "failed",
          },
        },
        { new: true },
      )
      .exec();

    if (!message) {
      throw new BadRequestException("Invalid assistant message");
    }

    return message;
  }

  async findRecentBySession(
    sessionId: Types.ObjectId,
    limit = CHAT_CONTEXT_WINDOW_SIZE,
  ): Promise<MessageDocument[]> {
    const messages = await this.messageModel
      .find({ sessionId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();

    // desc로 조회 후 ascending으로 뒤집어 LLM에 전달. LLM은 시간 순 컨텍스트를 기대 (ADR-3)
    return messages.reverse();
  }

  async findPageBySession(
    sessionId: Types.ObjectId,
    cursor?: Types.ObjectId,
  ): Promise<ListBySessionPage> {
    const cursorMessage = cursor
      ? await this.messageModel.findOne({ _id: cursor, sessionId }).exec()
      : null;

    if (cursor && !cursorMessage) {
      throw new BadRequestException("Invalid message cursor");
    }

    const cursorFilter = cursorMessage
      ? {
          $or: [
            { createdAt: { $lt: cursorMessage.createdAt } },
            {
              createdAt: cursorMessage.createdAt,
              _id: { $lt: cursorMessage._id },
            },
          ],
        }
      : {};

    const messages = await this.messageModel
      .find({ sessionId, ...cursorFilter })
      .sort({ createdAt: -1, _id: -1 })
      .limit(this.pageSize + 1)
      .exec();

    const hasNext = messages.length > this.pageSize;
    const page = messages.slice(0, this.pageSize);
    const oldestMessage = page.at(-1);

    return {
      items: page.reverse(),
      nextCursor:
        hasNext && oldestMessage ? oldestMessage._id.toString() : null,
    };
  }

  async aggregateTokenStatsByDay(
    userId: Types.ObjectId,
    from: Date,
    to: Date,
  ): Promise<TokenStatsItem[]> {
    return this.messageModel
      .aggregate<TokenStatsItem>([
        // role:'assistant'만 집계. user 메시지는 token usage가 항상 0 (ADR-4).
        // assistant 메시지만 stream_options.include_usage로 받은 실측 토큰
        {
          $match: {
            userId,
            role: "assistant",
            createdAt: { $gte: from, $lte: to },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
              },
            },
            totalTokens: { $sum: { $ifNull: ["$tokenUsage.total", 0] } },
            messageCount: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .exec();
  }
}
