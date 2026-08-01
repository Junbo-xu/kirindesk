import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { WorkflowReleaseModeService } from './workflow-release-mode.service';

const WORKFLOW_ROUTE_PATTERNS = [
  /^\/api\/(?:inquiries|quote-tasks|quotations|quote-selections)(?:\/|$)/,
  /^\/api\/(?:proforma-invoices|customer-receipts|commercial-settings)(?:\/|$)/,
  /^\/api\/(?:procurement|procurement-requests)(?:\/|$)/,
  /^\/api\/(?:fulfillment|goods-receipts|shipments|order-expenses)(?:\/|$)/,
  /^\/api\/(?:finance|sample-orders|after-sales|after-sales-cases)(?:\/|$)/,
  /^\/api\/(?:workbench|business-events|business-exceptions)(?:\/|$)/,
  /^\/api\/sales-orders\/[^/]+\/(?:customer-receipts|procurement-gate|procurement-requests|fulfillment|shipments|expenses|after-sales-cases)(?:\/|$)/,
  /^\/api\/purchase-orders\/[^/]+\/(?:place|goods-receipts)(?:\/|$)/,
];

export function isWorkflowRoute(path: string): boolean {
  return WORKFLOW_ROUTE_PATTERNS.some((pattern) => pattern.test(path));
}

@Injectable()
export class WorkflowReleaseModeGuard implements CanActivate {
  constructor(private readonly releaseMode: WorkflowReleaseModeService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!isWorkflowRoute(request.path) || this.releaseMode.mode === 'active') {
      return true;
    }
    if (this.releaseMode.mode === 'hidden') {
      throw new NotFoundException('Workflow is not available');
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      return true;
    }
    throw new HttpException(
      {
        statusCode: 423,
        code: 'WORKFLOW_READ_ONLY',
        message: 'Workflow writes are temporarily disabled',
      },
      423,
    );
  }
}
