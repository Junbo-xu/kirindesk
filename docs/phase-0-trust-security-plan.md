# Phase 0 Trust & Security Plan

**Status: DRAFT — Phase 0**

## Purpose

Define the overall trust and security roadmap for KirinDesk, establishing principles now and mapping technical implementation to future phases.

## 1. Current Phase Security Goals

Phase 0 establishes:
- Documentation framework and design principles
- Directory structure supporting future security features
- Commitment to tenant isolation (tenant_id on all business tables)
- No production deployment, no real customer data

## 2. Security Milestones by Phase

| Phase | Milestone |
|-------|-----------|
| Phase 0 | Trust documentation, project structure |
| Phase 0D | Schema design: tenants, users, roles, permissions, audit_logs with tenant_id |
| Phase 1 | Row-Level Security (RLS), basic audit logging, JWT authentication |
| Phase 2 | File access control, download authentication, export audit |
| Phase 3 | Support access workflow, customer-visible audit log |
| Phase 4 | Encryption at rest, key management |
| Future | Independent security audit, compliance certification |

## 3. Trust Levels

Three deployment models to serve different customer trust requirements:

**Level 1 — Standard SaaS**
- Shared infrastructure
- Tenant isolation via RLS and tenant_id
- Suitable for most customers

**Level 2 — Dedicated Database / Storage**
- Separate database instance per tenant
- Dedicated file storage
- For customers with higher data sensitivity

**Level 3 — Private Deployment**
- Customer-owned infrastructure
- Full data sovereignty
- For enterprise customers with strict compliance needs

## 4. Technical Implementation Roadmap

1. tenant_id on all business tables (Phase 0D)
2. Row-Level Security policies (Phase 1)
3. Audit logging for sensitive operations (Phase 1)
4. File storage with authentication (Phase 2)
5. Download and export audit trail (Phase 2)
6. Support access authorization workflow (Phase 3)
7. Customer-facing access log viewer (Phase 3)
8. Encryption at rest (Phase 4)
9. Compliance preparation (Future)

## 5. External Communication Guidelines

**Permitted:**
- Controllable, auditable, exitable
- Supports private deployment
- Built progressively following mature security frameworks
- Data belongs to the customer
- Transparent about current capabilities

**Prohibited:**
- "Absolute security"
- "Bank-grade security" / "Military-grade encryption"
- "ISO 27001 certified" (unless certified)
- "SOC 2 compliant" (unless audited)
- "GDPR compliant" (unless verified by legal counsel)
- Any claim of certification not yet obtained

## Phase 0 Constraints

No security controls are technically enforced in Phase 0. This document is a planning artifact that guides future implementation.

## Next Steps

Phase 0D — Database Foundation Plan: design schemas for tenants, users, roles, permissions, tenant_modules, audit_logs, files, provider_invocations, and RLS policies. Planning first, implementation after approval.
