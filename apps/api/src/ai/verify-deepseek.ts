import { createHash } from 'node:crypto';
import { DeepSeekAiProvider } from './deepseek-ai-provider';
import { resolveDeepSeekConfig } from './ai.config';

interface VerificationPayload {
  summary: string;
  items: unknown[];
}

async function main(): Promise<void> {
  const config = resolveDeepSeekConfig();
  const provider = new DeepSeekAiProvider(config);
  const startedAt = new Date();
  const result = await provider.complete({
    task: 'verify-synthetic-sanitization',
    dataClassification: 'synthetic_test',
    input: JSON.stringify({
      instruction: 'Return JSON with summary and items. Preserve synthetic item identifiers.',
      fixture: 'SYNTHETIC-KIR-6',
      items: [
        {
          inquiry_item_id: '00000000-0000-4000-8000-000000000001',
          description: 'Synthetic stainless steel bottle',
          specifications: 'Synthetic fixture, 750 ml, matte finish',
          quantity: '100.000',
          unit: 'pcs',
        },
      ],
    }),
    options: { timeoutMs: 15_000, maxOutputTokens: 512 },
  });

  const parsed = JSON.parse(result.output) as Partial<VerificationPayload>;
  if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.items)) {
    throw new Error('DeepSeek verification output failed the expected structured shape');
  }

  const evidence = {
    provider: result.provider,
    endpoint: config.apiUrl,
    model: config.model,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: result.durationMs,
    tokensUsed: result.tokensUsed,
    conservativeCostEstimateCny: result.costEstimateCny ?? null,
    budget: provider.budgetSnapshot(),
    responseLength: result.output.length,
    responseSha256: createHash('sha256').update(result.output).digest('hex'),
    dataClassification: 'synthetic_test',
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  const name = (error as { constructor?: { name?: string } })?.constructor?.name ?? 'Error';
  process.stderr.write(`DeepSeek verification failed: ${name}\n`);
  process.exitCode = 1;
});
