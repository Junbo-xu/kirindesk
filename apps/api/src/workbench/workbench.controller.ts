import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { BusinessEventsService } from './business-events.service';
import { BusinessExceptionsService, ExceptionActor } from './business-exceptions.service';
import {
  AssignBusinessExceptionDto,
  ResolveBusinessExceptionDto,
  VersionedExceptionActionDto,
} from './dto/business-exception-actions.dto';
import { ListBusinessEventsQuery } from './dto/list-business-events.query';
import { ListBusinessExceptionsQuery } from './dto/list-business-exceptions.query';
import { WorkbenchService } from './workbench.service';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class WorkbenchController {
  constructor(
    private readonly workbench: WorkbenchService,
    private readonly events: BusinessEventsService,
    private readonly exceptions: BusinessExceptionsService,
  ) {}

  private actor(user: TenantJwtUser, req: Request): ExceptionActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Get('workbench')
  @RequirePermission('workbench', 'view')
  getWorkbench(@CurrentUser() user: TenantJwtUser) {
    return this.workbench.get({ userId: user.sub, tenantId: user.tenantId });
  }

  @Get('business-events')
  @RequirePermission('business_events', 'view')
  listEvents(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: ListBusinessEventsQuery,
  ) {
    return this.events.list(this.actor(user, req), query);
  }

  @Get('business-exceptions')
  @RequirePermission('business_exceptions', 'view')
  listExceptions(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: ListBusinessExceptionsQuery,
  ) {
    return this.exceptions.list(this.actor(user, req), query);
  }

  @Get('business-exceptions/assignees')
  @RequirePermission('business_exceptions', 'assign')
  listAssignees(@CurrentUser() user: TenantJwtUser, @Req() req: Request) {
    return this.exceptions.listAssignees(this.actor(user, req));
  }

  @Get('business-exceptions/:id')
  @RequirePermission('business_exceptions', 'view')
  getException(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.exceptions.getOne(this.actor(user, req), id);
  }

  @Post('business-exceptions/:id/assign')
  @RequirePermission('business_exceptions', 'assign')
  assignException(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignBusinessExceptionDto,
  ) {
    return this.exceptions.assign(
      this.actor(user, req),
      id,
      dto.assigneeUserId,
      dto.expectedVersion,
    );
  }

  @Post('business-exceptions/:id/start')
  @RequirePermission('business_exceptions', 'resolve')
  startException(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VersionedExceptionActionDto,
  ) {
    return this.exceptions.start(this.actor(user, req), id, dto.expectedVersion);
  }

  @Post('business-exceptions/:id/resolve')
  @RequirePermission('business_exceptions', 'resolve')
  resolveException(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveBusinessExceptionDto,
  ) {
    return this.exceptions.resolve(this.actor(user, req), id, dto.resolution, dto.expectedVersion);
  }

  @Post('business-exceptions/:id/close')
  @RequirePermission('business_exceptions', 'close')
  closeException(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VersionedExceptionActionDto,
  ) {
    return this.exceptions.close(this.actor(user, req), id, dto.expectedVersion);
  }
}
