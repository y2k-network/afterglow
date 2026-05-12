import { expect } from "bun:test";
import { describe, test as it } from "bun:test";
import { Effect } from "effect";

import { dedent } from '../__testUtils__/dedent.ts';

import { DirectiveLocation } from "../language/directive-location.ts";

import { GraphQLObjectType } from "../type/definition.ts";
import { GraphQLDirective } from "../type/directives.ts";
import { GraphQLString } from "../type/scalars.ts";
import { GraphQLSchema } from "../type/schema.ts";

import { buildClientSchemaSync as buildClientSchema } from './build-client-schema.ts';
import type { IntrospectionQuery } from './get-introspection-query.ts';
import { introspectionFromSchema } from './introspection-from-schema.ts';
import { printSchema } from './print-schema.ts';

function introspectionToSDL(introspection: IntrospectionQuery): string {
  return printSchema(buildClientSchema(introspection));
}

describe('introspectionFromSchema', () => {
  const schema = new GraphQLSchema({
    description: 'This is a simple schema',
    query: new GraphQLObjectType({
      name: 'Simple',
      description: 'This is a simple type',
      fields: {
        string: {
          type: GraphQLString,
          description: 'This is a string field',
        },
      },
    }),
  });

  it('converts a simple schema', async () => {
    const introspection = await Effect.runPromise(introspectionFromSchema(schema));

    expect(introspectionToSDL(introspection)).toEqual(dedent`
      """This is a simple schema"""
      schema {
        query: Simple
      }

      """This is a simple type"""
      type Simple {
        """This is a string field"""
        string: String
      }
    `);
  });

  it('converts a simple schema without descriptions', async () => {
    const introspection = await Effect.runPromise(
      introspectionFromSchema(schema, {
        descriptions: false,
      }),
    );

    expect(introspectionToSDL(introspection)).toEqual(dedent`
      schema {
        query: Simple
      }

      type Simple {
        string: String
      }
    `);
  });

  it('includes deprecated directives', async () => {
    const schemaWithDeprecatedDirective = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          string: {
            type: GraphQLString,
          },
        },
      }),
      directives: [
        new GraphQLDirective({
          name: 'deprecatedDirective',
          locations: [DirectiveLocation.QUERY],
          deprecationReason: 'Use another directive',
        }),
      ],
    });
    const introspection = await Effect.runPromise(
      introspectionFromSchema(schemaWithDeprecatedDirective),
    );
    const deprecatedDirective = introspection.__schema.directives.find(
      ({ name }) => name === 'deprecatedDirective',
    );

    expect(deprecatedDirective).toMatchObject({
      name: 'deprecatedDirective',
      isDeprecated: true,
      deprecationReason: 'Use another directive',
    });
  });
});
