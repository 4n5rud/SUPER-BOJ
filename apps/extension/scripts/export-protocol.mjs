import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { requestSchema, responseSchema } from '../adapters/protocol.ts';

for (const [key, schema] of Object.entries({ request: requestSchema, response: responseSchema })) {
  const target = new URL(`../../../packages/protocol/schema/v1-${key}.json`, import.meta.url);
  writeFileSync(target, `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`);
}
