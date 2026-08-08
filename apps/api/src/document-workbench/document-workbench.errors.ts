import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

export class DocumentWorkbenchNotFoundException extends NotFoundException {
  constructor(resource: string) {
    super({
      statusCode: 404,
      code: 'DOCUMENT_WORKBENCH_NOT_FOUND',
      message: `${resource} not found`,
    });
  }
}

export class DocumentWorkbenchConflictException extends ConflictException {
  constructor(message: string, code = 'DOCUMENT_WORKBENCH_CONFLICT') {
    super({ statusCode: 409, code, message });
  }
}

export class InvalidDocumentWorkbenchDataException extends BadRequestException {
  constructor(message: string, code = 'INVALID_DOCUMENT_WORKBENCH_DATA') {
    super({ statusCode: 400, code, message });
  }
}
