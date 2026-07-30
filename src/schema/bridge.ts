import { Schema, SchemaAST } from "effect";
import {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLScalarType,
  type GraphQLEnumValueConfig,
  type GraphQLInputFieldConfig,
  type GraphQLInputType,
  type GraphQLNamedType,
} from "../afterglow-graphql/type/definition.ts";
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLString,
} from "../afterglow-graphql/type/scalars.ts";
import { Kind } from "../afterglow-graphql/language/kinds.ts";
import type { ValueNode } from "../afterglow-graphql/language/ast.ts";
import {
  EmptyArraySchema,
  InputUnionNotSupported,
  InvalidSuspendInput,
  MissingIdentifierAnnotation,
  NonStringLiteral,
  TypeRegistryConflict,
  UnmappableAst,
  UnsupportedLiteralKind,
} from "../errors.ts";

/**
 * Maps an Effect Schema to a GraphQL input type.
 *
 * Per DESIGN.md §6: input fields are nullable on the wire by default. This
 * function therefore returns a bare `GraphQLInputType` (never wrapped in
 * `GraphQLNonNull`); the caller decides whether to wrap based on its own
 * non-null opt-in rule.
 *
 * The `registry` is shared with the lowering pipeline so input objects with
 * the same name are deduped across the schema.
 */
export function schemaToInputType(
  schema: Schema.Top,
  registry: Map<string, GraphQLNamedType>,
): GraphQLInputType {
  return astToInputType(schema.ast, registry);
}

/**
 * Whether an arg schema demands a value: not `Schema.optional(...)` /
 * `Schema.optionalKey(...)` (AST context carries `isOptional`) and not a
 * `NullOr` / `UndefinedOr` union. Required args lower to `GraphQLNonNull`
 * so the SDL matches what the resolver types already assume — `ArgsShape`
 * types a bare schema's arg as `S["Type"]` with no undefined.
 */
/**
 * Whether a Number AST carries effect's built-in integer check
 * (`Schema.Int`, or `Schema.Number.check(Schema.isInt())`). Int-checked
 * numbers lower to GraphQL `Int` — note GraphQL `Int` is a 32-bit signed
 * integer per spec; values past 2^31-1 need the `BigInt` standard scalar.
 */
export function hasIntCheck(ast: SchemaAST.AST): boolean {
  const checks = (ast as {
    checks?: ReadonlyArray<{
      readonly annotations?: { readonly representation?: { readonly id?: unknown } };
    }>;
  }).checks;
  return checks?.some((c) => c?.annotations?.representation?.id === "effect/schema/isInt") ?? false;
}

export function isRequiredInputSchema(schema: Schema.Top): boolean {
  return isRequiredInputAst(schema.ast);
}

/**
 * AST-level core of `isRequiredInputSchema` — shared with struct field
 * lowering (`objectsToInputType`), which only has the property signature's
 * AST, not a `Schema.Top` wrapper, to test presence against.
 */
function isRequiredInputAst(ast: SchemaAST.AST): boolean {
  if (ast.context?.isOptional === true) return false;
  if (
    ast._tag === "Union" &&
    (ast as SchemaAST.Union).types.some((m) => m._tag === "Null" || m._tag === "Undefined")
  ) {
    return false;
  }
  return true;
}

/**
 * Bridges a `Schema.Codec<T, string | number | boolean>` to a custom GraphQL
 * scalar. The codec's encoded form (string/number/boolean) is the wire value.
 */
export function schemaToScalar<T>(
  name: string,
  schema: Schema.Codec<T, string | number | boolean, never, never>,
  description?: string,
): GraphQLScalarType<T, string | number | boolean> {
  const decode = Schema.decodeUnknownSync(schema);
  const encode = Schema.encodeSync(schema);

  return new GraphQLScalarType<T, string | number | boolean>({
    name,
    description,
    serialize: (value) => encode(value as T),
    parseValue: (value) => decode(value),
    parseLiteral: (valueNode: ValueNode) => decode(literalValueOf(valueNode)),
  });
}

function literalValueOf(node: ValueNode): unknown {
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
      return node.values.map(literalValueOf);
    case Kind.OBJECT: {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name.value] = literalValueOf(f.value);
      return out;
    }
    default:
      throw new UnsupportedLiteralKind({ kind: node.kind });
  }
}

