import { expect } from "bun:test";
import { describe, test as it } from "bun:test";

import { parse } from "../../language/parser.ts";

import { getOperationAST } from '../get-operation-ast.ts';

describe('getOperationAST', () => {
  it('Gets an operation from a simple document', () => {
    const doc = parse('{ field }');
    expect(getOperationAST(doc)).toBe(doc.definitions[0]);
  });

  it('Gets an operation from a document with named op (mutation)', () => {
    const doc = parse('mutation Test { field }');
    expect(getOperationAST(doc)).toBe(doc.definitions[0]);
  });

  it('Gets an operation from a document with named op (subscription)', () => {
    const doc = parse('subscription Test { field }');
    expect(getOperationAST(doc)).toBe(doc.definitions[0]);
  });

  it('Does not get missing operation', () => {
    const doc = parse('type Foo { field: String }');
    expect(getOperationAST(doc)).toBe(null);
  });

  it('Does not get ambiguous unnamed operation', () => {
    const doc = parse(`
      { field }
      mutation Test { field }
      subscription TestSub { field }
    `);
    expect(getOperationAST(doc)).toBe(null);
  });

  it('Does not get ambiguous named operation', () => {
    const doc = parse(`
      query TestQ { field }
      mutation TestM { field }
      subscription TestS { field }
    `);
    expect(getOperationAST(doc)).toBe(null);
  });

  it('Does not get misnamed operation', () => {
    const doc = parse(`
      { field }

      query TestQ { field }
      mutation TestM { field }
      subscription TestS { field }
    `);
    expect(getOperationAST(doc, 'Unknown')).toBe(null);
  });

  it('Gets named operation', () => {
    const doc = parse(`
      query TestQ { field }
      mutation TestM { field }
      subscription TestS { field }
    `);
    expect(getOperationAST(doc, 'TestQ')).toBe(doc.definitions[0]);
    expect(getOperationAST(doc, 'TestM')).toBe(doc.definitions[1]);
    expect(getOperationAST(doc, 'TestS')).toBe(doc.definitions[2]);
  });
});
