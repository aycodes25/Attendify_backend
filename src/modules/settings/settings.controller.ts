import { Controller, Get, Put, Body, Param, UseGuards, HttpException, HttpStatus } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { SettingsService } from './settings.service';

@Controller('settings')
@UseGuards(AuthGuard, RolesGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @Roles('Super Admin', 'Church Admin', 'Attendance Officer', 'Pastor', 'Viewer')
  async getAllSettings() {
    return this.settingsService.getAllSettings();
  }

  @Put(':key')
  @Roles('Super Admin', 'Church Admin')
  async updateSetting(
    @Param('key') key: string,
    @Body() body: { value: any },
  ) {
    if (body.value === undefined) {
      throw new HttpException('Value field is required', HttpStatus.BAD_REQUEST);
    }
    return this.settingsService.updateSettings(key, body.value);
  }
}