function astToInputType(
  ast: SchemaAST.AST,
  registry: Map<string, GraphQLNamedType>,
): GraphQLInputType {
  switch (ast._tag) {
    case "String":
      return GraphQLString;
    case "Number":
      return hasIntCheck(ast) ? GraphQLInt : GraphQLFloat;
    case "Boolean":
      return GraphQLBoolean;

    case "Literal":
      return literalToInputType(ast, registry);

    case "Union":
      return unionToInputType(ast, registry);

    case "Objects":
      return objectsToInputType(ast, registry);

    case "Suspend":
      // Recursive input — synthesize a thunked InputObjectType. The Suspend's
      // own annotations should carry an identifier so we can pre-register a
      // stub before walking the inner ast (which is what makes recursion work).
      return suspendToInputType(ast, registry);

    case "Arrays":
      return arraysToInputType(ast, registry);

    case "Enum":
      return enumToInputType(ast, registry);

    default:
      throw new UnmappableAst({ position: "input", astTag: ast._tag });
  }
}

function literalToInputType(
  ast: SchemaAST.Literal,
  registry: Map<string, GraphQLNamedType>,
): GraphQLInputType {
  const v = ast.literal;
  if (typeof v !== "string") {
    throw new NonStringLiteral({ literalType: typeof v, literalValue: String(v) });
  }
  // A bare 1-value literal becomes a single-value enum. Naming is awkward
  // without an identifier, so we require one (via .annotate) on isolated
  // single-value literals. If absent, derive `${PascalValue}Enum` and hope.
  const id = identifierOf(ast) ?? defaultEnumName(v);
  const cached = registry.get(id);
  if (cached) {
    if (!(cached instanceof GraphQLEnumType)) {
      throw new TypeRegistryConflict({ typeName: id, wantedKind: "enum" });
    }
    return cached;
  }
  const enumType = new GraphQLEnumType({
    name: id,
    values: { [v]: { value: v } },
  });
  registry.set(id, enumType);
  return enumType;
}

function unionToInputType(
  ast: SchemaAST.Union,
  registry: Map<string, GraphQLNamedType>,
): GraphQLInputType {
  // Null and Undefined members carry no wire shape — NullOr(T) means a null
  // literal may arrive, optional/UndefinedOr(T) means the value may be
  // absent. Either way the GraphQL input type is bare T (nullability is the
  // caller's concern; see DESIGN.md §6).
  const nonNullMembers = ast.types.filter((m) => m._tag !== "Null" && m._tag !== "Undefined");
  if (nonNullMembers.length === 1 && nonNullMembers.length < ast.types.length) {
    return astToInputType(nonNullMembers[0]!, registry);
  }

  // Pure string-literal union → GraphQLEnumType (DESIGN.md §6).
  if (
    nonNullMembers.length > 0 &&
    nonNullMembers.every(
      (m) => m._tag === "Literal" && typeof (m as SchemaAST.Literal).literal === "string",
    )
  ) {
    return literalUnionToEnum(ast, nonNullMembers as ReadonlyArray<SchemaAST.Literal>, registry);
  }

  // Anything else is a true input union — banned by GraphQL.
  throw new InputUnionNotSupported();
}

function literalUnionToEnum(
  ast: SchemaAST.Union,
  members: ReadonlyArray<SchemaAST.Literal>,
  registry: Map<string, GraphQLNamedType>,
): GraphQLEnumType {
  const id = identifierOf(ast);
  if (!id) {
    throw new MissingIdentifierAnnotation({
      position: "input",
      construct: "literal-union",
      members: members.map((m) => String(m.literal)),
    });
  }
  const cached = registry.get(id);
  if (cached) {
    if (!(cached instanceof GraphQLEnumType)) {
      throw new TypeRegistryConflict({ typeName: id, wantedKind: "enum" });
    }
    return cached;
  }
  const values: Record<string, GraphQLEnumValueConfig> = {};
  for (const m of members) {
    const v = m.literal as string;
    values[v] = { value: v };
  }
  const enumType = new GraphQLEnumType({ name: id, values });
  registry.set(id, enumType);
  return enumType;
}

