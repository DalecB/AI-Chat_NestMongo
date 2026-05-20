import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";

import { Message, MessageDocument } from "../messages/schemas/message.schema";
import {
  Session,
  SessionDocument,
  SessionTokenUsage,
} from "./schemas/session.schema";

export interface CreateSessionInput {
  userId: Types.ObjectId;
  personaId: Types.ObjectId;
  title?: string | null;
}

export interface CreateSessionWithGreetingInput extends CreateSessionInput {
  greetingMessage: string;
}

export interface ListSessionsPage {
  items: SessionDocument[];
  nextCursor: string | null;
}

export interface SummaryCandidatePage {
  messages: MessageDocument[];
  shouldUpdate: boolean;
  summaryCursorMessageId: Types.ObjectId | null;
}

@Injectable()
export class SessionsService {
  private readonly pageSize = 20;

  constructor(
    @InjectModel(Session.name) private readonly sessionModel: Model<Session>,
    @InjectModel(Message.name) private readonly messageModel: Model<Message>,
  ) {}

  async create(input: CreateSessionInput): Promise<SessionDocument> {
    return this.sessionModel.create(input);
  }

  async createWithGreeting(
    input: CreateSessionWithGreetingInput,
  ): Promise<SessionDocument> {
    const session = await this.sessionModel.create({
      userId: input.userId,
      personaId: input.personaId,
      title: input.title,
    });

    const greetingMessage = await this.messageModel.create({
      sessionId: session._id,
      userId: input.userId,
      role: "assistant",
      content: input.greetingMessage,
      tokenUsage: null,
      streamStatus: "completed",
    });

    session.lastMessageAt = greetingMessage.createdAt;
    await session.save();

    return session;
  }

  async findById(sessionId: Types.ObjectId): Promise<SessionDocument | null> {
    return this.sessionModel.findById(sessionId).exec();
  }

  async findMine(userId: Types.ObjectId): Promise<SessionDocument[]> {
    return this.sessionModel
      .find({ userId })
      .sort({ lastMessageAt: -1 })
      .exec();
  }

  async findOwned(
    sessionId: Types.ObjectId,
    userId: Types.ObjectId,
  ): Promise<SessionDocument | null> {
    return this.sessionModel.findOne({ _id: sessionId, userId }).exec();
  }

  async findOwnedOrThrow(
    sessionId: Types.ObjectId,
    userId: Types.ObjectId,
  ): Promise<SessionDocument> {
    const session = await this.findById(sessionId);

    if (!session) {
      throw new NotFoundException("Session not found");
    }

    if (!session.userId.equals(userId)) {
      throw new ForbiddenException("Forbidden session");
    }

    return session;
  }

  async deleteOwnedWithMessages(
    sessionId: Types.ObjectId,
    userId: Types.ObjectId,
  ): Promise<void> {
    const session = await this.findOwnedOrThrow(sessionId, userId);
    const mongoSession = await this.sessionModel.db.startSession();

    try {
      await mongoSession.withTransaction(async () => {
        await this.messageModel
          .deleteMany({ sessionId: session._id })
          .session(mongoSession)
          .exec();

        await this.sessionModel
          .deleteOne({ _id: session._id, userId })
          .session(mongoSession)
          .exec();
      });
    } finally {
      await mongoSession.endSession();
    }
  }

  async findMinePage(
    userId: Types.ObjectId,
    cursor?: Types.ObjectId,
  ): Promise<ListSessionsPage> {
    const cursorSession = cursor
      ? await this.sessionModel.findOne({ _id: cursor, userId }).exec()
      : null;

    if (cursor && !cursorSession) {
      throw new BadRequestException("Invalid session cursor");
    }

    const cursorFilter = cursorSession
      ? this.buildCursorFilter(cursorSession)
      : {};

    const sessions = await this.sessionModel
      .find({ userId, ...cursorFilter })
      .sort({ lastMessageAt: -1, createdAt: -1, _id: -1 })
      .limit(this.pageSize + 1)
      .exec();

    const hasNext = sessions.length > this.pageSize;
    const page = sessions.slice(0, this.pageSize);
    const lastSession = page.at(-1);

    return {
      items: page,
      nextCursor: hasNext && lastSession ? lastSession._id.toString() : null,
    };
  }

