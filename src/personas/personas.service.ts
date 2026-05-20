import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";

import { buildPersonaSystemPrompt } from "../llm/prompt-harness";
import { Persona, PersonaDocument } from "./schemas/persona.schema";

export interface CreatePersonaInput {
  name: string;
  description?: string;
  profile: string;
  personality: string;
  speakingStyle: string;
  scenario: string;
  greetingMessage: string;
  userId: Types.ObjectId;
  isPublic?: boolean;
}

export interface UpdatePersonaInput {
  name?: string;
  description?: string;
  profile?: string;
  personality?: string;
  speakingStyle?: string;
  scenario?: string;
  greetingMessage?: string;
  isPublic?: boolean;
}

@Injectable()
export class PersonasService {
  constructor(
    @InjectModel(Persona.name) private readonly personaModel: Model<Persona>,
  ) {}

  async create(input: CreatePersonaInput): Promise<PersonaDocument> {
    return this.personaModel.create({
      ...input,
      systemPrompt: buildPersonaSystemPrompt({
        name: input.name,
        profile: input.profile,
        personality: input.personality,
        speakingStyle: input.speakingStyle,
        scenario: input.scenario,
      }),
    });
  }

  async findById(personaId: Types.ObjectId): Promise<PersonaDocument | null> {
    return this.personaModel.findById(personaId).exec();
  }

  async updateOwned(
    personaId: Types.ObjectId,
    userId: Types.ObjectId,
    input: UpdatePersonaInput,
  ): Promise<PersonaDocument> {
    const persona = await this.personaModel.findById(personaId).exec();

    if (!persona) {
      throw new NotFoundException("Persona not found");
    }

    if (!persona.userId.equals(userId)) {
      throw new ForbiddenException("Forbidden persona");
    }

    // ADR-2: 공개된 페르소나는 수정 금지. 대화 중인 캐릭터의 정체성을 보존한다.
    if (persona.isPublic) {
      throw new BadRequestException("Published persona cannot be updated");
    }

    if (input.name !== undefined) {
      persona.name = input.name;
    }

    if (input.description !== undefined) {
      persona.description = input.description;
    }

    if (input.profile !== undefined) {
      persona.profile = input.profile;
    }

    if (input.personality !== undefined) {
      persona.personality = input.personality;
    }

    if (input.speakingStyle !== undefined) {
      persona.speakingStyle = input.speakingStyle;
    }

    if (input.scenario !== undefined) {
      persona.scenario = input.scenario;
    }

    if (input.greetingMessage !== undefined) {
      persona.greetingMessage = input.greetingMessage;
    }

    persona.systemPrompt = buildPersonaSystemPrompt({
      name: persona.name,
      profile: persona.profile,
      personality: persona.personality,
      speakingStyle: persona.speakingStyle,
      scenario: persona.scenario,
    });

    if (input.isPublic !== undefined) {
      persona.isPublic = input.isPublic;
    }

    return persona.save();
  }

  async findAccessibleById(
    personaId: Types.ObjectId,
    userId: Types.ObjectId,
  ): Promise<PersonaDocument | null> {
    return this.personaModel
      .findOne({
        _id: personaId,
        $or: [{ isPublic: true }, { userId }],
      })
      .exec();
  }

  async findPublicRecent(): Promise<PersonaDocument[]> {
    return this.personaModel
      .find({ isPublic: true })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findMine(userId: Types.ObjectId): Promise<PersonaDocument[]> {
    return this.personaModel.find({ userId }).sort({ createdAt: -1 }).exec();
  }

  async findPublicByName(name: string): Promise<PersonaDocument[]> {
    return this.personaModel
      .find({ isPublic: true, name })
      .sort({ createdAt: -1 })
      .exec();
  }
}
