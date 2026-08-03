import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

export class InvalidSampleAfterSalesDataException extends BadRequestException {
  constructor(message: string, code = 'INVALID_SAMPLE_AFTER_SALES_DATA') {
    super({ statusCode: 400, code, message });
  }
}

export class SampleAfterSalesConflictException extends ConflictException {
  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super({ statusCode: 409, code, message, ...(details ?? {}) });
  }
}

export class SampleAfterSalesNotFoundException extends NotFoundException {
  constructor(message: string) {
    super({ statusCode: 404, code: 'SAMPLE_AFTER_SALES_NOT_FOUND', message });
  }
}

export class SampleAfterSalesDutyException extends ForbiddenException {
  constructor(message: string, code: string) {
    super({ statusCode: 403, code, message });
  }
}
