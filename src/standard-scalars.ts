/**
 * Standard custom scalars baked into every @athanor/alembic schema.
 *
 * Per the project's zero-config Relay positioning, these scalars are
 * registered automatically by `lower()` regardless of whether any user
 * field references them. Their names follow the
 * [graphql-scalars](https://the-guild.dev/graphql/scalars) convention so
 * Relay clients can map them through `customScalarTypes` without
 * per-app boilerplate.
 *
 * The wire encoding for each scalar:
 *
 * | Scalar       | TS type   | Wire     |
 * | ------------ | --------- | -------- |
 * | DateTime     | Date      | string   | ISO-8601 timestamp
 * | Date         | Date      | string   | ISO date `YYYY-MM-DD`
 * | JSON         | unknown   | any      | passes through
 * | URL          | URL       | string   |
 * | UUID         | string    | string   | RFC 4122
 * | BigInt       | bigint    | string   | JSON-safety: stringified
 * | EmailAddress | string    | string   | RFC 5322-light
 */
import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";
import {
  GraphQLScalarType,
  Kind,
  type ValueNode,
} from "graphql";

// ---------------------------------------------------------------------------
// helpers

const literalString = (node: ValueNode): string => {
  if (node.kind !== Kind.STRING) {
    throw new TypeError(
      `expected string literal, got ${node.kind}`,
    );
  }
  return node.value;
};

const ensureFiniteDate = (d: Date, raw: unknown): Date => {
  if (Number.isNaN(d.getTime())) {
    throw new TypeError(
      `invalid date: ${typeof raw === "string" ? JSON.stringify(raw) : String(raw)}`,
    );
  }
  return d;
};

// ---------------------------------------------------------------------------
// DateTime — ISO-8601 timestamp

const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const parseDateTime = (raw: unknown): Date => {
  if (raw instanceof Date) return ensureFiniteDate(new Date(raw.getTime()), raw);
  if (typeof raw !== "string") {
    throw new TypeError(`DateTime must be an ISO-8601 string, got ${typeof raw}`);
  }
  if (!ISO_DATETIME_RE.test(raw)) {
    throw new TypeError(`DateTime is not a valid ISO-8601 timestamp: ${JSON.stringify(raw)}`);
  }
  return ensureFiniteDate(new Date(raw), raw);
};

export const DateTimeScalar: GraphQLScalarType<Date, string> =
  new GraphQLScalarType<Date, string>({
    name: "DateTime",
    description:
      "ISO-8601 encoded UTC date-time string (e.g. `2026-05-08T07:00:00.000Z`).",
    serialize: (value: unknown): string => {
      if (value instanceof Date) return ensureFiniteDate(value, value).toISOString();
      if (typeof value === "string" && ISO_DATETIME_RE.test(value)) return value;
      throw new TypeError(
        `DateTime cannot represent value: ${JSON.stringify(value)}`,
      );
    },
    parseValue: parseDateTime,
    parseLiteral: (node) => parseDateTime(literalString(node)),
  });

// ---------------------------------------------------------------------------
// Date — ISO-8601 calendar date (YYYY-MM-DD), parsed at midnight UTC

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const formatIsoDate = (d: Date): string => {
  // Always emit YYYY-MM-DD in UTC, regardless of local timezone.
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const parseDate = (raw: unknown): Date => {
  if (raw instanceof Date) return ensureFiniteDate(new Date(raw.getTime()), raw);
  if (typeof raw !== "string" || !ISO_DATE_RE.test(raw)) {
    throw new TypeError(
      `Date must be an ISO-8601 calendar date (YYYY-MM-DD), got ${JSON.stringify(raw)}`,
    );
  }
  return ensureFiniteDate(new Date(`${raw}T00:00:00.000Z`), raw);
};

export const DateScalar: GraphQLScalarType<Date, string> =
  new GraphQLScalarType<Date, string>({
    name: "Date",
    description: "ISO-8601 encoded calendar date (`YYYY-MM-DD`).",
    serialize: (value: unknown): string => {
      if (value instanceof Date) return formatIsoDate(ensureFiniteDate(value, value));
      if (typeof value === "string" && ISO_DATE_RE.test(value)) return value;
      throw new TypeError(`Date cannot represent value: ${JSON.stringify(value)}`);
    },
    parseValue: parseDate,
    parseLiteral: (node) => parseDate(literalString(node)),
  });

// ---------------------------------------------------------------------------
// JSON — arbitrary JSON value, identity wire codec

const cloneJson = (v: unknown): unknown => {
  switch (typeof v) {
    case "string":
    case "number":
    case "boolean":
      return v;
    case "object":
      if (v === null) return null;
      if (Array.isArray(v)) return v.map(cloneJson);
      return JSON.parse(JSON.stringify(v));
    default:
      throw new TypeError(`JSON cannot represent value of type ${typeof v}`);
  }
};

const literalToJson = (node: ValueNode): unknown => {
  switch (node.kind) {
    case Kind.STRING:
    case Kind.ENUM:
      return node.value;
    case Kind.INT:
      return parseInt(node.value, 10);
    case Kind.FLOAT:
      return parseFloat(node.value);
    case Kind.BOOLEAN:
      return node.value;
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return node.values.map(literalToJson);
    case Kind.OBJECT: {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name.value] = literalToJson(f.value);
      return out;
    }
    default:
      throw new TypeError(
        `JSON cannot represent literal of kind "${node.kind}"`,
      );
  }
};

