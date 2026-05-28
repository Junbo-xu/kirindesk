# Data Processing Agreement

**Status: DRAFT — Phase 0**

This document is a structural framework. It is not a binding agreement and has not been reviewed by legal counsel. It must not be presented to customers as a finalized DPA.

## Purpose

Define the data processing relationship between KirinDesk (Processor) and its customers (Controllers).

## 1. Definitions and Roles

- **Controller**: The customer who determines the purposes and means of processing personal data.
- **Processor**: KirinDesk, which processes data on behalf of the Controller.
- **Data Subject**: Individuals whose personal data is processed (customer's end users, contacts, employees).

## 2. Processing Scope and Purpose

- Processing is limited to providing the KirinDesk service
- Data types: business contacts, orders, supplier records, internal documents
- Processing activities: storage, retrieval, display, search, export

## 3. Security Measures

- Tenant isolation via database-level controls
- Access authentication and authorization
- Audit logging of sensitive operations
- Encryption in transit
- Regular security reviews (planned)

## 4. Sub-processor Management

- Current sub-processors listed in subprocessors.md
- Customers will be notified before adding new sub-processors
- Sub-processors must meet equivalent security standards

## 5. Data Breach Notification

- Platform will notify affected customers within 72 hours of confirming a breach
- Notification includes: nature of breach, data affected, remediation steps
- Cooperation with customer's regulatory obligations

## 6. Audit Rights

- Customers may request evidence of security controls
- Platform will provide compliance documentation upon request
- On-site audits by arrangement for enterprise customers

## 7. Data Handling After Termination

- Customer may request data export before account closure
- Data retained for 30 days after termination for export purposes
- Permanent deletion upon request or after retention period
- Deletion confirmation provided

## Phase 0 Constraints

This is a structural draft. No DPA mechanisms are technically enforced in Phase 0. Implementation begins with Phase 0D (schema design) and Phase 1+ (access controls, audit).

## Next Implementation Phases

- Phase 0D: Schema with tenant isolation
- Phase 1: Access controls, basic audit logging
- Phase 2: Data export, breach notification workflow
- Phase 3: Deletion certification, audit evidence generation
- Future: Legal review, customer-facing DPA signing workflow

## Prohibited Claims

This document does not constitute a binding DPA. It must not be presented as evidence of compliance with GDPR Article 28 or any other regulation until reviewed and signed by both parties with legal counsel.
