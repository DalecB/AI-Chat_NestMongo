import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

export type MessageDocument = HydratedDocument<Message>;
export type MessageRole = "user" | "assistant";
export type StreamStatus = "pending" | "streaming" | "completed" | "failed";

@Schema({ _id: false })
export class MessageTokenUsage {
  @Prop({ default: 0 })
  prompt: number;

  @Prop({ default: 0 })
  completion: number;

  @Prop({ default: 0 })
  total: number;
}

export const MessageTokenUsageSchema =
  SchemaFactory.createForClass(MessageTokenUsage);

@Schema({
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
  id: false,
})
export class Message {
  @Prop({
    type: Types.ObjectId,
    ref: "Session",
    required: true,
  })
  sessionId: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: "User",
    required: true,
  })
  userId: Types.ObjectId;

  @Prop({
    required: true,
    enum: ["user", "assistant"],
  })
  role: MessageRole;

  @Prop({ default: "" })
  content: string;

  // assistant 메시지에만 채워지는 토큰 사용량. user 메시지는 null. ADR-4 참조.
  @Prop({
    type: MessageTokenUsageSchema,
    default: null,
  })
  tokenUsage: MessageTokenUsage | null;

  // user 메시지는 즉시 completed. assistant 메시지는 streaming → completed/failed로 전이. ADR-6 참조.
  @Prop({
    enum: ["pending", "streaming", "completed", "failed"],
    default: "completed",
  })
  streamStatus: StreamStatus;

  createdAt: Date;
  updatedAt: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

// 컨텍스트 윈도우 조회용 (ADR-3, ADR-7). ContextCacheService fallback이 사용한다.
MessageSchema.index({ sessionId: 1, createdAt: -1 });
// 사용자별 일자별 토큰 통계 aggregation용 (ADR-4).
MessageSchema.index({ userId: 1, createdAt: -1 });
