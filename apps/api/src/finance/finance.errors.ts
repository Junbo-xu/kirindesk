import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

export class FinanceNotFoundException extends NotFoundException {
  constructor(message = 'Finance resource not found') {
    super(message);
  }
}

export class FinanceConflictException extends ConflictException {
  constructor(message: string, code = 'FINANCE_STATE_CONFLICT', details?: Record<string, unknown>) {
    super({ statusCode: 409, code, message, ...(details ?? {}) });
  }
}

export class InvalidFinanceDataException extends BadRequestException {
  constructor(message: string, code = 'INVALID_FINANCE_DATA') {
    super({ statusCode: 400, code, message });
  }
}

export class FinanceDutyException extends ForbiddenException {
  constructor(message: string, code = 'FINANCE_DUTY_FORBIDDEN') {
    super({ statusCode: 403, code, message });
  }
}
