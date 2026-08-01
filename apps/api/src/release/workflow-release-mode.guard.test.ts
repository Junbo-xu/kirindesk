import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { HttpException, NotFoundException } from '@nestjs/common';
import { WorkflowReleaseModeGuard, isWorkflowRoute } from './workflow-release-mode.guard';
import type {
  WorkflowReleaseMode,
  WorkflowReleaseModeService,
} from './workflow-release-mode.service';

function context(path: string, method: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ path, method }) }),
  } as unknown as ExecutionContext;
}

function guard(mode: WorkflowReleaseMode) {
  return new WorkflowReleaseModeGuard({ mode } as WorkflowReleaseModeService);
}

describe('WorkflowReleaseModeGuard', () => {
  it('recognizes workflow routes without capturing legacy order routes', () => {
    expect(isWorkflowRoute('/api/inquiries')).toBe(true);
    expect(isWorkflowRoute('/api/sales-orders/abc/shipments')).toBe(true);
    expect(isWorkflowRoute('/api/sales-orders')).toBe(false);
    expect(isWorkflowRoute('/api/customers')).toBe(false);
  });

  it('allows reads and rejects writes in read_only mode', () => {
    expect(guard('read_only').canActivate(context('/api/inquiries', 'GET'))).toBe(true);
    expect(() => guard('read_only').canActivate(context('/api/inquiries', 'POST'))).toThrow(
      HttpException,
    );
    try {
      guard('read_only').canActivate(context('/api/inquiries', 'POST'));
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(423);
    }
  });

  it('hides workflow reads while leaving core routes active', () => {
    expect(() => guard('hidden').canActivate(context('/api/inquiries', 'GET'))).toThrow(
      NotFoundException,
    );
    expect(guard('hidden').canActivate(context('/api/customers', 'POST'))).toBe(true);
  });
});
