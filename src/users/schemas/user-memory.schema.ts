import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type UserMemoryDocument = HydratedDocument<UserMemory>;

@Schema({
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
  id: false,
})
export class UserMemory {
  @Prop({
    type: Types.ObjectId,
    ref: 'User',
    required: true,
  })
  userId: Types.ObjectId;

  @Prop({
    required: true,
    trim: true,
    maxlength: 1000,
  })
  content: string;

  createdAt: Date;
  updatedAt: Date;
}

export const UserMemorySchema = SchemaFactory.createForClass(UserMemory);

UserMemorySchema.index({ userId: 1, createdAt: -1 });
