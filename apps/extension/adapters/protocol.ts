import { z } from 'zod';

export const maxFrameBytes = 512 * 1024;

const id = z.guid();
const u32 = z.number().int().min(0).max(0xffff_ffff);
const problemId = u32.min(1);
const account = z.string().regex(/^[a-zA-Z0-9_]{1,50}$/);
const submissionId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const boundedString = (max: number) => z.string().max(max).refine((value) => new TextEncoder().encode(value).length <= max);
const source = boundedString(256 * 1024);
const input = boundedString(64 * 1024);
const unknownVerdict = boundedString(256);
const executionTimeMs = u32.nullish();
const memoryKb = u32.nullish();
const empty = z.strictObject({});
export const languageSchema = z.enum(['rust', 'c', 'cpp', 'python', 'java']);
export type Language = z.infer<typeof languageSchema>;
const run = {
  jobId: id,
  language: languageSchema,
  source,
  stdin: input.optional(),
  compileTimeoutMs: z.number().int().min(1).max(30_000).nullish(),
  runTimeoutMs: z.number().int().min(1).max(3_000).nullish(),
};
const attempt = { accountContext: account, submissionId };

const payloads = {
  HELLO: empty,
  PING: empty,
  GET_TOOLCHAINS: empty,
  RUN: z.strictObject({ ...run, cases: z.null().optional() }),
  RUN_TESTS: z.strictObject({
    ...run,
    cases: z.array(z.strictObject({ input, expectedOutput: input.nullish() })).min(1).max(20),
  }),
  CANCEL: z.strictObject({ jobId: id }),
  CREATE_SUBMISSION_INTENT: z.strictObject({
    intentId: id,
    accountContext: account.nullish(),
    problemId,
    language: languageSchema.optional(),
    problemTitle: boundedString(512).refine((title) => title.trim().length > 0),
    source,
  }),
  CONFIRM_SUBMISSION: z.strictObject({
    ...attempt,
    intentId: id,
    problemId,
    language: languageSchema.optional(),
    source,
    rawVerdict: unknownVerdict.nullish(),
    executionTimeMs,
    memoryKb,
    submittedAt: z.iso.datetime({ offset: true }).max(40).nullish(),
  }),
  UPDATE_VERDICT: z.strictObject({
    ...attempt, rawVerdict: unknownVerdict, executionTimeMs, memoryKb,
  }),
  GET_PENDING_INTENTS: z.strictObject({ accountContext: account.nullish(), problemId, language: languageSchema.optional() }),
  GET_HISTORY: z.strictObject({
    accountContext: account,
    problemId: problemId.nullish(),
    before: z.number().int().min(1).nullish(),
    limit: z.number().int().min(1).max(100).nullish(),
  }),
  GET_ATTEMPT: z.strictObject(attempt),
  CONFIGURE_REPOSITORY: z.strictObject({ remoteUrl: z.string(), branch: z.string(), autoSync: z.boolean() }),
  SET_GITHUB_AUTH: z.strictObject({ auth: z.strictObject({
    remoteUrl: z.string(),
    basic: z.string().min(20).max(512).regex(/^[A-Za-z0-9+/=]+$/),
    expiresAt: z.number().int().positive(),
  }).nullable() }),
  GET_GIT_STATUS: empty,
  RETRY_SYNC: z.strictObject({ allowPush: z.boolean().optional() }),
  GET_SETTINGS: empty,
  UPDATE_SETTINGS: z.strictObject({ verdictWaitSeconds: z.number().int().min(0).max(86_400) }),
};

type NativeCommand = keyof typeof payloads;
export const nativeCommandSchema = z.enum(Object.keys(payloads).filter((key) => key !== 'HELLO' && key !== 'SET_GITHUB_AUTH') as Exclude<NativeCommand, 'HELLO' | 'SET_GITHUB_AUTH'>[]);
export const requestSchema = z.union(Object.entries(payloads).map(([type, payload]) => z.strictObject({
  protocolVersion: z.literal(1), requestId: id, type: z.literal(type), payload,
})));

const response = { protocolVersion: z.literal(1), type: z.literal('RESPONSE') };
export const responseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ...response, requestId: id, ok: z.literal(true), payload: z.json() }),
  z.strictObject({
    ...response,
    requestId: id.nullable(),
    ok: z.literal(false),
    error: z.strictObject({ code: z.string(), message: z.string(), retryable: z.boolean() }),
  }),
]);
