import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

export class CommercialResourceNotFoundException extends NotFoundException {
  constructor(message = 'Commercial workflow resource not found') {
    super(message);
  }
}

export class CommercialStateConflictException extends ConflictException {
  constructor(message: string, code = 'COMMERCIAL_STATE_CONFLICT') {
    super({ statusCode: 409, code, message });
  }
}

export class DuplicateCustomerException extends ConflictException {
  constructor(candidates: Array<{ id: string; company_name: string; email: string | null }>) {
    const response: {
      statusCode: number;
      code: string;
      message: string;
      candidates?: Array<{ id: string; company_name: string; email: string | null }>;
    } = {
      statusCode: 409,
      code: 'DUPLICATE_CUSTOMER',
      message:
        candidates.length > 0
          ? 'Potential duplicate customer found; link an existing customer or change the input'
          : 'Potential duplicate customer exists in this tenant; ask an administrator to resolve it or change the input',
    };
    if (candidates.length > 0) response.candidates = candidates;
    super(response);
  }
}

export class InvalidCommercialDataException extends BadRequestException {
  constructor(message: string, code = 'INVALID_COMMERCIAL_DATA') {
    super({ statusCode: 400, code, message });
  }
}

export class LowMarginApprovalRequiredException extends ConflictException {
  constructor(selectionIds: string[]) {
    super({
      statusCode: 409,
      code: 'LOW_MARGIN_APPROVAL_REQUIRED',
      message: 'Low-margin selections require an audited approval before PI issuance',
      selection_ids: selectionIds,
    });
  }
}

export class ReceiptProofRequiredException extends BadRequestException {
  constructor() {
    super({
      statusCode: 400,
      code: 'RECEIPT_PROOF_REQUIRED',
      message: 'Upload a receipt proof file and retry',
    });
  }
}

export class DuplicateReceiptException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'DUPLICATE_RECEIPT',
      message: 'A receipt with this PI, method, and external reference already exists',
    });
  }
}
