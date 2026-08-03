import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

export class FulfillmentNotFoundException extends NotFoundException {
  constructor(message = 'Fulfillment resource not found') {
    super(message);
  }
}

export class FulfillmentConflictException extends ConflictException {
  constructor(message: string, code = 'FULFILLMENT_STATE_CONFLICT') {
    super({ statusCode: 409, code, message });
  }
}

export class InvalidFulfillmentDataException extends BadRequestException {
  constructor(message: string, code = 'INVALID_FULFILLMENT_DATA') {
    super({ statusCode: 400, code, message });
  }
}

export class FulfillmentDutyException extends ForbiddenException {
  constructor(message: string, code = 'FULFILLMENT_DUTY_FORBIDDEN') {
    super({ statusCode: 403, code, message });
  }
}
