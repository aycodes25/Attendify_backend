import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Inject, forwardRef } from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import { SupabaseService } from '../supabase/supabase.service';
import { RecognitionProcessingService } from '../recognition/recognition-processing.service';
import { RecognitionGateway } from '../recognition/recognition.gateway';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CameraStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CameraStreamService.name);
  private processes = new Map<string, ChildProcess>();
  private healthCheckInterval: NodeJS.Timeout;

  constructor(
    private supabaseService: SupabaseService,
    private recognitionProcessingService: RecognitionProcessingService,
    private recognitionGateway: RecognitionGateway,
    private configService: ConfigService,
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing Camera Stream Manager...');
    await this.startAllStreams();

    // Start health check daemon every 30 seconds
    this.healthCheckInterval = setInterval(() => this.runHealthChecks(), 30000);
  }

  onModuleDestroy() {
    this.logger.log('Stopping all active camera processes...');
    this.stopAllStreams();
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
  }

  /**
   * Loads all active cameras from Supabase and starts their ffmpeg feeds
   */
  async startAllStreams() {
    try {
      const { data: cameras, error } = await this.supabaseService
        .getClient()
        .from('camera_streams')
        .select('*');

      if (error) throw error;
      if (!cameras) return;

      for (const camera of cameras) {
        if (camera.status === 'Online') {
          await this.startCameraProcess(camera.id, camera.rtsp_url, camera.name);
        }
      }
    } catch (err) {
      this.logger.error('Failed to load camera streams from database', err.stack);
    }
  }

  stopAllStreams() {
    for (const [id, proc] of this.processes.entries()) {
      proc.kill();
      this.logger.log(`Stopped process for camera ID: ${id}`);
    }
    this.processes.clear();
  }

  /**
   * Spawns ffmpeg process to extract frames from RTSP stream
   */
  async startCameraProcess(id: string, rtspUrl: string, name: string) {
    if (this.processes.has(id)) {
      this.stopCameraProcess(id);
    }

    this.logger.log(`Starting stream client for camera: ${name} (${id})`);

    try {
      // Spawn ffmpeg command to dump JPEG frames to stdout at 1 frame per second
      const ffmpeg = spawn('ffmpeg', [
        '-rtsp_transport', 'tcp',
        '-i', rtspUrl,
        '-vf', 'fps=1',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-'
      ]);

      this.processes.set(id, ffmpeg);

      let buffer = Buffer.alloc(0);

      ffmpeg.stdout.on('data', async (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);

        // Find complete JPEG boundaries
        let soi = buffer.indexOf(Buffer.from([0xff, 0xd8]));
        while (soi !== -1) {
          const eoi = buffer.indexOf(Buffer.from([0xff, 0xd9]), soi);
          if (eoi === -1) break; // incomplete frame

          const frame = buffer.subarray(soi, eoi + 2);
          buffer = buffer.subarray(eoi + 2);

          // Process the single extracted frame buffer asynchronously
          this.processCameraFrame(id, name, frame);

          soi = buffer.indexOf(Buffer.from([0xff, 0xd8]));
        }
      });

      ffmpeg.stderr.on('data', (data) => {
        // ffmpeg logs go to stderr by default
        const log = data.toString();
        if (log.includes('Connection refused') || log.includes('timeout')) {
          this.updateCameraStatusInDb(id, 'Offline');
        }
      });

      ffmpeg.on('close', (code) => {
        this.logger.warn(`Camera process ${name} (${id}) closed with code ${code}`);
        this.processes.delete(id);
        this.updateCameraStatusInDb(id, 'Offline');
      });

      ffmpeg.on('error', (err: any) => {
        this.logger.error(`Error in camera process ${name}: ${err.message}`);
        // If ffmpeg is not installed on the system, run a mock frame processor
        if (err.code === 'ENOENT') {
          this.logger.warn(`FFmpeg is not installed. Spawning mock demo stream loop for ${name}`);
          this.startMockStreamLoop(id, name);
        } else {
          this.updateCameraStatusInDb(id, 'Offline');
        }
      });

      await this.updateCameraStatusInDb(id, 'Online');
    } catch (err) {
      this.logger.error(`Failed to spawn stream process for camera ${name}`, err);
      this.updateCameraStatusInDb(id, 'Offline');
    }
  }

  stopCameraProcess(id: string) {
    const proc = this.processes.get(id);
    if (proc) {
      proc.kill();
      this.processes.delete(id);
      this.updateCameraStatusInDb(id, 'Offline');
    }
  }

  /**
   * Processes a single camera frame buffer for face recognition
   */
  private async processCameraFrame(cameraId: string, cameraName: string, frameBuffer: Buffer) {
    await this.recognitionProcessingService.processFrame(cameraId, cameraName, frameBuffer);
  }

  private async getCameraLocation(cameraId: string): Promise<string> {
    const client = this.supabaseService.getClient();
    const { data } = await client.from('camera_streams').select('location').eq('id', cameraId).maybeSingle();
    return data?.location || 'Unknown Entrance';
  }

  private async updateCameraStatusInDb(id: string, status: string) {
    const client = this.supabaseService.getClient();
    const { data: camera } = await client
      .from('camera_streams')
      .update({ status, last_health_check: new Date().toISOString() })
      .eq('id', id)
      .select()
      .maybeSingle();

    if (camera) {
      this.recognitionGateway.broadcastCameraStatusChanged({
        cameraId: id,
        cameraName: camera.name,
        status
      });
    }
  }

  private async runHealthChecks() {
    const client = this.supabaseService.getClient();
    const { data: cameras } = await client.from('camera_streams').select('*');
    if (!cameras) return;

    for (const camera of cameras) {
      const isRunning = this.processes.has(camera.id);
      const targetStatus = isRunning ? 'Online' : 'Offline';
      if (camera.status !== targetStatus) {
        await this.updateCameraStatusInDb(camera.id, targetStatus);
      }
    }
  }

  /**
   * Spawns a background JS timeout loop that simulates incoming frames to verify dashboard behaviors when ffmpeg is missing.
   */
  private startMockStreamLoop(id: string, name: string) {
    const mockLoop = async () => {
      if (!this.processes.has(id)) {
        // Create a fake reference process to show it's active
        this.processes.set(id, { kill: () => {} } as any);
      }

      await this.processCameraFrame(id, name, Buffer.alloc(0));

      // Schedule next mock frame in 10-15 seconds
      const timeout = setTimeout(mockLoop, 10000 + Math.random() * 5000);
      this.processes.set(id, {
        kill: () => {
          clearTimeout(timeout);
          this.processes.delete(id);
          this.updateCameraStatusInDb(id, 'Offline');
        }
      } as any);
    };

    mockLoop();
  }
}
