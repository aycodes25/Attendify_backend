import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  getHello() {
    return {
      status: 'ok',
      message: 'Attendify API is running smoothly!',
      timestamp: new Date().toISOString()
    };
  }
}
