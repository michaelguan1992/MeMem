import { getOAuthProtectedResourceMetadataUrl, Server, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Memory } from '../core/contracts.ts';
import { MemoryError } from '../core/errors.ts';
import { DEFAULT_PAGE_LIMIT, memoryFields, memoryIdSchema, memoryQueryFields, versionSchema } from '../core/schema.ts';
import { currentMemory, type createMemoryService } from '../core/service.ts';

export const MEMORY_READ_SCOPE = 'memory:read';
export const MEMORY_WRITE_SCOPE = 'memory:write';

// Tool inputs are the core field schemas, strict so that an unknown key (such as an owner) is refused.
const recordSchema = z.strictObject(memoryFields);
const searchSchema = z.strictObject(memoryQueryFields);
const getSchema = z.strictObject({ id: memoryIdSchema });
const correctSchema = z.strictObject({ id: memoryIdSchema, expectedVersion: versionSchema, ...memoryFields });
const forgetSchema = z.strictObject({ id: memoryIdSchema, expectedVersion: versionSchema });

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const recordAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const correctAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const forgetAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

type MemoryService = ReturnType<typeof createMemoryService>;
type Annotations = Record<string, boolean>;

interface Tool {
  name: string;
  title: string;
  description: string;
  scopes: readonly string[];
  annotations: Annotations;
  inputSchema: z.core.ZodStandardJSONSchemaPayload<z.ZodType>;
  invoke(service: MemoryService, rawArguments: unknown): Promise<CallToolResult>;
}

/** Defines one tool. Its handler receives arguments typed by its schema, and the same schema validates each call. */
function tool<Schema extends z.ZodType>(definition: {
  name: string;
  title: string;
  description: string;
  schema: Schema;
  scopes: readonly string[];
  annotations: Annotations;
  run: (service: MemoryService, args: z.output<Schema>) => Promise<CallToolResult>;
}): Tool {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    scopes: definition.scopes,
    annotations: definition.annotations,
    inputSchema: z.toJSONSchema(definition.schema, { target: 'draft-2020-12', io: 'input' }),
    async invoke(service, rawArguments) {
      const parsed = definition.schema.safeParse(rawArguments);
      if (!parsed.success) return failure(`输入无效：${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ')}`);
      try { return await definition.run(service, parsed.data); }
      catch (error) { return errorResult(error); }
    },
  };
}

function textResult(data: Record<string, unknown>, message: string): CallToolResult {
  return { content: [{ type: 'text', text: `${message}\n${JSON.stringify(data)}` }], structuredContent: data };
}
function memoryResult(message: string, memory: Memory): CallToolResult {
  return textResult(currentMemory(memory), message);
}
function failure(message: string, metadata?: Record<string, unknown>): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }], ...(metadata ? { _meta: metadata } : {}) };
}
function errorResult(error: unknown): CallToolResult {
  if (error instanceof MemoryError) return failure(`${error.code}: ${error.message}`);
  return failure('记忆服务暂时不可用；没有返回数据库错误或其他内部信息。');
}

