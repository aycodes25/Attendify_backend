import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UploadedFile,
  UseInterceptors,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { MembersService } from './members.service';

@Controller('members')
@UseGuards(AuthGuard, RolesGuard)
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Get()
  @Roles('Super Admin', 'Church Admin', 'Attendance Officer', 'Pastor', 'Viewer')
  async getMembers(
    @Query('search') search?: string,
    @Query('department') department?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.membersService.findAll({
      search,
      department,
      status,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined,
    });
  }

  @Get(':id')
  @Roles('Super Admin', 'Church Admin', 'Attendance Officer', 'Pastor', 'Viewer')
  async getMember(@Param('id') id: string) {
    return this.membersService.findOne(id);
  }

  @Post()
  @Roles('Super Admin', 'Church Admin', 'Attendance Officer')
  async createMember(
    @Body()
    body: {
      firstName: string;
      lastName: string;
      phoneNumber?: string;
      email?: string;
      gender: string;
      dateOfBirth?: string;
      department?: string;
      status?: string;
      profilePhotoUrl?: string;
    },
  ) {
    if (!body.firstName || !body.lastName || !body.gender) {
      throw new HttpException('First name, last name, and gender are required', HttpStatus.BAD_REQUEST);
    }
    return this.membersService.create(body);
  }

  @Put(':id')
  @Roles('Super Admin', 'Church Admin', 'Attendance Officer')
  async updateMember(
    @Param('id') id: string,
    @Body()
    body: {
      firstName?: string;
      lastName?: string;
      phoneNumber?: string;
      email?: string;
      gender?: string;
      dateOfBirth?: string;
      department?: string;
      status?: string;
      profilePhotoUrl?: string;
    },
  ) {
    return this.membersService.update(id, body);
  }

  @Delete(':id')
  @Roles('Super Admin', 'Church Admin')
  async deleteMember(@Param('id') id: string) {
    return this.membersService.remove(id);
  }

  @Post(':id/faces')
  @Roles('Super Admin', 'Church Admin', 'Attendance Officer')
  @UseInterceptors(FileInterceptor('photo'))
  async uploadFace(
    @Param('id') id: string,
    @Body('faceType') faceType: 'front' | 'left' | 'right',
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new HttpException('Image photo file is required', HttpStatus.BAD_REQUEST);
    }
    if (!faceType || !['front', 'left', 'right'].includes(faceType)) {
      throw new HttpException('Valid faceType (front, left, right) is required', HttpStatus.BAD_REQUEST);
    }

    return this.membersService.registerFaceImage(id, faceType, file.buffer, file.originalname);
  }
}
