export class MemoryError extends Error {
  code: 'INVALID_INPUT' | 'CONFLICT' | 'NOT_FOUND';
  constructor(code: MemoryError['code'], message: string) {
    super(message); this.code = code;
  }
}