export const JSONScalar: GraphQLScalarType<unknown, unknown> =
  new GraphQLScalarType<unknown, unknown>({
    name: "JSON",
    description:
      "Arbitrary JSON value (object, array, string, number, boolean, or null).",
    serialize: (value) => cloneJson(value),
    parseValue: (value) => cloneJson(value),
    parseLiteral: (node) => literalToJson(node),
  });

// ---------------------------------------------------------------------------
// URL — JS URL object on the server, string on the wire

const parseURL = (raw: unknown): URL => {
  if (raw instanceof URL) return new URL(raw.toString());
  if (typeof raw !== "string") {
    throw new TypeError(`URL must be a string, got ${typeof raw}`);
  }
  try {
    return new URL(raw);
  } catch {
    throw new TypeError(`URL is not valid: ${JSON.stringify(raw)}`);
  }
};

export const URLScalar: GraphQLScalarType<URL, string> =
  new GraphQLScalarType<URL, string>({
    name: "URL",
    description: "RFC 3986 URL string.",
    serialize: (value: unknown): string => {
      if (value instanceof URL) return value.toString();
      if (typeof value === "string") return parseURL(value).toString();
      throw new TypeError(`URL cannot represent value: ${JSON.stringify(value)}`);
    },
    parseValue: parseURL,
    parseLiteral: (node) => parseURL(literalString(node)),
  });

// ---------------------------------------------------------------------------
// UUID — RFC 4122 (any version)

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseUUID = (raw: unknown): string => {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    throw new TypeError(`UUID is not valid: ${JSON.stringify(raw)}`);
  }
  return raw.toLowerCase();
};

export const UUIDScalar: GraphQLScalarType<string, string> =
  new GraphQLScalarType<string, string>({
    name: "UUID",
    description: "RFC 4122 UUID string.",
    serialize: (value: unknown): string => {
      if (typeof value !== "string" || !UUID_RE.test(value)) {
        throw new TypeError(`UUID cannot represent value: ${JSON.stringify(value)}`);
      }
      return value.toLowerCase();
    },
    parseValue: parseUUID,
    parseLiteral: (node) => parseUUID(literalString(node)),
  });

// ---------------------------------------------------------------------------
// BigInt — bigint on the server, decimal string on the wire (JSON-safe)

const BIGINT_RE = /^-?\d+$/;

const parseBigInt = (raw: unknown): bigint => {
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number" && Number.isInteger(raw)) return BigInt(raw);
  if (typeof raw === "string" && BIGINT_RE.test(raw)) {
    try {
      return BigInt(raw);
    } catch {
      throw new TypeError(`BigInt is not valid: ${JSON.stringify(raw)}`);
    }
  }
  throw new TypeError(`BigInt cannot parse value: ${JSON.stringify(raw)}`);
};

