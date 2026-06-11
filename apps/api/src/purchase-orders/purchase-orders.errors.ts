import { ConflictException, NotFoundException } from '@nestjs/common';

/**
 * Thrown when a purchase order is not visible to the caller: it does not exist,
 * was soft-deleted, or falls outside the caller's data scope (own/assigned).
 * Returns 404 (not 403) so existence is not disclosed to users who may only
 * see their own orders.
 */
export class PurchaseOrderNotFoundException extends NotFoundException {
  constructor() {
    super('Purchase order not found');
  }
}

/**
 * Thrown at create time when the referenced supplier does not exist, was
 * soft-deleted, is in another tenant, or is outside the caller's data scope.
 * Returns 404 (same message shape) so supplier existence is not disclosed.
 */
export class OrderSupplierNotFoundException extends NotFoundException {
  constructor() {
    super('Supplier not found');
  }
}

/**
 * Thrown when order_number collides with an existing order in the same tenant
 * (unique constraint uq_purchase_orders_tenant_order_number).
 */
export class DuplicateOrderNumberException extends ConflictException {
  constructor() {
    super('Order number already exists');
  }
}
