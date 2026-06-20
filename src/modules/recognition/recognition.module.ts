import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FaceRecognitionService } from './face-recognition.service';
import { RecognitionGateway } from './recognition.gateway';
import { RecognitionProcessingService } from './recognition-processing.service';
import { RecognitionController } from './recognition.controller';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [ConfigModule, SupabaseModule],
  controllers: [RecognitionController],
  providers: [FaceRecognitionService, RecognitionGateway, RecognitionProcessingService],
  exports: [FaceRecognitionService, RecognitionGateway, RecognitionProcessingService],
})
export class RecognitionModule {}
