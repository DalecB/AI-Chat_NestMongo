import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

export function toObjectId(value: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) {
    throw new BadRequestException('Invalid ObjectId');
  }

  return new Types.ObjectId(value);
}

