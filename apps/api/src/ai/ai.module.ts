import { Module, Global } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { OCR_PROVIDER } from './ocr-provider.interface';
import { AI_PROVIDER } from './ai-provider.interface';
import { MockOcrProvider } from './mock-ocr-provider';
import { MockAiProvider } from './mock-ai-provider';
import { resolveAiOcrProviderName } from './ai.config';
import { AiService } from './ai.service';

/**
 * Wires the active OCR and AI providers behind their DI tokens (plan §3.6).
 * The factories read AI_OCR_PROVIDER at startup; the only supported value is
 * `mock`, and resolveAiOcrProviderName throws on anything else, so a
 * misconfigured / unapproved vendor fails fast rather than starting on a real
 * backend (CLAUDE.md §7). Global so any module can inject the tokens without
 * re-importing.
 */
@Global()
@Module({
  imports: [AuditModule],
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
        resolveAiOcrProviderName();
        return new MockAiProvider();
      },
    },
    AiService,
  ],
  exports: [OCR_PROVIDER, AI_PROVIDER, AiService],
})
export class AiModule {}
