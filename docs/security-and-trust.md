# Security and Trust

**Status: DRAFT — Phase 0**

This document is a framework. It does not represent a completed security program or any certification.

## Purpose

Define KirinDesk's security and trust principles for customers who entrust their business data to the platform.

## 1. Data Ownership

Customer data belongs to the customer. KirinDesk does not use customer business data for its own sales, resale, resource copying, or public AI training.

## 2. Platform Access Control

Platform administrators cannot freely access tenant business data by default. Any support access requires customer authorization, stated reason, defined scope, time limit, and audit logging.

## 3. Audit and Traceability

All sensitive operations (data export, file download, platform access to tenant data) will be recorded in audit logs. Customers will be able to review access records.

## 4. Data Exit Mechanism

Customers may request data export and deletion upon service termination. The platform will provide a structured exit process.

## 5. Deployment Models and Trust Levels

Three trust tiers will be supported:
- Standard SaaS (shared infrastructure, tenant isolation via RLS)
- Dedicated database / dedicated storage
- Customer private deployment

## 6. Security Roadmap

Security is built incrementally by phase:
- Phase 0: Documentation framework and design principles
- Phase 0D: Database schema with tenant_id isolation
- Phase 1+: RLS, audit logging, file access control
- Future: Encryption at rest, compliance certification

## 7. Compliance Statement Guidelines

Permitted expressions:
- Controllable, auditable, exitable
- Supports private deployment
- Built progressively following mature security frameworks

Prohibited expressions:
- "Absolute security"
- "Bank-grade security"
- "Military-grade encryption"
- "ISO 27001 certified" (unless actually certified)
- "SOC 2 compliant" (unless actually audited)

## Phase 0 Constraints

This is a planning document. No technical security controls are implemented in Phase 0. Implementation begins in Phase 0D (schema design) and Phase 1+ (RLS, audit, access control).

## Next Implementation Phases

- Phase 0D: tenant_id on all business tables, schema design
- Phase 1: Row-Level Security, basic audit logging
- Phase 2: File access control, download authentication
- Phase 3: Support access workflow, customer-visible audit
- Future: Encryption, compliance certification
