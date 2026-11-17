import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PersonaDocument = HydratedDocument<Persona>;

@Schema({
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
  id: false,
})
export class Persona {
  @Prop({
    required: true,
    trim: true,
    maxlength: 50,
  })
  name: string;

  @Prop({
    default: '',
    trim: true,
    maxlength: 200,
  })
  description?: string;

  @Prop({
    required: true,
    trim: true,
    maxlength: 1000,
  })
  profile: string;

  @Prop({
    required: true,
    trim: true,
    maxlength: 1000,
  })
  personality: string;

  @Prop({
    required: true,
    trim: true,
    maxlength: 1000,
  })
  speakingStyle: string;

  @Prop({
    required: true,
    trim: true,
    maxlength: 1000,
  })
  scenario: string;

  @Prop({
    required: true,
    trim: true,
    maxlength: 500,
  })
  greetingMessage: string;

  @Prop({
    required: true,
    // 고정 base prompt(약 2.1K자) + 페르소나 필드 DTO 최대치 합(약 4.1K자)을 담을 수 있어야 한다.
    maxlength: 8000,
  })
  systemPrompt: string;

  @Prop({
    type: Types.ObjectId,
    ref: 'User',
    required: true,
  })
  userId: Types.ObjectId;

  @Prop({
    required: true,
    default: false,
  })
  isPublic: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const PersonaSchema = SchemaFactory.createForClass(Persona);

PersonaSchema.index({ isPublic: 1, createdAt: -1 });
PersonaSchema.index({ userId: 1, createdAt: -1 });
PersonaSchema.index({ isPublic: 1, name: 1, createdAt: -1 });

PersonaSchema.virtual('sessions', {
  ref: 'Session',
  localField: '_id',
  foreignField: 'personaId',
});
