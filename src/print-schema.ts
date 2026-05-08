/**
 * `printSchemaWithDirectives` — SDL printer that preserves applied directives
 * on field definitions. graphql-js's `printSchema` strips directive
 * applications (it only prints directive *declarations*). For Relay's
 * client-side semantic-nullability flow to work, the SDL relay-compiler reads
 * MUST preserve `@semanticNonNull` (and any other field-level applied
 * directives) so the compiler can pick them up and emit non-null TS types
 * under `@throwOnFieldError`.
 *
 * This printer post-processes `printSchema`'s output by walking each object /
 * interface type's fields and re-formatting any field whose `astNode`
 * contains a non-empty `directives` list. The non-directive parts are still
 * delegated to graphql-js so we don't drift on type / arg formatting.
 */
import {
  GraphQLInterfaceType,
  GraphQLObjectType,
  print,
  printSchema,
  type GraphQLField,
  type GraphQLSchema,
  type ConstDirectiveNode,
} from "graphql";

export function printSchemaWithDirectives(schema: GraphQLSchema): string {
  let sdl = printSchema(schema);

  for (const type of Object.values(schema.getTypeMap())) {
    if (
      !(type instanceof GraphQLObjectType) &&
      !(type instanceof GraphQLInterfaceType)
    ) {
      continue;
    }
    if (type.name.startsWith("__")) continue;

    for (const field of Object.values(type.getFields())) {
      const directives = directivesOnField(field);
      if (directives.length === 0) continue;
      sdl = appendFieldDirectives(sdl, type.name, field.name, directives);
    }
  }

  return sdl;
}

function directivesOnField(field: GraphQLField<unknown, unknown>): ReadonlyArray<ConstDirectiveNode> {
  const ast = field.astNode;
  if (!ast || !ast.directives) return [];
  return ast.directives;
}

/**
 * Find the printed line for `Type.field` in the SDL and append the directive
 * applications to it. We anchor on `printSchema`'s deterministic format:
 *
 *     type <Type> ... {
 *       <field>(args...): <FieldType>
 *       <field>: <FieldType>
 *     }
 *
 * The match is intentionally line-scoped so we don't accidentally rewrite
 * args containing the same field name.
 */
function appendFieldDirectives(
  sdl: string,
  typeName: string,
  fieldName: string,
  directives: ReadonlyArray<ConstDirectiveNode>,
): string {
  const lines = sdl.split("\n");
  const printed = directives.map((d) => print(d)).join(" ");

  // Locate `type <typeName>` (or `interface <typeName>`) opening line, then
  // the matching `}` close. Within that range, find the field row.
  const headerIdx = lines.findIndex(
    (l) =>
      l.startsWith(`type ${typeName} `) ||
      l === `type ${typeName} {` ||
      l.startsWith(`type ${typeName}(`) ||
      l.startsWith(`interface ${typeName} `) ||
      l === `interface ${typeName} {` ||
      l.startsWith(`interface ${typeName}(`),
  );
  if (headerIdx === -1) return sdl;

  let closeIdx = headerIdx;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i] === "}") {
      closeIdx = i;
      break;
    }
  }

  // Field rows are indented by two spaces. We need to handle two shapes:
  //   `  fieldName: Type`
  //   `  fieldName(args): Type`
  // (Multi-line arg blocks start with `  fieldName(\n` — graphql-js does this
  // when any arg has a description. Find the row whose first identifier is
  // `fieldName`.)
  const fieldRe = new RegExp(`^  ${escapeRegExp(fieldName)}([ (:])`);
  for (let i = headerIdx + 1; i < closeIdx; i++) {
    const line = lines[i] ?? "";
    if (!fieldRe.test(line)) continue;

    // For inline fields the row already terminates with ` : Type`. Append the
    // directive(s) at end-of-line.
    if (line.includes("):") || /:\s/.test(line.slice(2))) {
      lines[i] = `${line} ${printed}`;
      return lines.join("\n");
    }

    // Multi-line arg block — the closing `): Type` is on a later line. Walk
    // forward for it.
    for (let j = i + 1; j < closeIdx; j++) {
      const inner = lines[j] ?? "";
      if (inner.startsWith("  )") && inner.includes("):")) {
        lines[j] = `${inner} ${printed}`;
        return lines.join("\n");
      }
    }
    return sdl;
  }
  return sdl;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
