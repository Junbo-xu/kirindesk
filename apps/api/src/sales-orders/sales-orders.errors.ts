import { ConflictException, NotFoundException } from '@nestjs/common';

/**
 * Thrown when a sales order is not visible to the caller: it does not exist,
 * was soft-deleted, or falls outside the caller's data scope (own/assigned).
 * Returns 404 (not 403) so existence is not disclosed to users who may only
 * see their own orders.
 */
export class SalesOrderNotFoundException extends NotFoundException {
  constructor() {
    super('Sales order not found');
  }
}

/**
 * Thrown at create time when the referenced customer does not exist, was
 * soft-deleted, is in another tenant, or is outside the caller's data scope.
 * Returns 404 (same message shape) so customer existence is not disclosed.
 */
export class OrderCustomerNotFoundException extends NotFoundException {
  constructor() {
    super('Customer not found');
  }
}

/**
 * Thrown when order_number collides with an existing order in the same tenant
 * (unique constraint uq_sales_orders_tenant_order_number).
 */
export class DuplicateOrderNumberException extends ConflictException {
  constructor() {
    super('Order number already exists');
  }
}
