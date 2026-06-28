import { Injectable } from '@nestjs/common';
import { EmailProvider, EmailMessage } from './email-provider.interface';

/**
 * Mock email provider for development and testing.
 * Calls are recorded in a static array for integration test assertions.
 */
@Injectable()
export class MockEmailProvider implements EmailProvider {
  static calls: EmailMessage[] = [];

  static reset(): void {
    MockEmailProvider.calls = [];
  }

  async send(message: EmailMessage): Promise<void> {
    if (message.subject === '__force_error__') {
      throw new Error('MockEmailProvider: forced error');
    }
    MockEmailProvider.calls.push(message);
  }
}
