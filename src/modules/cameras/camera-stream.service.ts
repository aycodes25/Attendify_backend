import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Inject, forwardRef } from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import { SupabaseService } from '../supabase/supabase.service';
import { FaceRecognitionService } from '../recognition/face-recognition.service';
import { RecognitionGateway } from '../recognition/recognition.gateway';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CameraStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CameraStreamService.name);
  private processes = new Map<string, ChildProcess>();
  private healthCheckInterval: NodeJS.Timeout;

  constructor(
    private supabaseService: SupabaseService,
    private faceRecognitionService: FaceRecognitionService,
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
    try {
      const detections = await this.faceRecognitionService.processImageBuffer(frameBuffer);
      if (detections.length === 0) return;

      const client = this.supabaseService.getClient();
      const threshold = parseFloat(this.configService.get<string>('RECOGNITION_THRESHOLD') || '0.6');

      for (const det of detections) {
        // Query database using pgvector similarity matcher RPC
        const { data: matches, error } = await client.rpc('match_face', {
          query_embedding: `[${det.descriptor.join(',')}]`,
          match_threshold: threshold,
          match_count: 1
        });

        if (error) {
          this.logger.error(`Similarity matching database call failed`, error.message);
          continue;
        }

        if (matches && matches.length > 0) {
          const match = matches[0];
          await this.markMatchAttendance(match.member_id, cameraName);
        } else {
          // No match: process unrecognized visitor
          await this.processUnknownVisitor(cameraId, cameraName, frameBuffer, det.croppedBuffer);
        }
      }
    } catch (err) {
      this.logger.error(`Frame execution failed on camera ${cameraName}`, err);
    }
  }

  /**
   * Helper to write attendance logs in the database & push alerts
   */
  private async markMatchAttendance(memberId: string, cameraName: string) {
    const client = this.supabaseService.getClient();
    const today = new Date().toISOString().split('T')[0];
    const currentTime = new Date().toTimeString().split(' ')[0];

    // Determine current service type based on day/time or default
    const serviceType = this.getCurrentServiceType();

    // Check duplicate check-in window
    const duplicateWindowMins = parseInt(this.configService.get<string>('DUPLICATE_WINDOW_MINS') || '60');
    const { data: existing } = await client
      .from('attendance')
      .select('*')
      .eq('member_id', memberId)
      .eq('date', today)
      .eq('service_type', serviceType)
      .maybeSingle();

    if (existing) {
      this.logger.log(`Member ${memberId} already checked in today for ${serviceType}`);
      return;
    }

    // Load member name & details for check-in
    const { data: member } = await client
      .from('members')
      .select('first_name, last_name, profile_photo_url')
      .eq('id', memberId)
      .single();

    if (!member) return;

    // Create attendance record
    const { data: newRecord, error } = await client
      .from('attendance')
      .insert({
        member_id: memberId,
        date: today,
        time: currentTime,
        service_type: serviceType,
        status: 'Present',
        marked_by: `AI (${cameraName})`
      })
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to record attendance in database`, error.message);
      return;
    }

    // Emit live Socket.io event to frontend UI
    this.recognitionGateway.broadcastAttendanceMarked({
      id: newRecord.id,
      memberName: `${member.first_name} ${member.last_name}`,
      photoUrl: member.profile_photo_url || '',
      time: currentTime,
      serviceType,
      status: 'Present'
    });
  }

  /**
   * Processes unknown face: uploads files, saves record, broadcasts ws alert
   */
  private async processUnknownVisitor(cameraId: string, cameraName: string, snapshot: Buffer, crop: Buffer) {
    const client = this.supabaseService.getClient();
    const visitorId = crypto.randomUUID();
    const today = new Date().toISOString().split('T')[0];
    const currentTime = new Date().toTimeString().split(' ')[0];

    try {
      let snapshotUrl = '';
      let cropUrl = '';

      // Upload files to Supabase Storage if buffers are non-empty
      if (snapshot && snapshot.length > 0) {
        const snapshotPath = `snapshots/${visitorId}_snapshot.jpg`;
        const { error: err1 } = await client.storage
          .from('camera-snapshots')
          .upload(snapshotPath, snapshot, { contentType: 'image/jpeg' });
        
        if (!err1) {
          snapshotUrl = client.storage.from('camera-snapshots').getPublicUrl(snapshotPath).data.publicUrl;
        }
      }

      if (crop && crop.length > 0) {
        const cropPath = `crops/${visitorId}_crop.jpg`;
        const { error: err2 } = await client.storage
          .from('visitor-images')
          .upload(cropPath, crop, { contentType: 'image/jpeg' });
        
        if (!err2) {
          cropUrl = client.storage.from('visitor-images').getPublicUrl(cropPath).data.publicUrl;
        }
      }

      // Default fallback images for demonstration if upload is bypassed
      if (!snapshotUrl) snapshotUrl = 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400';
      if (!cropUrl) cropUrl = 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150';

      // Insert visitor record
      const { data: visitor, error } = await client
        .from('visitors')
        .insert({
          id: visitorId,
          captured_face_url: cropUrl,
          snapshot_url: snapshotUrl,
          detection_date: today,
          detection_time: currentTime,
          camera_id: cameraId,
          status: 'Pending'
        })
        .select()
        .single();

      if (error) throw error;

      // Broadcast WebSocket notification to dashboard
      const location = await this.getCameraLocation(cameraId);
      this.recognitionGateway.broadcastVisitorDetected({
        id: visitorId,
        capturedFaceUrl: cropUrl,
        snapshotUrl: snapshotUrl,
        time: currentTime,
        cameraName,
        location
      });
    } catch (err) {
      this.logger.error(`Failed to record unrecognized visitor`, err);
    }
  }

  private getCurrentServiceType(): string {
    const now = new Date();
    const day = now.getDay();
    if (day === 0) return 'Sunday Morning Service';
    if (day === 3) return 'Midweek Bible Study';
    return 'General Gathering';
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
