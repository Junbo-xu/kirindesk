import { SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY = 'required_permission';

export interface PermissionRequirement {
  resource: string;
  action: string;
}

export const RequirePermission = (resource: string, action: string) =>
  SetMetadata(PERMISSION_KEY, { resource, action } as PermissionRequirement);
