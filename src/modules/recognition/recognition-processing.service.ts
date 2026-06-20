import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { FaceRecognitionService } from './face-recognition.service';
import { RecognitionGateway } from './recognition.gateway';
import * as crypto from 'crypto';

@Injectable()
export class RecognitionProcessingService {
  private readonly logger = new Logger(RecognitionProcessingService.name);

  constructor(
    private supabaseService: SupabaseService,
    private faceRecognitionService: FaceRecognitionService,
    private recognitionGateway: RecognitionGateway,
    private configService: ConfigService,
  ) {}

  /**
   * Processes a kiosk frame — tries face recognition first,
   * but ALWAYS saves the snapshot as a visitor if no known member is matched.
   * This guarantees every kiosk capture appears in the Pending visitors tab.
   */
  async processKioskFrame(cameraName: string, frameBuffer: Buffer): Promise<{ matched: boolean; memberId?: string; alreadyMarked?: boolean }> {
    this.logger.log(`Kiosk frame received. Buffer size: ${frameBuffer.length}`);
    try {
      const detections = await this.faceRecognitionService.processImageBuffer(frameBuffer);
      this.logger.log(`Kiosk face detections: ${detections.length}`);

      if (detections.length > 0) {
        const client = this.supabaseService.getClient();
        const threshold = parseFloat(this.configService.get<string>('RECOGNITION_THRESHOLD') || '0.6');

        for (const det of detections) {
          const { data: matches, error } = await client.rpc('match_face', {
            query_embedding: `[${det.descriptor.join(',')}]`,
            match_threshold: threshold,
            match_count: 1,
          });

          if (!error && matches && matches.length > 0) {
            // Known member — mark attendance
            const isAlreadyMarked = await this.markMatchAttendance(matches[0].member_id, cameraName);
            return { matched: true, memberId: matches[0].member_id, alreadyMarked: isAlreadyMarked };
          } else {
            // Detected face but not in database — save as visitor with crop
            await this.processUnknownVisitor(null, cameraName, frameBuffer, det.croppedBuffer);
            return { matched: false, alreadyMarked: false };
          }
        }
      }

      // No face detected at all — still save the raw snapshot so nothing is lost
      this.logger.warn(`No face detected by face-api; saving raw snapshot as visitor.`);
      await this.processUnknownVisitor(null, cameraName, frameBuffer, frameBuffer);
      return { matched: false };
    } catch (err) {
      this.logger.error(`Kiosk frame processing failed`, err);
      // Even on error try to save snapshot
      try {
        await this.processUnknownVisitor(null, cameraName, frameBuffer, frameBuffer);
      } catch (_) {}
      return { matched: false };
    }
  }

  /**
   * Processes a single image frame buffer for face recognition.
   * Used by CCTV streams (ffmpeg). Does NOT force-save.
   */
  async processFrame(cameraId: string | null, cameraName: string, frameBuffer: Buffer) {
    try {
      const detections = await this.faceRecognitionService.processImageBuffer(frameBuffer);
      if (detections.length === 0) return;

      const client = this.supabaseService.getClient();
      const threshold = parseFloat(this.configService.get<string>('RECOGNITION_THRESHOLD') || '0.6');

      for (const det of detections) {
        const { data: matches, error } = await client.rpc('match_face', {
          query_embedding: `[${det.descriptor.join(',')}]`,
          match_threshold: threshold,
          match_count: 1,
        });

        if (error) {
          this.logger.error(`Similarity matching database call failed`, error.message);
          continue;
        }

        if (matches && matches.length > 0) {
          await this.markMatchAttendance(matches[0].member_id, cameraName);
        } else {
          await this.processUnknownVisitor(cameraId, cameraName, frameBuffer, det.croppedBuffer);
        }
      }
    } catch (err) {
      this.logger.error(`Frame execution failed on source ${cameraName}`, err);
    }
  }

