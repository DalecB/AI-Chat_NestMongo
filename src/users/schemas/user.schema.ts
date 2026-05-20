import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UserDocument = HydratedDocument<User>;

@Schema({
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
  id: false,
})
export class User {
  @Prop({ required: true, unique: true, index: true, trim: true })
  loginId: string;

  @Prop({ required: true, select: false })
  passwordHash: string;

  createdAt: Date;
  updatedAt: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.virtual('personas', {
  ref: 'Persona',
  localField: '_id',
  foreignField: 'userId',
});

UserSchema.virtual('sessions', {
  ref: 'Session',
  localField: '_id',
  foreignField: 'userId',
});

UserSchema.virtual('memories', {
  ref: 'UserMemory',
  localField: '_id',
  foreignField: 'userId',
});
