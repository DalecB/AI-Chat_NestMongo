import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

export type SessionDocument = HydratedDocument<Session>;

@Schema({ _id: false })
export class SessionTokenUsage {
  @Prop({ default: 0 })
  prompt: number;

  @Prop({ default: 0 })
  completion: number;

  @Prop({ default: 0 })
  total: number;
}

export const SessionTokenUsageSchema =
  SchemaFactory.createForClass(SessionTokenUsage);

@Schema({
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
  id: false,
})
export class Session {
  @Prop({
    type: Types.ObjectId,
    ref: "User",
    required: true,
  })
  userId: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: "Persona",
    required: true,
  })
  personaId: Types.ObjectId;

  @Prop({ type: String, default: null })
  title: string | null;

  // 메시지가 없는 세션도 목록에 포함하기 위해 nullable.
  @Prop({ type: Date, default: null })
  lastMessageAt: Date | null;

  @Prop({
    type: SessionTokenUsageSchema,
    default: () => ({ prompt: 0, completion: 0, total: 0 }),
  })
  tokenUsage: SessionTokenUsage;

  // 긴 대화 압축용 세션 상태. Persona.scenario는 초기 설정이고, 현재 장소/상황은 stateSummary가 우선한다.
  @Prop({ type: String, default: null, maxlength: 4000 })
  stateSummary: string | null;

  // 마지막으로 stateSummary에 반영한 message id. 이 커서 이후 completed 메시지가 SUMMARY_INTERVAL 이상 쌓이면 다시 요약한다.
  @Prop({ type: Types.ObjectId, ref: "Message", default: null })
  summaryCursorMessageId: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  summaryUpdatedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export const SessionSchema = SchemaFactory.createForClass(Session);

// 사용자별 세션 목록 정렬용. lastMessageAt 기준이며 cursor에서 createdAt+_id로 tie-break.
SessionSchema.index({ userId: 1, lastMessageAt: -1 });
