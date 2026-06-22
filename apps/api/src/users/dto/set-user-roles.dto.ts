import { ArrayUnique, IsArray, IsUUID } from 'class-validator';

/**
 * Body for PUT /api/users/:id/roles (plan §3.1). Full-replace semantics: the
 * given set becomes the user's complete role set (the service replaces all
 * user_roles rows in one transaction). An empty array clears all roles.
 */
export class SetUserRolesDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  roleIds!: string[];
}
