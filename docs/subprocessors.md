# Subprocessors

**Status: DRAFT — Phase 0**

## Purpose

List all third-party services that process customer data on behalf of KirinDesk, and define the notification and evaluation process for adding new subprocessors.

## 1. Current Status

Phase 0 local development has no production subprocessors.

Local development dependencies include self-hosted PostgreSQL and Redis containers. These run entirely on the developer's machine and do not transmit data externally.

## 2. Subprocessor List

| Name | Purpose | Data Types | Region | Status |
|------|---------|------------|--------|--------|
| (none) | — | — | — | No production subprocessors in Phase 0 |

This table will be populated when production infrastructure decisions are made.

## 3. Change Notification

When a new subprocessor is added:
- Customers will be notified in advance
- Notification will include: subprocessor name, purpose, data types processed, region
- Customers may raise objections within a defined period

## 4. Evaluation Criteria

Before adding a subprocessor, KirinDesk will evaluate:
- Security practices and certifications
- Data residency and jurisdiction
- Data processing agreement availability
- Incident response capabilities
- Ability to delete data on request

## Phase 0 Constraints

No production subprocessors exist. This document will be updated as infrastructure and third-party service decisions are made in later phases.

## Next Implementation Phases

- Pre-deployment: Select hosting provider, document as subprocessor
- Phase 1+: Payment provider, email service, file storage (if external)
- Future: AI/OCR providers (when integrated)

## Prohibited Claims

This document does not claim that any subprocessor has been audited or certified by KirinDesk. Each subprocessor's own certifications are their responsibility to maintain.
