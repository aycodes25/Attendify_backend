import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CameraStreamService } from './camera-stream.service';
import { CamerasController } from './cameras.controller';
import { RecognitionModule } from '../recognition/recognition.module';

@Module({
  imports: [ConfigModule, RecognitionModule],
  controllers: [CamerasController],
  providers: [CameraStreamService],
  exports: [CameraStreamService],
})
export class CamerasModule {}
