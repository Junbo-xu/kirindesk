import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

export class ProcurementResourceNotFoundException extends NotFoundException {
  constructor(message = 'Procurement workflow resource not found') {
    super(message);
  }
}

export class ProcurementConflictException extends ConflictException {
  constructor(message: string, code = 'PROCUREMENT_STATE_CONFLICT') {
    super({ statusCode: 409, code, message });
  }
}

export class InvalidProcurementDataException extends BadRequestException {
  constructor(message: string, code = 'INVALID_PROCUREMENT_DATA') {
    super({ statusCode: 400, code, message });
  }
}

export class ProcurementDutyException extends ForbiddenException {
  constructor(message: string, code = 'PROCUREMENT_DUTY_FORBIDDEN') {
    super({ statusCode: 403, code, message });
  }
}
