import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SupabaseModule } from './modules/supabase/supabase.module';
import { RecognitionModule } from './modules/recognition/recognition.module';
import { CamerasModule } from './modules/cameras/cameras.module';
import { MembersModule } from './modules/members/members.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { VisitorsModule } from './modules/visitors/visitors.module';
import { SettingsModule } from './modules/settings/settings.module';
import { AppController } from './app.controller';

@Module({
  controllers: [AppController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    SupabaseModule,
    RecognitionModule,
    CamerasModule,
    MembersModule,
    AttendanceModule,
    VisitorsModule,
    SettingsModule,
  ],
})
export class AppModule {}
