import { AddressInfo } from 'node:net';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AiBudgetExceededException,
  AiProviderException,
  AiRateLimitException,
  AiResponseParseException,
  AiTimeoutException,
} from './ai.errors';
import { DeepSeekAiProvider } from './deepseek-ai-provider';
import type { DeepSeekConfig } from './ai.config';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

describe('DeepSeekAiProvider controlled upstream', () => {
  let server: Server;
  let endpoint: string;
  let handler: Handler;
  let requestCount: number;

  beforeEach(async () => {
    requestCount = 0;
    handler = (_request, response) => {
      response.statusCode = 500;
      response.end();
    };
    server = createServer((request, response) => {
      requestCount += 1;
      handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}/chat/completions`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function provider(overrides: Partial<DeepSeekConfig> = {}): DeepSeekAiProvider {
    return new DeepSeekAiProvider({
      apiUrl: endpoint,
      model: 'deepseek-chat',
      apiKey: 'unit-test-placeholder-not-a-key',
      budgetCny: 1,
      maxCalls: 5,
      ...overrides,
    });
  }

  function syntheticInput(timeoutMs = 1_000) {
    return {
      task: 'verify-synthetic-sanitization',
      input: JSON.stringify({ fixture: 'SYNTHETIC-KIR-6', items: [{ sku: 'TEST-001' }] }),
      dataClassification: 'synthetic_test' as const,
      options: { timeoutMs, maxOutputTokens: 256 },
    };
  }

  it('uses the official chat contract and returns structured content plus cost evidence', async () => {
    let authorization = '';
    let requestBody: Record<string, unknown> = {};
    handler = (request, response) => {
      authorization = request.headers.authorization ?? '';
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            choices: [{ message: { content: '{"summary":"synthetic ok","items":[]}' } }],
            usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
          }),
        );
      });
    };

    const adapter = provider();
    const result = await adapter.complete(syntheticInput());

    expect(authorization).toBe('Bearer unit-test-placeholder-not-a-key');
    expect(requestBody).toMatchObject({
      model: 'deepseek-chat',
      stream: false,
      response_format: { type: 'json_object' },
    });
    expect(result).toMatchObject({
      provider: 'deepseek',
      output: '{"summary":"synthetic ok","items":[]}',
      tokensUsed: 52,
      costEstimateCny: 0.0026,
    });
    expect(adapter.budgetSnapshot()).toMatchObject({ callsReserved: 1, capCny: 1 });
  });

  it('rejects business data before opening a network connection', async () => {
    await expect(
      provider().complete({ task: 'business', input: 'real customer text' }),
    ).rejects.toBeInstanceOf(AiProviderException);
    expect(requestCount).toBe(0);
  });

  it('maps a real aborted HTTP request to timeout', async () => {
    handler = (_request, response) => {
      setTimeout(() => response.end('{}'), 100);
    };
    await expect(provider().complete(syntheticInput(5))).rejects.toBeInstanceOf(AiTimeoutException);
  });

  it('maps HTTP 429 without parsing or exposing its response body', async () => {
    handler = (_request, response) => {
      response.statusCode = 429;
      response.end('{"error":{"message":"sensitive vendor detail"}}');
    };
    await expect(provider().complete(syntheticInput())).rejects.toBeInstanceOf(
      AiRateLimitException,
    );
  });

  it('keeps the timeout active while a response body is stalled', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.flushHeaders();
      setTimeout(() => response.end('{}'), 100);
    };
    await expect(provider().complete(syntheticInput(5))).rejects.toBeInstanceOf(AiTimeoutException);
  });

  it.each([
    ['non-JSON', 'not-json'],
    ['missing content', JSON.stringify({ choices: [{ message: {} }] })],
  ])('maps %s upstream output to a parse failure', async (_label, body) => {
    handler = (_request, response) => response.end(body);
    await expect(provider().complete(syntheticInput())).rejects.toBeInstanceOf(
      AiResponseParseException,
    );
  });

  it('maps non-429 upstream errors to a generic provider failure', async () => {
    handler = (_request, response) => {
      response.statusCode = 503;
      response.end('upstream secret detail');
    };
    await expect(provider().complete(syntheticInput())).rejects.toBeInstanceOf(AiProviderException);
  });

  it('stops before a second request when the approved call cap is exhausted', async () => {
    handler = (_request, response) => {
      response.end(
        JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: {} }),
      );
    };
    const adapter = provider({ maxCalls: 1 });
    await adapter.complete(syntheticInput());
    await expect(adapter.complete(syntheticInput())).rejects.toBeInstanceOf(
      AiBudgetExceededException,
    );
    expect(requestCount).toBe(1);
  });
});
