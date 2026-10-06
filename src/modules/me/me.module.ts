import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { RegistrationModule } from '../registration/registration.module.js';
import { MeController } from './me.controller.js';
import { MeService } from './me.service.js';

@Module({
  imports: [MongooseModule.forFeature([Models.teamAdmin]), RegistrationModule],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
