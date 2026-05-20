import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { User, UserDocument } from './schemas/user.schema';

export interface CreateUserInput {
  loginId: string;
  passwordHash: string;
}

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private readonly userModel: Model<User>) {}

  async create(input: CreateUserInput): Promise<UserDocument> {
    return this.userModel.create(input);
  }

  async findById(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).exec();
  }

  async findByLoginId(loginId: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ loginId }).select('+passwordHash').exec();
  }
}
