import { describe, expect, test } from "bun:test";
import { Context, Effect } from "effect";
import { graphql, Kind, type StringValueNode } from "graphql";

const emptyCtx = Context.empty();
import { createBuilder } from "./builder.ts";
import { scalars } from "./scalars.ts";
import {
  BigIntScalar,
  DateScalar,
  DateTimeScalar,
  EmailAddressScalar,
  JSONScalar,
  URLScalar,
  UUIDScalar,
  standardScalarTypes,
} from "./standard-scalars.ts";

const stringNode = (value: string): StringValueNode => ({
  kind: Kind.STRING,
  value,
});

describe("DateTimeScalar", () => {
  test("round-trips an ISO-8601 timestamp", () => {
    const wire = "2026-05-08T07:00:00.000Z";
    const parsed = DateTimeScalar.parseValue(wire);
    expect(parsed).toBeInstanceOf(Date);
    expect((parsed as Date).toISOString()).toBe(wire);
    expect(DateTimeScalar.serialize(parsed)).toBe(wire);
  });

  test("parseLiteral on STRING node", () => {
    const wire = "2024-01-02T03:04:05.000Z";
    const d = DateTimeScalar.parseLiteral(stringNode(wire));
    expect(d).toBeInstanceOf(Date);
    expect((d as Date).toISOString()).toBe(wire);
  });

  test("rejects invalid ISO-8601 strings on parseValue", () => {
    expect(() => DateTimeScalar.parseValue("not-a-date")).toThrow(
      /not a valid ISO-8601/,
    );
    expect(() => DateTimeScalar.parseValue("2026-05-08")).toThrow(
      /not a valid ISO-8601/,
    );
    expect(() => DateTimeScalar.parseValue(42)).toThrow(/must be an ISO-8601/);
  });

  test("serialize accepts a string already in ISO form", () => {
    const wire = "2026-05-08T07:00:00.000Z";
    expect(DateTimeScalar.serialize(wire)).toBe(wire);
  });
});

describe("DateScalar", () => {
  test("round-trips a calendar date", () => {
    const wire = "2026-05-08";
    const parsed = DateScalar.parseValue(wire);
    expect(parsed).toBeInstanceOf(Date);
    expect((parsed as Date).getUTCFullYear()).toBe(2026);
    expect((parsed as Date).getUTCMonth()).toBe(4);
    expect((parsed as Date).getUTCDate()).toBe(8);
    expect(DateScalar.serialize(parsed)).toBe(wire);
  });

  test("rejects datetime strings", () => {
    expect(() => DateScalar.parseValue("2026-05-08T00:00:00Z")).toThrow();
  });
});

describe("JSONScalar", () => {
  test("passes objects through", () => {
    const v = { a: 1, b: [true, "x"], c: null };
    expect(JSONScalar.serialize(v)).toEqual(v);
    expect(JSONScalar.parseValue(v)).toEqual(v);
  });

  test("parseLiteral handles nested object literals", () => {
    const node = {
      kind: Kind.OBJECT as const,
      fields: [
        {
          kind: Kind.OBJECT_FIELD as const,
          name: { kind: Kind.NAME as const, value: "n" },
          value: { kind: Kind.INT as const, value: "42" },
        },
        {
          kind: Kind.OBJECT_FIELD as const,
          name: { kind: Kind.NAME as const, value: "items" },
          value: {
            kind: Kind.LIST as const,
            values: [
              { kind: Kind.STRING as const, value: "a" },
              { kind: Kind.BOOLEAN as const, value: true },
            ],
          },
        },
      ],
    };
    expect(JSONScalar.parseLiteral(node)).toEqual({ n: 42, items: ["a", true] });
  });
});

describe("URLScalar", () => {
  test("round-trips a URL", () => {
    const wire = "https://example.com/path?q=1";
    const parsed = URLScalar.parseValue(wire);
    expect(parsed).toBeInstanceOf(URL);
    expect((parsed as URL).toString()).toBe(wire);
    expect(URLScalar.serialize(parsed)).toBe(wire);
  });

  test("rejects invalid URLs", () => {
    expect(() => URLScalar.parseValue("not a url")).toThrow(/URL is not valid/);
  });
});

describe("UUIDScalar", () => {
  test("round-trips a v4 UUID", () => {
    const wire = "550e8400-e29b-41d4-a716-446655440000";
    expect(UUIDScalar.parseValue(wire)).toBe(wire);
    expect(UUIDScalar.serialize(wire)).toBe(wire);
  });

  test("rejects malformed UUIDs", () => {
    expect(() => UUIDScalar.parseValue("not-a-uuid")).toThrow(/UUID is not valid/);
    expect(() => UUIDScalar.parseValue("550e8400-e29b-41d4-a716")).toThrow();
  });
});

describe("BigIntScalar", () => {
  test("round-trips a large integer", () => {
    const big = 2n ** 64n;
    const wire = BigIntScalar.serialize(big);
    expect(wire).toBe(big.toString());
    expect(BigIntScalar.parseValue(wire)).toBe(big);
  });

  test("parseLiteral on INT node yields a bigint", () => {
    const r = BigIntScalar.parseLiteral({ kind: Kind.INT, value: "42" });
    expect(r).toBe(42n);
  });

  test("rejects non-integer numbers", () => {
    expect(() => BigIntScalar.parseValue(1.5)).toThrow(/BigInt cannot parse/);
    expect(() => BigIntScalar.parseValue("12.3")).toThrow(/BigInt cannot parse/);
  });
});

describe("EmailAddressScalar", () => {
  test("round-trips a valid email", () => {
    const wire = "user@example.com";
    expect(EmailAddressScalar.parseValue(wire)).toBe(wire);
    expect(EmailAddressScalar.serialize(wire)).toBe(wire);
  });

  test("rejects malformed emails", () => {
    expect(() => EmailAddressScalar.parseValue("nope")).toThrow();
    expect(() => EmailAddressScalar.parseValue("a@b")).toThrow();
  });
});

describe("standard scalars in the schema", () => {
  test("end-to-end DateTime field returns ISO string", async () => {
    const epoch = new Date("2026-05-08T07:00:00.000Z");
    const b = createBuilder().queryType({
      fields: () => ({
        now: {
          type: scalars.DateTime,
          nonNull: true,
          resolve: () => Effect.succeed(epoch),
        },
      }),
    });
    const schema = b.toSchema(null as never);
    const result = await graphql({
      contextValue: emptyCtx,
      schema,
      source: "{ now }",
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ now: epoch.toISOString() });
  });

  test("standard scalars are present in the schema even when no field references them", () => {
    const b = createBuilder().queryType({
      fields: () => ({
        hello: {
          type: scalars.String,
          nonNull: true,
          resolve: () => Effect.succeed("world"),
        },
      }),
    });
    const schema = b.toSchema(null as never);
    const typeMap = schema.getTypeMap();
    for (const expected of standardScalarTypes) {
      expect(typeMap[expected.name]).toBeDefined();
      expect(typeMap[expected.name]).toBe(expected);
    }
  });

  test("scalars namespace exposes all standard refs with correct names", () => {
    expect(scalars.DateTime.name).toBe("DateTime");
    expect(scalars.Date.name).toBe("Date");
    expect(scalars.JSON.name).toBe("JSON");
    expect(scalars.URL.name).toBe("URL");
    expect(scalars.UUID.name).toBe("UUID");
    expect(scalars.BigInt.name).toBe("BigInt");
    expect(scalars.EmailAddress.name).toBe("EmailAddress");
  });
});
