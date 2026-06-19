import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseService } from '../../modules/supabase/supabase.service';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private supabaseService: SupabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.get<string[]>('roles', context.getHandler());
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      return false;
    }

    // 1. Retrieve role from Supabase Auth app_metadata
    let role = user.app_metadata?.role;

    // 2. Database query fallback
    if (!role) {
      const { data, error } = await this.supabaseService.getClient()
        .from('user_roles')
        .select(`
          roles (
            name
          )
        `)
        .eq('user_id', user.id)
        .single();

      if (!error && data?.roles) {
        role = (data.roles as any).name;
      }
    }

    if (!role || !requiredRoles.includes(role)) {
      throw new ForbiddenException(`Insufficient permissions. Required roles: ${requiredRoles.join(', ')}`);
    }

    // Attach role to request context for downstream controllers
    request.userRole = role;
    return true;
  }
}
