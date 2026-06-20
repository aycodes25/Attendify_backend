import { Controller, Post, UseInterceptors, UploadedFile, HttpException, HttpStatus, Body } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RecognitionProcessingService } from './recognition-processing.service';

@Controller('recognition')
export class RecognitionController {
  constructor(private readonly recognitionProcessingService: RecognitionProcessingService) {}

  @Post('verify')
  @UseInterceptors(FileInterceptor('image'))
  async verifyFace(
    @UploadedFile() file: Express.Multer.File,
    @Body('cameraName') cameraName?: string,
  ) {
    if (!file) {
      throw new HttpException('Image file is required', HttpStatus.BAD_REQUEST);
    }

    const name = cameraName || 'Live Kiosk';
    
    // Process the uploaded buffer
    await this.recognitionProcessingService.processFrame(null, name, file.buffer);
    
    return { success: true, message: 'Frame processed successfully' };
  }
}
