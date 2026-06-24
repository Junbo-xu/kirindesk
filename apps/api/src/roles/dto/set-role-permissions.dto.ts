import { ArrayUnique, IsArray, IsIn, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/** A single permission grant: which permission, at what data scope. */
export class PermissionGrantDto {
  @IsUUID('4')
  permissionId!: string;

  // data_scope sticks to the existing vocabulary (plan §2.1/§4.1) — no new
  // semantics. all ⊇ assigned ⊇ own; the subset guard enforces ⊆ caller's own.
  @IsIn(['all', 'assigned', 'own'])
  dataScope!: string;
}

/**
 * Body for PUT /api/roles/:id/permissions (plan §3.2). Full-replace semantics:
 * the given set becomes the role's complete permission set (the service
 * replaces all role_permissions rows in one transaction). An empty array clears
 * all permissions. ArrayUnique keys on permissionId to reject duplicate grants.
 */
export class SetRolePermissionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @ArrayUnique((g: PermissionGrantDto) => g.permissionId)
  @Type(() => PermissionGrantDto)
  permissions!: PermissionGrantDto[];
}
