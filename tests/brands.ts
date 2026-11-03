// Test-only fixtures. Branded values are built through the same schemas the product uses, so no test fakes a brand with a cast.
import { instantSchema, mediaIdSchema, memoryIdSchema, parse, sha256Schema, versionSchema } from '../src/core/schema.ts';

export const memoryIdOf = (value: string) => parse(memoryIdSchema, value);
export const mediaIdOf = (value: string) => parse(mediaIdSchema, value);
export const sha256Of = (hex: string) => parse(sha256Schema, hex);
export const versionOf = (value: number) => parse(versionSchema, value);
export const instantOf = (value: string) => parse(instantSchema, value);
