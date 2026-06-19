import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class RecognitionGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(RecognitionGateway.name);

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway initialized successfully');
  }

  handleConnection(client: Socket, ...args: any[]) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Broadcasts a real-time attendance confirmation event to all connected dashboard clients
   */
  broadcastAttendanceMarked(payload: {
    id: string;
    memberName: string;
    photoUrl: string;
    time: string;
    serviceType: string;
    status: string;
  }) {
    this.logger.log(`Broadcasting attendance check-in for member: ${payload.memberName}`);
    this.server.emit('attendance_marked', payload);
  }

  /**
   * Broadcasts a visitor detection event when an unknown face is processed
   */
  broadcastVisitorDetected(payload: {
    id: string;
    capturedFaceUrl: string;
    snapshotUrl: string;
    time: string;
    cameraName: string;
    location: string;
  }) {
    this.logger.log(`Broadcasting unknown visitor detection from camera: ${payload.cameraName}`);
    this.server.emit('visitor_detected', payload);
  }

  /**
   * Broadcasts CCTV health status toggles (Online, Offline, Warning)
   */
  broadcastCameraStatusChanged(payload: {
    cameraId: string;
    cameraName: string;
    status: string;
  }) {
    this.logger.log(`Broadcasting status change for camera ${payload.cameraName} to ${payload.status}`);
    this.server.emit('camera_status_changed', payload);
  }
}
