import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';

/**
 * File (or its metadata) is not visible to the caller: does not exist, was
 * soft-deleted, or is outside the caller's data scope. 404 (not 403) so
 * existence is not disclosed to scope-limited callers.
 */
export class FileNotFoundException extends NotFoundException {
  constructor() {
    super('File not found');
  }
}

/** No file part was present in the multipart upload. */
export class NoFileUploadedException extends BadRequestException {
  constructor() {
    super('No file uploaded');
  }
}

/** Uploaded file's MIME type is not in the allowlist. */
export class UnsupportedFileTypeException extends BadRequestException {
  constructor(mime: string) {
    super(`Unsupported file type: ${mime}`);
  }
}

/** Uploaded file exceeds the configured size limit. */
export class FileTooLargeException extends PayloadTooLargeException {
  constructor(maxBytes: number) {
    super(`File exceeds the maximum size of ${maxBytes} bytes`);
  }
}

/**
 * Download token is missing, malformed, expired, already used, or revoked.
 * Single generic message so the failure mode is not disclosed to anonymous
 * callers of the public download endpoint.
 */
export class InvalidDownloadTokenException extends NotFoundException {
  constructor() {
    super('Invalid or expired download link');
  }
}

/** File cannot be deleted because an order (or other record) still references it. */
export class FileInUseException extends ConflictException {
  constructor() {
    super('File is referenced by another record and cannot be deleted');
  }
}