function objectsToInputType(
  ast: SchemaAST.Objects,
  registry: Map<string, GraphQLNamedType>,
): GraphQLInputObjectType {
  const id = identifierOf(ast);
  if (!id) {
    throw new MissingIdentifierAnnotation({ position: "input", construct: "struct" });
  }
  const cached = registry.get(id);
  if (cached) {
    if (!(cached instanceof GraphQLInputObjectType)) {
      throw new TypeRegistryConflict({ typeName: id, wantedKind: "input object" });
    }
    return cached;
  }

  // Pre-register a stub by writing a placeholder so recursive references
  // resolve. We do this by constructing the InputObjectType eagerly with a
  // thunked `fields` — the thunk closes over the registry so suspended
  // references find this very object.
  const inputType = new GraphQLInputObjectType({
    name: id,
    fields: () => {
      const fields: Record<string, GraphQLInputFieldConfig> = {};
      for (const ps of ast.propertySignatures) {
        // GraphQL field names must be strings.
        if (typeof ps.name !== "string") continue;
        // A non-optional property demands a value — the wire must enforce
        // it too, same rule as top-level required args (argToGraphQLConfig
        // in compile.ts): bare schemas lower to the non-null wrapper,
        // Schema.optional/optionalKey and NullOr/UndefinedOr stay nullable.
        const base = astToInputType(ps.type, registry);
        fields[ps.name] = {
          type: isRequiredInputAst(ps.type) ? new GraphQLNonNull(base) : base,
        };
      }
      return fields;
    },
  });
  registry.set(id, inputType);
  return inputType;
}

function suspendToInputType(
  ast: SchemaAST.Suspend,
  registry: Map<string, GraphQLNamedType>,
): GraphQLInputType {
  // Resolve the thunk lazily, but GraphQL needs a named type up front
  // to break cycles. If the Suspend (or its underlying Objects) carries an
  // identifier, we can produce a forward-referenced GraphQLInputObjectType
  // whose `fields` thunk walks the resolved AST on demand.
  const id = identifierOf(ast);

  if (id) {
    const existing = registry.get(id);
    if (existing) {
      if (!(existing instanceof GraphQLInputObjectType)) {
        throw new TypeRegistryConflict({ typeName: id, wantedKind: "input object" });
      }
      return existing;
    }
    const inputType = new GraphQLInputObjectType({
      name: id,
      fields: () => {
        const inner = ast.thunk();
        if (inner._tag !== "Objects") {
          throw new InvalidSuspendInput({ astTag: inner._tag });
        }
        const fields: Record<string, GraphQLInputFieldConfig> = {};
        for (const ps of inner.propertySignatures) {
          if (typeof ps.name !== "string") continue;
          fields[ps.name] = { type: astToInputType(ps.type, registry) };
        }
        return fields;
      },
    });
    registry.set(id, inputType);
    return inputType;
  }

  // No identifier on the Suspend itself — peek at the inner AST. If the inner
  // is an Objects with an identifier, route through objectsToInputType which
  // already memoizes by id and breaks cycles via its own thunked fields.
  const inner = ast.thunk();
  return astToInputType(inner, registry);
}

function arraysToInputType(
  ast: SchemaAST.Arrays,
  registry: Map<string, GraphQLNamedType>,
): GraphQLInputType {
  // Treat as a homogeneous list. Effect's `Schema.Array(T)` produces an
  // Arrays AST with `elements: []` and `rest: [T]`.
  const inner =
    ast.rest.length > 0 ? ast.rest[0]! : ast.elements.length > 0 ? ast.elements[0]! : undefined;
  if (!inner) {
    throw new EmptyArraySchema({ position: "input" });
  }
  return new GraphQLList(astToInputType(inner, registry));
}

function enumToInputType(
  ast: SchemaAST.Enum,
  registry: Map<string, GraphQLNamedType>,
): GraphQLEnumType {
  const id = identifierOf(ast);
  if (!id) {
    throw new MissingIdentifierAnnotation({ position: "input", construct: "enums" });
  }
  const cached = registry.get(id);
  if (cached) {
    if (!(cached instanceof GraphQLEnumType)) {
      throw new TypeRegistryConflict({ typeName: id, wantedKind: "enum" });
    }
    return cached;
  }
  const values: Record<string, GraphQLEnumValueConfig> = {};
  for (const [name, value] of ast.enums) {
    values[name] = { value };
  }
  const enumType = new GraphQLEnumType({ name: id, values });
  registry.set(id, enumType);
  return enumType;
}

function identifierOf(ast: SchemaAST.AST): string | undefined {
  const id = ast.annotations?.identifier;
  return typeof id === "string" ? id : undefined;
}

function defaultEnumName(value: string): string {
  // Sanitize the value into a GraphQL-safe-ish name as a last-resort fallback.
  // This is intentionally narrow — callers should provide an identifier.
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, "_");
  const head = /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
  return `${head[0]!.toUpperCase()}${head.slice(1)}Enum`;
}
