# Data Ownership Policy

**Status: DRAFT — Phase 0**

This document is a policy framework. It is not a legal contract and has not been reviewed by legal counsel.

## Purpose

Establish clear data ownership boundaries between KirinDesk (the platform) and its customers (tenants).

## 1. Definitions

- **Customer Data**: All business data created, uploaded, or imported by the customer, including but not limited to: customer records, orders, supplier information, pricing, commissions, internal documents, and communications.
- **Platform Data**: System configuration, feature flags, billing records, and platform operational logs.
- **Derived Data**: Aggregated, anonymized statistics generated from platform usage (not from customer business data).

## 2. Ownership Statement

Customer data belongs to the customer. The customer retains full ownership regardless of where the data is stored or processed.

## 3. Platform Usage Restrictions

KirinDesk shall NOT:
- Use customer business data for its own sales activities
- Resell or redistribute customer data to third parties
- Copy or replicate customer resources for other tenants
- Use customer data for public AI model training
- Share customer data with competitors or partners

## 4. Data Isolation

All SaaS tenant business tables carry a tenant_id. Future phases support dedicated database or private deployment for higher isolation requirements.

## 5. Exit and Deletion

Upon service termination, customers may:
- Request a full data export in standard formats
- Request permanent deletion of their data
- Receive confirmation of deletion completion

## Phase 0 Constraints

This is a policy declaration. Technical enforcement (tenant_id isolation, RLS, access controls) begins in Phase 0D and Phase 1+.

## Next Implementation Phases

- Phase 0D: Schema design with mandatory tenant_id
- Phase 1: RLS enforcement, data isolation verification
- Phase 2: Data export tooling
- Future: Deletion workflow, deletion certification

## Prohibited Claims

This document does not claim compliance with any standard. KirinDesk's data ownership practices are being built progressively and have not been independently audited.
