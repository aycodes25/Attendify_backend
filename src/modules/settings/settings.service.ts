import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class SettingsService {
  constructor(private supabaseService: SupabaseService) {}

  async getSettings(key: string) {
    const { data, error } = await this.supabaseService.getClient()
      .from('settings')
      .select('*')
      .eq('key', key)
      .maybeSingle();

    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    return data ? data.value : null;
  }

  async updateSettings(key: string, value: any) {
    const client = this.supabaseService.getClient();

    const { data: existing } = await client
      .from('settings')
      .select('*')
      .eq('key', key)
      .maybeSingle();

    let query;
    if (existing) {
      query = client
        .from('settings')
        .update({ value, updated_at: new Date().toISOString() })
        .eq('key', key);
    } else {
      query = client
        .from('settings')
        .insert({ key, value });
    }

    const { data, error } = await query.select().single();

    if (error) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }

    return data.value;
  }

  async getAllSettings() {
    const { data, error } = await this.supabaseService.getClient()
      .from('settings')
      .select('*');

    if (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const settingsMap = {};
    for (const item of data || []) {
      settingsMap[item.key] = item.value;
    }
    return settingsMap;
  }
}
