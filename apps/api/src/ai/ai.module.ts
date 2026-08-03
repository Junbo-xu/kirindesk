import { Module, Global } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuthModule } from '../auth/auth.module';
import { OCR_PROVIDER } from './ocr-provider.interface';
import { AI_PROVIDER } from './ai-provider.interface';
import { MockOcrProvider } from './mock-ocr-provider';
import { MockAiProvider } from './mock-ai-provider';
import {
  resolveAiOcrProviderName,
  resolveAiTextProviderName,
  resolveDeepSeekConfig,
} from './ai.config';
import { DeepSeekAiProvider } from './deepseek-ai-provider';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';

/**
 * Wires the active OCR and AI providers behind their DI tokens (plan §3.6).
 * OCR remains local-only. Text AI may use the approved DeepSeek adapter, whose
 * endpoint/model/key/budget configuration is validated before construction.
 */
@Global()
@Module({
  imports: [AuditModule, RbacModule, AuthModule],
  controllers: [AiController],
  providers: [
    {
      provide: OCR_PROVIDER,
      useFactory: () => {
        // Resolve (and validate) the configured name; mock is the only binding
        // this phase exposes. Switching to a real provider is a deliberate,
        // approved code change here — never a silent config fallback.
        resolveAiOcrProviderName();
        return new MockOcrProvider();
      },
    },
    {
      provide: AI_PROVIDER,
      useFactory: () => {
        const provider = resolveAiTextProviderName();
        return provider === 'deepseek'
          ? new DeepSeekAiProvider(resolveDeepSeekConfig())
          : new MockAiProvider();
      },
    },
    AiService,
  ],
  exports: [OCR_PROVIDER, AI_PROVIDER, AiService],
})
export class AiModule {}
