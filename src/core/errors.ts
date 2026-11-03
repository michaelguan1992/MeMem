export class MemoryError extends Error {
  code: 'INVALID_INPUT' | 'CONFLICT' | 'NOT_FOUND';
  constructor(code: MemoryError['code'], message: string) {
    super(message); this.code = code;
  }
}
/** Rejects input that breaks a rule a schema cannot express, such as a limit reached or a range between two fields. */
export const invalid = (message: string): never => { throw new MemoryError('INVALID_INPUT', message); };
