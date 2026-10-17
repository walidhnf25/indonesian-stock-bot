import { Module } from '@nestjs/common';
import { UserDataService } from './user-data.service';
import { UserService } from './user.service';

@Module({ providers: [UserService, UserDataService], exports: [UserService, UserDataService] })
export class UserModule {}
