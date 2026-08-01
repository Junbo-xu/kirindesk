import { Injectable } from '@nestjs/common';

export type WorkflowReleaseMode = 'active' | 'read_only' | 'hidden';

const MODES = new Set<WorkflowReleaseMode>(['active', 'read_only', 'hidden']);

@Injectable()
export class WorkflowReleaseModeService {
  readonly mode: WorkflowReleaseMode;

  constructor() {
    const configured = process.env.WORKFLOW_RELEASE_MODE ?? 'active';
    if (!MODES.has(configured as WorkflowReleaseMode)) {
      throw new Error(
        `Invalid WORKFLOW_RELEASE_MODE "${configured}". Expected active, read_only, or hidden.`,
      );
    }
    this.mode = configured as WorkflowReleaseMode;
  }
}
