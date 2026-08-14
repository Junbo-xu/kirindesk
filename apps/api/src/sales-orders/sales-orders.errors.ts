import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

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

/**
 * Thrown when a non-draft order would have no line items. Draft orders may have
 * zero lines (work in progress); confirmed/completed/cancelled orders created
 * or transitioned with an explicit empty item set are rejected (Phase 1F-A §6).
 */
export class OrderRequiresLineItemException extends BadRequestException {
  constructor() {
    super('A non-draft order must have at least one line item');
  }
}

export class PiBackedOrderImmutableException extends ConflictException {
  constructor() {
    super('A PI-backed order must be changed through its dedicated workflow');
  }
}

export class QuoteBackedOrderDeleteException extends ConflictException {
  constructor() {
    super('A quote-backed order cannot be deleted while its source link exists');
  }
}

export class FulfillmentLockedOrderImmutableException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      code: 'FULFILLMENT_LOCKED_ORDER_IMMUTABLE',
      message: 'A fulfillment-locked sales order can no longer be edited or deleted',
    });
  }
}
