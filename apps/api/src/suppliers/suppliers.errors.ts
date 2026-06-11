import { NotFoundException } from '@nestjs/common';

/**
 * Thrown when a supplier is not visible to the caller: it does not exist,
 * was soft-deleted, or falls outside the caller's data scope (own/assigned).
 * We deliberately return 404 (not 403) for out-of-scope access so existence
 * is not disclosed to users who may only see their own suppliers.
 */
export class SupplierNotFoundException extends NotFoundException {
  constructor() {
    super('Supplier not found');
  }
}
