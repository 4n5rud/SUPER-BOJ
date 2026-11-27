import { expect, test } from 'vitest';
import { z } from 'zod';
import requests from '../../../packages/protocol/fixtures/v1-requests.json';
import requestJsonSchema from '../../../packages/protocol/schema/v1-request.json';
import responseJsonSchema from '../../../packages/protocol/schema/v1-response.json';
import { requestSchema, responseSchema } from '../adapters/protocol';

for (const { request, accepted } of requests) {
  test(`protocol fixture ${request.type} ${request.requestId}`, () => {
    expect(requestSchema.safeParse(request).success).toBe(accepted);
  });
}

test('published JSON Schemas match the extension runtime validators', () => {
  expect(requestJsonSchema).toEqual(z.toJSONSchema(requestSchema));
  expect(responseJsonSchema).toEqual(z.toJSONSchema(responseSchema));
});
