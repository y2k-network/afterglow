import { expect } from "bun:test";
import { describe, test as it } from "bun:test";

import { dedent, dedentString } from '../../__testUtils__/dedent.ts';
import { kitchenSinkQuery } from '../../__testUtils__/kitchen-sink-query.ts';

import { Kind } from '../kinds.ts';
import { parseSync as parse, parseSchemaCoordinateSync as parseSchemaCoordinate } from '../parser.ts';
import { print } from '../printer.ts';

describe('Printer: Query document', () => {
  it('prints minimal ast', () => {
    const ast = {
      kind: Kind.FIELD,
      name: { kind: Kind.NAME, value: 'foo' },
    } as const;
    expect(print(ast)).toBe('foo');
  });

  it('produces helpful error messages', () => {
    const badAST = { random: 'Data' };

    // @ts-expect-error
    expect(() => print(badAST)).toThrow(
      'Invalid AST Node: { random: "Data" }.',
    );
  });

  it('correctly prints non-query operations without name', () => {
    const queryASTShorthanded = parse('query { id, name }');
    expect(print(queryASTShorthanded)).toBe(dedent`
      {
        id
        name
      }
    `);

    const mutationAST = parse('mutation { id, name }');
    expect(print(mutationAST)).toBe(dedent`
      mutation {
        id
        name
      }
    `);

    const queryASTWithArtifacts = parse(
      'query ($foo: TestType) @testDirective { id, name }',
    );
    expect(print(queryASTWithArtifacts)).toBe(dedent`
      query ($foo: TestType) @testDirective {
        id
        name
      }
    `);

    const mutationASTWithArtifacts = parse(
      'mutation ($foo: TestType) @testDirective { id, name }',
    );
    expect(print(mutationASTWithArtifacts)).toBe(dedent`
      mutation ($foo: TestType) @testDirective {
        id
        name
      }
    `);
  });

  it('prints query with variable directives', () => {
    const queryASTWithVariableDirective = parse(
      'query ($foo: TestType = {a: 123} @testDirective(if: true) @test) { id }',
    );
    expect(print(queryASTWithVariableDirective)).toBe(dedent`
      query ($foo: TestType = {a: 123} @testDirective(if: true) @test) {
        id
      }
    `);
  });

  it('keeps arguments on one line if line is short (<= 80 chars)', () => {
    const printed = print(
      parse('{trip(wheelchair:false arriveBy:false){dateTime}}'),
    );

    expect(printed).toBe(dedent`
      {
        trip(wheelchair: false, arriveBy: false) {
          dateTime
        }
      }
    `);
  });

  it('puts arguments on multiple lines if line is long (> 80 chars)', () => {
    const printed = print(
      parse(
        '{trip(wheelchair:false arriveBy:false includePlannedCancellations:true transitDistanceReluctance:2000){dateTime}}',
      ),
    );

    expect(printed).toBe(dedent`
      {
        trip(
          wheelchair: false
          arriveBy: false
          includePlannedCancellations: true
          transitDistanceReluctance: 2000
        ) {
          dateTime
        }
      }
    `);
  });

  it('Legacy: prints fragment with variable directives', () => {
    const queryASTWithVariableDirective = parse(
      'fragment Foo($foo: TestType @test) on TestType @testDirective { id }',
      { allowLegacyFragmentVariables: true },
    );
    expect(print(queryASTWithVariableDirective)).toBe(dedent`
      fragment Foo($foo: TestType @test) on TestType @testDirective {
        id
      }
    `);
  });

  it('Experimental: prints directives on directives', () => {
    const queryASTWithVariableDirective = parse(
      `
      directive @foo @bar on FIELD_DEFINITION
      extend directive @foo @baz
      `,
      { experimentalDirectivesOnDirectiveDefinitions: true },
    );
    expect(print(queryASTWithVariableDirective)).toBe(dedent`
      directive @foo @bar on FIELD_DEFINITION
      
      extend directive @foo @baz
    `);
  });

  it('Legacy: correctly prints fragment defined variables', () => {
    const fragmentWithVariable = parse(
      `
        fragment Foo($a: ComplexType, $b: Boolean = false) on TestType {
          id
        }
      `,
      { allowLegacyFragmentVariables: true },
    );
    expect(print(fragmentWithVariable)).toBe(dedent`
      fragment Foo($a: ComplexType, $b: Boolean = false) on TestType {
        id
      }
    `);
  });

  it('prints fragment', () => {
    const printed = print(
      parse('"Fragment description" fragment Foo on Bar { baz }'),
    );

    expect(printed).toBe(dedent`
      "Fragment description"
      fragment Foo on Bar {
        baz
      }
    `);
  });

  it('prints kitchen sink without altering ast', () => {
    const ast = parse(kitchenSinkQuery, { noLocation: true });

    const astBeforePrintCall = JSON.stringify(ast);
    const printed = print(ast);
    const printedAST = parse(printed, { noLocation: true });

    expect(printedAST).toEqual(ast);
    expect(JSON.stringify(ast)).toBe(astBeforePrintCall);

    expect(printed).toBe(
      dedentString(String.raw`
      "Query description"
      query queryName(
      "Very complex variable"
      $foo: ComplexType
      $site: Site = MOBILE
      ) @onQuery {
        whoever123is: node(id: [123, 456]) {
          id
          ... on User @onInlineFragment {
            field2 {
              id
              alias: field1(first: 10, after: $foo) @include(if: $foo) {
                id
                ...frag @onFragmentSpread
              }
            }
          }
          ... @skip(unless: $foo) {
            id
          }
          ... {
            id
          }
        }
      }

      mutation likeStory @onMutation {
        like(story: 123) @onField {
          story {
            id @onField
          }
        }
      }

      subscription StoryLikeSubscription($input: StoryLikeSubscribeInput @onVariableDefinition) @onSubscription {
        storyLikeSubscribe(input: $input) {
          story {
            likers {
              count
            }
            likeSentence {
              text
            }
          }
        }
      }

      """Fragment description"""
      fragment frag on Friend @onFragmentDefinition {
        foo(
          size: $size
          bar: $b
          obj: {key: "value", block: """
          block string uses \"""
          """}
        )
      }

      {
        unnamed(truthy: true, falsy: false, nullish: null)
        query
      }

      {
        __typename
      }
    `),
    );
  });

  it('prints schema coordinates', () => {
    expect(print(parseSchemaCoordinate('Name'))).toBe('Name');
    expect(print(parseSchemaCoordinate('Name.field'))).toBe('Name.field');
    expect(print(parseSchemaCoordinate('Name.field(arg:)'))).toBe(
      'Name.field(arg:)',
    );
    expect(print(parseSchemaCoordinate('@name'))).toBe('@name');
    expect(print(parseSchemaCoordinate('@name(arg:)'))).toBe('@name(arg:)');
    expect(print(parseSchemaCoordinate('__Type'))).toBe('__Type');
    expect(print(parseSchemaCoordinate('Type.__metafield'))).toBe(
      'Type.__metafield',
    );
    expect(print(parseSchemaCoordinate('Type.__metafield(arg:)'))).toBe(
      'Type.__metafield(arg:)',
    );
  });

  it('throws syntax error for ignored tokens in schema coordinates', () => {
    expect(() => print(parseSchemaCoordinate('# foo\nName'))).toThrow(
      'Syntax Error: Invalid character: "#"',
    );
    expect(() => print(parseSchemaCoordinate('\nName'))).toThrow(
      'Syntax Error: Invalid character: U+000A.',
    );
    expect(() => print(parseSchemaCoordinate('Name .field'))).toThrow(
      'Syntax Error: Invalid character: " "',
    );
  });
});
