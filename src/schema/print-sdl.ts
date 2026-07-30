/**
 * SDL printer that preserves field-level directive applications encoded on
 * each `GraphQLFieldConfig.astNode`. The stock schema printer ignores
 * `astNode` entirely (it concatenates
 * description + name + args + type + deprecation, no directive lookup), so
 * `@semanticNonNull` annotations the lowering pass attaches via `astNode`
 * never make it into the printed SDL.
 *
 * relay-compiler reads its schema from a `.graphql` file, so the directives
 * must live in printed SDL or the `@semanticNonNull` -> non-null TS-type
 * transform never fires.
 *
 * Strategy: print via Afterglow, parse into a `DocumentNode`, walk the
 * definitions to (a) drop directive/enum declarations relay-compiler
 * bundles itself when `forRelayCompiler` is set, and (b) attach the
 * field-level directives we collected from the live schema's
 * `GraphQLField.astNode` onto the printed FieldDefinitionNode. Re-print the
 * filtered AST.
 */
import {
  GraphQLInterfaceType,
  GraphQLObjectType,
  type GraphQLField,
} from "../afterglow-graphql/type/definition.ts";
import type { GraphQLSchema } from "../afterglow-graphql/type/schema.ts";
import { Kind } from "../afterglow-graphql/language/kinds.ts";
import { parseSync as parse } from "../afterglow-graphql/language/parser.ts";
import { print } from "../afterglow-graphql/language/printer.ts";
import { printSchema } from "../afterglow-graphql/utilities/print-schema.ts";
import type {
  DefinitionNode,
  DocumentNode,
  FieldDefinitionNode,
  ConstDirectiveNode,
} from "../afterglow-graphql/language/ast.ts";

export interface PrintSchemaOptions {
  /**
   * When true, omit directive declarations and supporting enums that
   * relay-compiler bundles itself; otherwise the compiler errors with
   * "Duplicate directive definition '<name>'".
   *
   * Pinned to `relay-compiler@20.1.1/relay-extensions.graphql` (verified
   * 2026-05-08).
   */
  readonly forRelayCompiler?: boolean;
}

const RELAY_COMPILER_BUILTIN_DIRECTIVES: ReadonlySet<string> = new Set([
  "inline",
  "no_inline",
  "throwOnFieldError",
  "raw_response_type",
  "refetchable",
  "relay",
  "match",
  "module",
  "connection",
  "stream_connection",
  "required",
  "catch",
  "deleteRecord",
  "deleteEdge",
  "appendEdge",
  "prependEdge",
  "appendNode",
  "prependNode",
  "waterfall",
  "updatable",
  "assignable",
  "alias",
  "dangerously_unaliased_fixme",
]);

const RELAY_COMPILER_BUILTIN_ENUMS: ReadonlySet<string> = new Set([
  "RequiredFieldAction",
  "CatchFieldTo",
]);

export function printSchemaWithDirectives(
  schema: GraphQLSchema,
  options: PrintSchemaOptions = {},
): string {
  const stock = printSchema(schema);
  const doc = parse(stock);

  const fieldDirectives = collectFieldDirectives(schema);
  const filtered = doc.definitions.flatMap<DefinitionNode>((def) => {
    if (
      options.forRelayCompiler &&
      def.kind === Kind.DIRECTIVE_DEFINITION &&
      RELAY_COMPILER_BUILTIN_DIRECTIVES.has(def.name.value)
    ) {
      return [];
    }
    if (
      options.forRelayCompiler &&
      def.kind === Kind.ENUM_TYPE_DEFINITION &&
      RELAY_COMPILER_BUILTIN_ENUMS.has(def.name.value)
    ) {
      return [];
    }
    if (
      def.kind === Kind.OBJECT_TYPE_DEFINITION ||
      def.kind === Kind.INTERFACE_TYPE_DEFINITION
    ) {
      return [attachFieldDirectives(def, fieldDirectives)];
    }
    return [def];
  });

  const out: DocumentNode = { kind: Kind.DOCUMENT, definitions: filtered };
  return print(out);
}

function collectFieldDirectives(
  schema: GraphQLSchema,
): Map<string, ReadonlyArray<ConstDirectiveNode>> {
  const map = new Map<string, ReadonlyArray<ConstDirectiveNode>>();
  for (const named of Object.values(schema.getTypeMap())) {
    if (
      !(named instanceof GraphQLObjectType) &&
      !(named instanceof GraphQLInterfaceType)
    ) {
      continue;
    }
    for (const field of Object.values(named.getFields()) as Array<
      GraphQLField<unknown, unknown>
    >) {
      const ast = field.astNode;
      if (!ast || !ast.directives || ast.directives.length === 0) continue;
      map.set(`${named.name}.${field.name}`, ast.directives);
    }
  }
  return map;
}

function attachFieldDirectives<
  T extends { readonly kind: typeof Kind.OBJECT_TYPE_DEFINITION | typeof Kind.INTERFACE_TYPE_DEFINITION },
>(
  def: T & {
    readonly name: { readonly value: string };
    readonly fields?: ReadonlyArray<FieldDefinitionNode>;
  },
  fieldDirectives: ReadonlyMap<string, ReadonlyArray<ConstDirectiveNode>>,
): DefinitionNode {
  const fields = def.fields ?? [];
  const next = fields.map((f) => {
    const extras = fieldDirectives.get(`${def.name.value}.${f.name.value}`);
    if (!extras || extras.length === 0) return f;
    const merged: FieldDefinitionNode = {
      ...f,
      directives: [...(f.directives ?? []), ...extras],
    };
    return merged;
  });
  return { ...def, fields: next } as unknown as DefinitionNode;
}
