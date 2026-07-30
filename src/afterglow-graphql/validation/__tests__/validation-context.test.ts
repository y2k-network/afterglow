import { expect } from "bun:test";
import { describe, test as it } from "bun:test";

import { identityFunc } from '../../jsutils/identity-func.ts';

import { parse } from '../../language/parser.ts';

import { GraphQLSchema } from '../../type/schema.ts';

import { TypeInfo } from '../../utilities/type-info.ts';

import {
  ASTValidationContext,
  SDLValidationContext,
  ValidationContext,
} from '../validation-context.ts';

describe('ValidationContext', () => {
  it('can be Object.toStringified', () => {
    const schema = new GraphQLSchema({});
    const typeInfo = new TypeInfo(schema);
    const ast = parse('{ foo }');
    const onError = identityFunc;

    const astContext = new ASTValidationContext(ast, onError);
    expect(Object.prototype.toString.call(astContext)).toBe(
      '[object ASTValidationContext]',
    );

    const sdlContext = new SDLValidationContext(ast, schema, onError);
    expect(Object.prototype.toString.call(sdlContext)).toBe(
      '[object SDLValidationContext]',
    );

    const context = new ValidationContext(schema, ast, typeInfo, onError);
    expect(Object.prototype.toString.call(context)).toBe(
      '[object ValidationContext]',
    );
  });
});
