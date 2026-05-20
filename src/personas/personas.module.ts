import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { PersonasController } from './personas.controller';
import { Persona, PersonaSchema } from './schemas/persona.schema';
import { PersonasService } from './personas.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: Persona.name, schema: PersonaSchema }])],
  controllers: [PersonasController],
  providers: [PersonasService],
  exports: [PersonasService],
})
export class PersonasModule {}
