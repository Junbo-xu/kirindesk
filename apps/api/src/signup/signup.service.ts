import { Injectable } from '@nestjs/common';
import {
  TenantOnboardingResult,
  TenantOnboardingService,
} from '../platform-tenants/tenant-onboarding.service';
import { CreateTenantDto } from '../platform-tenants/dto/create-tenant.dto';
import { SignupDto } from './dto/signup.dto';

// free plan (db/seeds/003_plans.sql). New self-signup tenants bind here by
// default (approved scope). Bare constant — no env, no fallback to a paid tier.
const FREE_PLAN_ID = 'b0000000-0000-0000-0000-000000000001';

/**
 * Phase 2B: self-service registration. Thin wrapper over the existing atomic
 * TenantOnboardingService.provision() — reuses the exact same one-transaction
 * tenant + owner + audit-chain-genesis + quota + notification-settings path,
 * so signup is audit-ready and quota-tracked from its first event. The only
 * differences vs platform provisioning: bind the free plan, mark created_via,
 * and attribute the tenant.created audit event to the new owner (no platform
 * admin is involved).
 */
@Injectable()
export class SignupService {
  constructor(private readonly onboarding: TenantOnboardingService) {}

  async register(dto: SignupDto): Promise<TenantOnboardingResult> {
    const onboardingDto: CreateTenantDto = {
      name: dto.tenantName,
      slug: dto.slug,
      ownerEmail: dto.ownerEmail,
      ownerPassword: dto.ownerPassword,
      ownerName: dto.ownerName,
      contactEmail: dto.ownerEmail,
      contactPhone: dto.contactPhone,
    };

    // adminId is unused on this path (auditAsOwner attributes to the new
    // owner, whose id is known only after the INSERT). Pass empty string.
    return this.onboarding.provision('', onboardingDto, {
      planId: FREE_PLAN_ID,
      createdVia: 'self_signup',
      auditActorType: 'tenant_user',
      auditAsOwner: true,
    });
  }
}
