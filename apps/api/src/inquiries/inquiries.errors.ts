import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

export class InquiryNotFoundException extends NotFoundException {
  constructor() {
    super('Inquiry not found');
  }
}

export class QuoteTaskNotFoundException extends NotFoundException {
  constructor() {
    super('Quote task not found');
  }
}

export class QuotationNotFoundException extends NotFoundException {
  constructor() {
    super('Quotation not found');
  }
}

export class InquiryStateConflictException extends ConflictException {
  constructor(message = 'Inquiry state does not allow this operation') {
    super(message);
  }
}

export class QuotationVersionConflictException extends ConflictException {
  constructor() {
    super('Quotation version changed; reload the current quotation and retry');
  }
}

export class InvalidInquiryDataException extends BadRequestException {
  constructor(message: string) {
    super(message);
  }
}

export class SanitizedOutputInvalidException extends BadRequestException {
  constructor(message = 'Sanitized quote task output is invalid') {
    super(message);
  }
}

export class QuotationAuditSequenceException extends InternalServerErrorException {
  constructor() {
    super('Quotation overwrite sequence is incomplete');
  }
}
