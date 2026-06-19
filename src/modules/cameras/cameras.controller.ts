import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, HttpException, HttpStatus } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { SupabaseService } from '../supabase/supabase.service';
import { CameraStreamService } from './camera-stream.service';

@Controller('cameras')
@UseGuards(AuthGuard, RolesGuard)
export class CamerasController {
  constructor(
    private supabaseService: SupabaseService,
    private cameraStreamService: CameraStreamService,
  ) {}

  @Get()
  @Roles('Super Admin', 'Church Admin', 'Attendance Officer', 'Pastor', 'Viewer')
  async getAllCameras() {
    const { data, error } = await this.supabaseService.getClient()
      .from('camera_streams')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return data;
  }

  @Post()
  @Roles('Super Admin', 'Church Admin')
  async createCamera(@Body() body: { name: string; location: string; rtspUrl: string }) {
    if (!body.name || !body.location || !body.rtspUrl) {
      throw new HttpException('Missing name, location, or RTSP URL', HttpStatus.BAD_REQUEST);
    }

    const { data, error } = await this.supabaseService.getClient()
      .from('camera_streams')
      .insert({
        name: body.name,
        location: body.location,
        rtsp_url: body.rtspUrl,
        status: 'Offline',
      })
      .select()
      .single();

    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Automatically trigger ffmpeg stream runner
    await this.cameraStreamService.startCameraProcess(data.id, data.rtsp_url, data.name);
    return data;
  }

  @Put(':id')
  @Roles('Super Admin', 'Church Admin')
  async updateCamera(
    @Param('id') id: string,
    @Body() body: { name?: string; location?: string; rtspUrl?: string; status?: string },
  ) {
    const client = this.supabaseService.getClient();

    const { data: current, error: fetchErr } = await client
      .from('camera_streams')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !current) {
      throw new HttpException('Camera not found', HttpStatus.NOT_FOUND);
    }

    const updateData: any = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.location !== undefined) updateData.location = body.location;
    if (body.rtspUrl !== undefined) updateData.rtsp_url = body.rtspUrl;
    if (body.status !== undefined) updateData.status = body.status;

    const { data, error } = await client
      .from('camera_streams')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Restart process if RTSP URL was updated or stream was toggled back Online
    if (body.rtspUrl !== undefined || body.status === 'Online') {
      this.cameraStreamService.stopCameraProcess(id);
      if (data.status === 'Online' || body.status === 'Online') {
        await this.cameraStreamService.startCameraProcess(data.id, data.rtsp_url, data.name);
      }
    } else if (body.status === 'Offline') {
      this.cameraStreamService.stopCameraProcess(id);
    }

    return data;
  }

  @Delete(':id')
  @Roles('Super Admin', 'Church Admin')
  async deleteCamera(@Param('id') id: string) {
    // Stop background process first
    this.cameraStreamService.stopCameraProcess(id);

    const { data, error } = await this.supabaseService.getClient()
      .from('camera_streams')
      .delete()
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    return { message: 'Camera deleted successfully', id };
  }

  @Post(':id/restart')
  @Roles('Super Admin', 'Church Admin')
  async restartCamera(@Param('id') id: string) {
    const { data, error } = await this.supabaseService.getClient()
      .from('camera_streams')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new HttpException('Camera not found', HttpStatus.NOT_FOUND);
    }

    this.cameraStreamService.stopCameraProcess(id);
    await this.cameraStreamService.startCameraProcess(data.id, data.rtsp_url, data.name);

    return { message: 'Camera stream process restarted', camera: data };
  }
}