const definitions: Tool[] = [
  tool({
    name: 'record_memory',
    title: '记录记忆',
    description: '保存一条用户明确提供的个人记忆。text尽量保留用户原话，并写清来源（例如用户亲口说明、文件名或链接）。知道事情发生时间时，在occurredAt写带时区的ISO 8601时间；未知就省略。记录人物或地点前，先用search_memories查找是否已有条目；只有身份明确时才用relatedIds关联，不要根据同名或常识推断关系。',
    schema: recordSchema,
    scopes: [MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE],
    annotations: recordAnnotations,
    run: async (service, args) => memoryResult('记忆已保存：', await service.record(args)),
  }),
  tool({
    name: 'search_memories',
    title: '查找记忆',
    description: '按字面子串、时间范围或已知记录ID查找。文字检索不是语义检索；找不到时尝试多个短关键词，也可先查人物再用其ID查询relatedTo。对人物关系只依据明确的relatedIds和当前text。返回的text是当前内容；originalText只在存储中保留为历史原文，不作为当前事实。',
    schema: searchSchema,
    scopes: [MEMORY_READ_SCOPE],
    annotations: readAnnotations,
    run: async (service, args) => {
      const memories = (await service.search(args)).map(currentMemory);
      const limit = args.limit ?? DEFAULT_PAGE_LIMIT;
      return textResult({ memories, nextAfterId: memories.length === limit ? memories.at(-1)?.id ?? null : null }, `找到${memories.length}条当前记忆：`);
    },
  }),
  tool({
    name: 'get_memory',
    title: '读取记忆',
    description: '按ID读取一条记忆。通常先用search_memories找到ID。返回的text是当前内容；originalText只在存储中保留为历史原文，不作为当前事实。',
    schema: getSchema,
    scopes: [MEMORY_READ_SCOPE],
    annotations: readAnnotations,
    run: async (service, args) => {
      const memory = await service.get(args.id);
      return memory === null ? failure('没有找到该ID的记忆。') : memoryResult('当前记忆：', memory);
    },
  }),
  tool({
    name: 'correct_memory',
    title: '修改记忆',
    description: '读取最新记录后，按expectedVersion提交完整的新内容；发生冲突时重新读取再决定，不覆盖并发修改。省略occurredAt或relatedIds会按核心规则清空对应字段。存储会保留首次原文作历史记录；返回的text是唯一当前内容，回答只能依据它，不能把历史原文当作事实。',
    schema: correctSchema,
    scopes: [MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE],
    annotations: correctAnnotations,
    run: async (service, { id, expectedVersion, ...value }) => memoryResult('当前记忆已修改：', await service.correct(id, expectedVersion, value)),
  }),
  tool({
    name: 'forget_memory',
    title: '删除记忆',
    description: '永久删除指定ID的记忆。先读取并确认目标记录与expectedVersion；只有用户明确要求删除时调用。删除成功后，该记录的text和保留原文都从主数据库移除。',
    schema: forgetSchema,
    scopes: [MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE],
    annotations: forgetAnnotations,
    run: async (service, args) => {
      await service.forget(args.id, args.expectedVersion);
      return textResult({ deleted: true, id: args.id }, '记忆已删除：');
    },
  }),
];

/** Builds the platform-neutral MCP protocol surface over the existing memory core. */
export function createMemoryMcpServer(service: MemoryService, auth: { scopes: readonly string[]; resourceUrl: URL }): Server {
  const server = new Server({ name: 'MeMem', version: '0.2.0' }, { capabilities: { tools: { listChanged: false } } });
  const tools = definitions.map((definition) => ({
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: definition.annotations,
    securitySchemes: [{ type: 'oauth2', scopes: [...definition.scopes] }],
  }));

  // The MCP SDK's high-level Tool type does not yet model OpenAI's per-tool
  // `securitySchemes` extension. Its supported low-level Server API preserves
  // this extra field while still handling MCP transport, validation and framing.
  server.setRequestHandler('tools/list', {
    params: z.object({}).passthrough(),
    result: z.object({ tools: z.array(z.unknown()) }).passthrough(),
  }, async () => ({ tools }));

  server.setRequestHandler('tools/call', {
    params: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }).passthrough(),
    result: z.any(),
  }, async ({ name, arguments: rawArguments }) => {
    const definition = definitions.find((candidate) => candidate.name === name);
    if (!definition) return failure('未知工具。');
    const missingScopes = definition.scopes.filter((scope) => !auth.scopes.includes(scope));
    if (missingScopes.length > 0) {
      const metadataUrl = getOAuthProtectedResourceMetadataUrl(auth.resourceUrl);
      const scope = missingScopes.join(' ');
      return failure(`需要重新授权以使用此工具（${scope}）。`, {
        'mcp/www_authenticate': [`Bearer resource_metadata="${metadataUrl}", error="insufficient_scope", scope="${scope}", error_description="Required scope: ${scope}"`],
      });
    }
    return definition.invoke(service, rawArguments ?? {});
  });
  return server;
}