  /**
   * Helper to write attendance logs in the database & push alerts
   */
  private async markMatchAttendance(memberId: string, cameraName: string) {
    const client = this.supabaseService.getClient();
    const now = new Date();
    // Use local time for logic (important for correct day mapping)
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().split('T')[0];
    const currentTime = now.toTimeString().split(' ')[0];

    const activeService = this.getActiveServiceDetails(now);
    const serviceType = activeService.name;

    // Load member name & details early so we can broadcast errors
    const { data: member } = await client
      .from('members')
      .select('first_name, last_name, profile_photo_url')
      .eq('id', memberId)
      .single();

    if (!member) return false;

    // Check duplicate check-in window (already marked for this service today)
    const { data: existing } = await client
      .from('attendance')
      .select('*')
      .eq('member_id', memberId)
      .eq('date', today)
      .eq('service_type', serviceType)
      .maybeSingle();

    if (existing) {
      this.logger.log(`Member ${memberId} already checked in today for ${serviceType}`);
      // Emit live WebSocket event so the kiosk UI shows "Already Marked"
      this.recognitionGateway.server.emit('visitor_detected', {
        id: crypto.randomUUID(),
        alreadyMarked: true,
        memberName: `${member.first_name} ${member.last_name}`,
        serviceType,
        time: currentTime
      });
      return true;
    }

    // Calculate punctuality
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const startMins = activeService.startTimeHour * 60 + activeService.startTimeMinute;
    const minutes_difference = currentMins - startMins; // Negative = early, positive = late
    
    let punctuality_status = 'On Time';
    if (minutes_difference < -15) punctuality_status = 'Early';
    else if (minutes_difference > 15) punctuality_status = 'Late';

    // Create attendance record
    const { data: newRecord, error } = await client
      .from('attendance')
      .insert({
        member_id: memberId,
        date: today,
        time: currentTime,
        service_type: serviceType,
        status: 'Present',
        marked_by: `AI (${cameraName})`,
        punctuality_status,
        minutes_difference,
      })
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to record attendance in database`, error.message);
      return false;
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
    return false; // not "already marked", it was a fresh mark!
  }

  /**
   * Processes unknown face: uploads files, saves record, broadcasts ws alert
   */
  private async processUnknownVisitor(cameraId: string | null, cameraName: string, snapshot: Buffer, crop: Buffer) {
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
      const insertPayload: any = {
        id: visitorId,
        captured_face_url: cropUrl,
        snapshot_url: snapshotUrl,
        detection_date: today,
        detection_time: currentTime,
        status: 'Pending'
      };
      
      if (cameraId) {
        insertPayload.camera_id = cameraId;
      }

      const { data: visitor, error } = await client
        .from('visitors')
        .insert(insertPayload)
        .select()
        .single();

      if (error) {
        this.logger.error(`Visitor insert error: ${JSON.stringify(error)}`);
        throw error;
      }
      this.logger.log(`Visitor saved to database: ${visitor.id}`);

      // Broadcast WebSocket notification to dashboard
      const location = cameraId ? await this.getCameraLocation(cameraId) : 'Live Kiosk';
      this.recognitionGateway.broadcastVisitorDetected({
        id: visitorId,
        capturedFaceUrl: cropUrl,
        snapshotUrl: snapshotUrl,
        time: currentTime,
        cameraName,
        location
      });
    } catch (err) {
      this.logger.error(`Failed to record unrecognized visitor: ${err?.message || err}`);
    }
  }

  private getActiveServiceDetails(now: Date): { name: string, startTimeHour: number, startTimeMinute: number } {
    const day = now.getDay();
    const hour = now.getHours();
    const mins = now.getMinutes();
    const currentMins = hour * 60 + mins;

    if (day === 0) { // Sunday
      if (currentMins >= 6 * 60 && currentMins < 10 * 60) return { name: 'Sunday First Service', startTimeHour: 8, startTimeMinute: 0 };
      if (currentMins >= 10 * 60 && currentMins <= 14 * 60) return { name: 'Sunday Second Service', startTimeHour: 10, startTimeMinute: 0 };
    } else if (day === 2) { // Tuesday
      if (currentMins >= 7 * 60 && currentMins <= 14 * 60) return { name: 'Breakthrough Service', startTimeHour: 9, startTimeMinute: 0 };
    } else if (day === 4) { // Thursday
      if (currentMins >= 15 * 60 && currentMins <= 21 * 60) return { name: 'Empowerment Service', startTimeHour: 17, startTimeMinute: 30 };
    } else if (day === 6) { // Saturday
      if (currentMins >= 7 * 60 && currentMins <= 13 * 60) return { name: 'Fire Service', startTimeHour: 9, startTimeMinute: 0 };
    }
    
    // Fallback if checked in outside normal hours (e.g., testing or special event)
    return { name: 'General Gathering / Testing', startTimeHour: hour, startTimeMinute: 0 };
  }

  private async getCameraLocation(cameraId: string): Promise<string> {
    const client = this.supabaseService.getClient();
    const { data } = await client.from('camera_streams').select('location').eq('id', cameraId).maybeSingle();
    return data?.location || 'Unknown Location';
  }
}
