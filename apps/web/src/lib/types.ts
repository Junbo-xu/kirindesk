export interface MeResponse {
  id: string;
  email: string;
  tenantId: string;
}

export interface LoginResponse {
  accessToken: string;
}

// Normalized API error thrown by the client for non-2xx responses.
export class ApiError extends Error {
  status: number;
  // Field-level validation messages from the global ValidationPipe, when present.
  fields?: string[];

  constructor(status: number, message: string, fields?: string[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fields = fields;
  }
}