  async touchMessageAt(
    sessionId: Types.ObjectId,
    messageCreatedAt: Date,
  ): Promise<void> {
    await this.sessionModel
      .updateOne(
        { _id: sessionId },
        { $set: { lastMessageAt: messageCreatedAt } },
      )
      .exec();
  }

  async addTokenUsage(
    sessionId: Types.ObjectId,
    tokenUsage: SessionTokenUsage,
  ): Promise<void> {
    await this.sessionModel
      .updateOne(
        { _id: sessionId },
        {
          $inc: {
            "tokenUsage.prompt": tokenUsage.prompt,
            "tokenUsage.completion": tokenUsage.completion,
            "tokenUsage.total": tokenUsage.total,
          },
        },
      )
      .exec();
  }

  async findSummaryCandidates(
    session: SessionDocument,
    triggerInterval: number,
    initialMessageLimit: number,
    summaryMessageLimit: number,
  ): Promise<SummaryCandidatePage> {
    const cursorFilter = await this.buildSummaryCursorFilter(session);
    const newMessages = await this.messageModel
      .find({
        sessionId: session._id,
        streamStatus: "completed",
        ...cursorFilter,
      })
      .sort({ createdAt: 1, _id: 1 })
      .limit(triggerInterval)
      .exec();
    const shouldUpdate = newMessages.length >= triggerInterval;

    if (!shouldUpdate) {
      return {
        messages: [],
        shouldUpdate: false,
        summaryCursorMessageId: null,
      };
    }

    const summaryCursorMessage = newMessages.at(-1);

    if (!session.summaryCursorMessageId) {
      return {
        messages: newMessages.slice(0, initialMessageLimit),
        shouldUpdate: true,
        summaryCursorMessageId: summaryCursorMessage?._id ?? null,
      };
    }

    const latestMessages = await this.messageModel
      .find({
        sessionId: session._id,
        streamStatus: "completed",
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(summaryMessageLimit)
      .exec();

    return {
      messages: latestMessages.reverse(),
      shouldUpdate: true,
      summaryCursorMessageId: summaryCursorMessage?._id ?? null,
    };
  }

  async updateStateSummary(
    sessionId: Types.ObjectId,
    stateSummary: string,
    summaryCursorMessageId: Types.ObjectId,
  ): Promise<void> {
    await this.sessionModel
      .updateOne(
        { _id: sessionId },
        {
          $set: {
            stateSummary,
            summaryCursorMessageId,
            summaryUpdatedAt: new Date(),
          },
        },
      )
      .exec();
  }

  private async buildSummaryCursorFilter(session: SessionDocument) {
    if (!session.summaryCursorMessageId) {
      return {};
    }

    const cursorMessage = await this.messageModel
      .findOne({
        _id: session.summaryCursorMessageId,
        sessionId: session._id,
      })
      .exec();

    if (!cursorMessage) {
      return {};
    }

    return {
      $or: [
        { createdAt: { $gt: cursorMessage.createdAt } },
        {
          createdAt: cursorMessage.createdAt,
          _id: { $gt: cursorMessage._id },
        },
      ],
    };
  }

  // lastMessageAt이 null인 세션(메시지 없음)이 섞여 있어 cursor 분기가 두 갈래.
  // 같은 lastMessageAt 동률은 createdAt + _id로 tie-break해서 페이지 경계 안정화
  private buildCursorFilter(cursorSession: SessionDocument) {
    const lastMessageAt = cursorSession.lastMessageAt;

    if (lastMessageAt) {
      return {
        $or: [
          { lastMessageAt: { $lt: lastMessageAt } },
          { lastMessageAt: null },
          {
            lastMessageAt,
            createdAt: { $lt: cursorSession.createdAt },
          },
          {
            lastMessageAt,
            createdAt: cursorSession.createdAt,
            _id: { $lt: cursorSession._id },
          },
        ],
      };
    }

    return {
      lastMessageAt: null,
      $or: [
        { createdAt: { $lt: cursorSession.createdAt } },
        {
          createdAt: cursorSession.createdAt,
          _id: { $lt: cursorSession._id },
        },
      ],
    };
  }
}
