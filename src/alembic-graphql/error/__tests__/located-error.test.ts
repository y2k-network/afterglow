import { expect } from "bun:test";
import { describe, test as it } from "bun:test";

import { GraphQLLocatedError, isGraphQLError } from '../graph-ql-error.ts';
import { locatedError } from '../located-error.ts';

describe('locatedError', () => {
  it('passes GraphQLError through', () => {
    const e = new GraphQLLocatedError('msg', { path: ['path', 3, 'to', 'field'] });

    expect(locatedError(e, [], [])).toEqual(e);
  });

  it('wraps non-errors', () => {
    const testObject = Object.freeze({});
    const error = locatedError(testObject, [], []);

    expect(error).toBeInstanceOf(GraphQLLocatedError);
    expect(isGraphQLError(error)).toBe(true);
    expect(error.originalError).toMatchObject({
      name: 'NonErrorThrown',
      thrownValue: testObject,
    });
  });

  it('passes GraphQLError-ish through', () => {
    const e = new Error();
    // @ts-expect-error
    e.locations = [];
    // @ts-expect-error
    e.path = [];
    // @ts-expect-error
    e.nodes = [];
    // @ts-expect-error
    e.source = null;
    // @ts-expect-error
    e.positions = [];
    e.name = 'GraphQLError';

    expect(locatedError(e, [], [])).toEqual(e);
  });

  it('does not pass through elasticsearch-like errors', () => {
    const e = new Error('I am from elasticsearch');
    // @ts-expect-error
    e.path = '/something/feed/_search';

    expect(locatedError(e, [], [])).not.toEqual(e);
  });
});
