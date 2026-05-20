import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { toObjectId } from '../common/mongo/object-id';
import { UserDocument } from '../users/schemas/user.schema';
import { CreatePersonaDto } from './dto/create-persona.dto';
import { UpdatePersonaDto } from './dto/update-persona.dto';
import { PersonaDocument } from './schemas/persona.schema';
import { PersonasService } from './personas.service';

class PersonaResponse {
  @ApiProperty({ example: '665f0f8f7b1f2a0012345678' })
  id: string;

  @ApiProperty({ example: 'Sherlock' })
  name: string;

  @ApiProperty({ example: '차가운 명탐정' })
  description: string;

  @ApiProperty({ example: '런던에서 활동하는 예리한 추리 전문가.' })
  profile: string;

  @ApiProperty({ example: '냉정하고 논리적이며 관찰력이 뛰어남.' })
  personality: string;

  @ApiProperty({
    example: '짧고 단정하게 말하며, 가끔 날카로운 농담을 섞음.',
  })
  speakingStyle: string;

  @ApiProperty({
    example: '사용자는 사건 상담을 위해 셜록의 하숙집을 방문했다.',
  })
  scenario: string;

  @ApiProperty({ example: '어서 오게. 문 앞에서 망설인 이유부터 말해보게.' })
  greetingMessage: string;

  @ApiProperty({ example: true })
  isPublic: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

@ApiTags('Personas')
@ApiBearerAuth()
@Controller('personas')
export class PersonasController {
  constructor(private readonly personasService: PersonasService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  @ApiOperation({ summary: 'Create persona' })
  @ApiCreatedResponse({ type: PersonaResponse })
  async create(
    @CurrentUser() user: UserDocument,
    @Body() dto: CreatePersonaDto,
  ): Promise<PersonaResponse> {
    const persona = await this.personasService.create({
      name: dto.name,
      description: dto.description,
      profile: dto.profile,
      personality: dto.personality,
      speakingStyle: dto.speakingStyle,
      scenario: dto.scenario,
      greetingMessage: dto.greetingMessage,
      isPublic: dto.isPublic ?? false,
      userId: user._id,
    });

    return this.toResponse(persona);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  @ApiOperation({ summary: 'List public personas' })
  @ApiQuery({
    name: 'name',
    required: false,
    description: 'Optional public persona name search.',
  })
  @ApiOkResponse({ type: PersonaResponse, isArray: true })
  async findPublic(@Query('name') name?: string): Promise<PersonaResponse[]> {
    const personas = name
      ? await this.personasService.findPublicByName(name)
      : await this.personasService.findPublicRecent();

    return personas.map((persona) => this.toResponse(persona));
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  @ApiOperation({ summary: 'Get accessible persona' })
  @ApiParam({ name: 'id', description: 'Persona ObjectId' })
  @ApiOkResponse({ type: PersonaResponse })
  async findOne(
    @CurrentUser() user: UserDocument,
    @Param('id') id: string,
  ): Promise<PersonaResponse> {
    const persona = await this.personasService.findAccessibleById(
      toObjectId(id),
      user._id,
    );

    if (!persona) {
      throw new NotFoundException('Persona not found');
    }

    return this.toResponse(persona);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  @ApiOperation({ summary: 'Update owned private persona or publish it' })
  @ApiParam({ name: 'id', description: 'Persona ObjectId' })
  @ApiOkResponse({ type: PersonaResponse })
  async update(
    @CurrentUser() user: UserDocument,
    @Param('id') id: string,
    @Body() dto: UpdatePersonaDto,
  ): Promise<PersonaResponse> {
    const persona = await this.personasService.updateOwned(
      toObjectId(id),
      user._id,
      {
        name: dto.name,
        description: dto.description,
        profile: dto.profile,
        personality: dto.personality,
        speakingStyle: dto.speakingStyle,
        scenario: dto.scenario,
        greetingMessage: dto.greetingMessage,
        isPublic: dto.isPublic,
      },
    );

    return this.toResponse(persona);
  }

  private toResponse(persona: PersonaDocument): PersonaResponse {
    return {
      id: persona._id.toString(),
      name: persona.name,
      description: persona.description ?? '',
      profile: persona.profile,
      personality: persona.personality,
      speakingStyle: persona.speakingStyle,
      scenario: persona.scenario,
      greetingMessage: persona.greetingMessage,
      isPublic: persona.isPublic,
      createdAt: persona.createdAt,
    };
  }
}
