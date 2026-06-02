import { NotFoundException } from '@nestjs/common';

/**
 * Thrown when a customer is not visible to the caller: it does not exist,
 * was soft-deleted, or falls outside the caller's data scope (own/assigned).
 * We deliberately return 404 (not 403) for out-of-scope access so existence
 * is not disclosed to users who may only see their own customers.
 */
export class CustomerNotFoundException extends NotFoundException {
  constructor() {
    super('Customer not found');
  }
}
