import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [MongooseModule.forFeature([Models.user])],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
