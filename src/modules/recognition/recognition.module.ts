import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FaceRecognitionService } from './face-recognition.service';
import { RecognitionGateway } from './recognition.gateway';

@Module({
  imports: [ConfigModule],
  providers: [FaceRecognitionService, RecognitionGateway],
  exports: [FaceRecognitionService, RecognitionGateway],
})
export class RecognitionModule {}
