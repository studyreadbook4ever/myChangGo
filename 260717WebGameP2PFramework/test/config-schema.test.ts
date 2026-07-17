import { readFileSync } from "node:fs";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, validateConfig } from "../packages/core/src/config.js";

const schema = JSON.parse(
  readFileSync(new URL("../relayplay.config.schema.json", import.meta.url), "utf8"),
) as object;
const exampleConfig = JSON.parse(
  readFileSync(new URL("../relayplay.config.example.json", import.meta.url), "utf8"),
) as unknown;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

describe("relayplay.config.schema.json", () => {
  it("accepts the complete framework defaults", () => {
    const accepted = validateSchema(DEFAULT_CONFIG);
    expect(validateSchema.errors, JSON.stringify(validateSchema.errors, null, 2)).toBeNull();
    expect(accepted).toBe(true);
  });

  it("accepts the checked-in complete example", () => {
    const accepted = validateSchema(exampleConfig);
    expect(validateSchema.errors, JSON.stringify(validateSchema.errors, null, 2)).toBeNull();
    expect(accepted).toBe(true);
    expect(validateConfig(exampleConfig).success).toBe(true);
  });

  it("rejects security invariants that runtime validation also rejects", () => {
    const candidate = { security: { peerToPeer: true } };
    expect(validateSchema(candidate)).toBe(false);
    expect(validateConfig(candidate).success).toBe(false);
  });

  it("rejects incomplete custom action rate limits", () => {
    const candidate = {
      security: {
        rateLimits: {
          actions: {
            custom_freeze: { capacity: 2 },
          },
        },
      },
    };
    expect(validateSchema(candidate)).toBe(false);
    expect(validateConfig(candidate).success).toBe(false);
  });
});
