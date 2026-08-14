import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

export interface CustomsConsistencyIssue {
  code: string;
  field: string;
  line_no?: number;
  expected?: string;
  actual?: string;
}

export class CustomsDeclarationNotFoundException extends NotFoundException {
  constructor() {
    super({
      statusCode: 404,
      code: 'CUSTOMS_DECLARATION_NOT_FOUND',
      message: 'Customs declaration not found',
    });
  }
}

export class CustomsDeclarationConflictException extends ConflictException {
  constructor(message: string, code = 'CUSTOMS_DECLARATION_CONFLICT') {
    super({ statusCode: 409, code, message });
  }
}

export class CustomsSourceInconsistentException extends BadRequestException {
  constructor(missing: CustomsConsistencyIssue[], conflicts: CustomsConsistencyIssue[]) {
    super({
      statusCode: 400,
      code: 'CUSTOMS_SOURCE_INCONSISTENT',
      message: 'Order, commercial invoice, and packing list are not consistent',
      missing,
      conflicts,
    });
  }
}