export const BigIntScalar: GraphQLScalarType<bigint, string> =
  new GraphQLScalarType<bigint, string>({
    name: "BigInt",
    description:
      "Arbitrary-precision integer encoded as a decimal string (for JSON safety).",
    serialize: (value: unknown): string => {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "number" && Number.isInteger(value)) return value.toString();
      if (typeof value === "string" && BIGINT_RE.test(value)) return value;
      throw new TypeError(`BigInt cannot represent value: ${JSON.stringify(value)}`);
    },
    parseValue: parseBigInt,
    parseLiteral: (node) => {
      switch (node.kind) {
        case Kind.STRING:
          return parseBigInt(node.value);
        case Kind.INT:
          return BigInt(node.value);
        default:
          throw new TypeError(
            `BigInt cannot represent literal of kind "${node.kind}"`,
          );
      }
    },
  });

// ---------------------------------------------------------------------------
// EmailAddress — RFC 5322-light validation

// Pragmatic email regex — same flavor used by graphql-scalars and most form
// libraries. Not a full RFC 5322 grammar, but matches what users actually type.
const EMAIL_RE =
  /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

const parseEmail = (raw: unknown): string => {
  if (typeof raw !== "string" || !EMAIL_RE.test(raw)) {
    throw new TypeError(`EmailAddress is not valid: ${JSON.stringify(raw)}`);
  }
  return raw;
};

export const EmailAddressScalar: GraphQLScalarType<string, string> =
  new GraphQLScalarType<string, string>({
    name: "EmailAddress",
    description: "RFC 5322 email address.",
    serialize: (value: unknown): string => {
      if (typeof value !== "string" || !EMAIL_RE.test(value)) {
        throw new TypeError(`EmailAddress cannot represent value: ${JSON.stringify(value)}`);
      }
      return value;
    },
    parseValue: parseEmail,
    parseLiteral: (node) => parseEmail(literalString(node)),
  });

// ---------------------------------------------------------------------------
// Combined registry

/**
 * The full set of standard custom scalars. `lower()` injects every entry into
 * the schema's type registry on each call so introspection always lists them,
 * even when no user field references them. This is what lets Relay clients
 * pre-configure `customScalarTypes` for the framework without touching each
 * server's resolver code.
 */
export const standardScalarTypes: ReadonlyArray<GraphQLScalarType> = [
  DateTimeScalar,
  DateScalar,
  JSONScalar,
  URLScalar,
  UUIDScalar,
  BigIntScalar,
  EmailAddressScalar,
];

// ---------------------------------------------------------------------------
// Effect Schema codecs (for arg/input use)

const invalidValue = (
  s: string,
  message: string,
): Effect.Effect<never, SchemaIssue.Issue> =>
  Effect.fail(new SchemaIssue.InvalidValue(Option.some(s), { message }));

const bigIntFromString = Schema.String.pipe(
  Schema.decodeTo(Schema.BigInt, {
    decode: SchemaGetter.transformOrFail((s: string, _opts) => {
      if (!BIGINT_RE.test(s)) {
        return invalidValue(s, `BigInt is not a valid decimal: ${JSON.stringify(s)}`);
      }
      try {
        return Effect.succeed(BigInt(s));
      } catch {
        return invalidValue(s, `BigInt is not parseable: ${JSON.stringify(s)}`);
      }
    }),
    encode: SchemaGetter.transform((b: bigint) => b.toString()),
  }),
).annotate({ identifier: "BigInt" });

const uuidString = Schema.String.check(Schema.isUUID()).annotate({
  identifier: "UUID",
});

const emailString = Schema.String.check(
  Schema.isPattern(EMAIL_RE, { description: "RFC 5322 email address" }),
).annotate({ identifier: "EmailAddress" });

/**
 * Effect Schema codecs paired with each standard scalar. Use these as arg/input
 * schemas (`b.queryType({ args: { x: { schema: standardSchemas.uuid } } })`) so
 * decoding errors land in the resolver as typed validation failures.
 */
export const standardSchemas = {
  /** ISO-8601 string ↔ `Date`. */
  dateTime: Schema.DateFromString,
  /** Calendar date `YYYY-MM-DD` ↔ `Date` (wire form is the same string). */
  date: Schema.DateFromString,
  /** Arbitrary JSON value. */
  json: Schema.Unknown,
  /** URL string ↔ `URL`. */
  url: Schema.URLFromString,
  /** UUID-validated string. */
  uuid: uuidString,
  /** Decimal string ↔ `bigint`. */
  bigint: bigIntFromString,
  /** RFC-light validated email string. */
  emailAddress: emailString,
} as const;
