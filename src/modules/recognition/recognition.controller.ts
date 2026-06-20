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

    // Use kiosk-specific path that ALWAYS saves a visitor record
    const result = await this.recognitionProcessingService.processKioskFrame(name, file.buffer);

    return {
      success: true,
      matched: result.matched,
      memberId: result.memberId || null,
      message: result.matched ? 'Attendance marked for known member' : 'Visitor captured and saved to pending',
    };
  }
}
