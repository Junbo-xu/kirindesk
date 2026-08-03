import { ConflictException, NotFoundException } from '@nestjs/common';

export class BusinessExceptionNotFoundException extends NotFoundException {
  constructor() {
    super('Business exception not found');
  }
}

export class BusinessExceptionStateConflictException extends ConflictException {
  constructor(message = 'Business exception state or version changed') {
    super(message);
  }
}

export class BusinessExceptionAssigneeNotFoundException extends NotFoundException {
  constructor() {
    super('Assignee not found');
  }
}
