import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { MembersService } from '../members/members.service';

@Injectable()
export class VisitorsService {
  constructor(
    private supabaseService: SupabaseService,
    private membersService: MembersService,
  ) {}

  async findAll(filters: { status?: string; limit?: number; offset?: number }) {
    const client = this.supabaseService.getClient();
    let query = client
      .from('visitors')
      .select(`
        *,
        camera_streams (
          name,
          location
        )
      `, { count: 'exact' });

    if (filters.status) {
      query = query.eq('status', filters.status);
    }

    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    query = query.range(offset, offset + limit - 1).order('created_at', { ascending: false });

    const { data, count, error } = await query;
    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    return { visitors: data, totalCount: count };
  }

  async updateStatus(id: string, status: 'Pending' | 'Registered' | 'Ignored') {
    const { data, error } = await this.supabaseService.getClient()
      .from('visitors')
      .update({ status })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }

    return data;
  }

  /**
   * Promotes a visitor to a full registered member, copying their captured face photo
   */
  async promoteToMember(
    visitorId: string,
    memberData: {
      firstName: string;
      lastName: string;
      phoneNumber?: string;
      email?: string;
      gender: string;
      dateOfBirth?: string;
      department?: string;
    },
  ) {
    const client = this.supabaseService.getClient();

    // 1. Fetch visitor details
    const { data: visitor, error: fetchErr } = await client
      .from('visitors')
      .select('*')
      .eq('id', visitorId)
      .single();

    if (fetchErr || !visitor) {
      throw new HttpException('Visitor not found', HttpStatus.NOT_FOUND);
    }

    // 2. Create the member record
    const member = await this.membersService.create({
      ...memberData,
      profilePhotoUrl: visitor.captured_face_url,
      status: 'Active',
    });

    try {
      // 3. Download visitor image from storage to extract/copy the embedding
      // For simplicity, we can fetch the embedding array stored in visitors or recreate it,
      // but wait! The visitors table doesn't store the embedding directly, only the photo url.
      // However, we can fetch the image buffer using fetch or from Supabase storage and compute the embedding again!
      // This is extremely clean and works because we have the file url or file path.
      // Let's resolve the path from public URL:
      // visitor.captured_face_url is like "http://.../storage/v1/object/public/visitor-images/crops/uuid_crop.jpg"
      // The file path inside bucket 'visitor-images' is "crops/uuid_crop.jpg".
      // We can download it from Supabase storage directly!
      const cropPath = visitor.captured_face_url.split('/visitor-images/')[1];
      
      if (cropPath) {
        const { data: fileData, error: downloadErr } = await client.storage
          .from('visitor-images')
          .download(cropPath);

        if (!downloadErr && fileData) {
          const fileBuffer = Buffer.from(await fileData.arrayBuffer());
          
          // Register face image using the downloaded buffer
          await this.membersService.registerFaceImage(
            member.id,
            'front',
            fileBuffer,
            `${visitorId}_front.jpg`
          );
        }
      }
    } catch (err) {
      // Log error but do not crash member creation
      console.error('Failed to copy visitor face embedding to member faces', err);
    }

    // 4. Update visitor status to 'Registered'
    await this.updateStatus(visitorId, 'Registered');

    return member;
  }
}
