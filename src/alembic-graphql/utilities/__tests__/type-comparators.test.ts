import { expect } from "bun:test";
import { describe, test as it } from "bun:test";

import type { GraphQLFieldConfigMap } from "../../type/definition.ts";
import {
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLUnionType,
} from "../../type/definition.ts";
import { GraphQLFloat, GraphQLInt, GraphQLString } from "../../type/scalars.ts";
import { GraphQLSchema } from "../../type/schema.ts";

import { isEqualType, isTypeSubTypeOf } from '../type-comparators.ts';

describe('typeComparators', () => {
  describe('isEqualType', () => {
    it('same reference are equal', () => {
      expect(isEqualType(GraphQLString, GraphQLString)).toBe(true);
    });

    it('int and float are not equal', () => {
      expect(isEqualType(GraphQLInt, GraphQLFloat)).toBe(false);
    });

    it('lists of same type are equal', () => {
      expect(
        isEqualType(new GraphQLList(GraphQLInt), new GraphQLList(GraphQLInt)),
      ).toBe(true);
    });

    it('lists is not equal to item', () => {
      expect(isEqualType(new GraphQLList(GraphQLInt), GraphQLInt)).toBe(
        false,
      );
    });

    it('non-null of same type are equal', () => {
      expect(
        isEqualType(
          new GraphQLNonNull(GraphQLInt),
          new GraphQLNonNull(GraphQLInt),
        ),
      ).toBe(true);
    });

    it('non-null is not equal to nullable', () => {
      expect(isEqualType(new GraphQLNonNull(GraphQLInt), GraphQLInt)).toBe(
        false,
      );
    });
  });

  describe('isTypeSubTypeOf', () => {
    function testSchema(fields: GraphQLFieldConfigMap<unknown, unknown>) {
      return new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields,
        }),
      });
    }

    it('same reference is subtype', () => {
      const schema = testSchema({ field: { type: GraphQLString } });
      expect(isTypeSubTypeOf(schema, GraphQLString, GraphQLString)).toBe(
        true,
      );
    });

    it('int is not subtype of float', () => {
      const schema = testSchema({ field: { type: GraphQLString } });
      expect(isTypeSubTypeOf(schema, GraphQLInt, GraphQLFloat)).toBe(false);
    });

    it('non-null is subtype of nullable', () => {
      const schema = testSchema({ field: { type: GraphQLString } });
      expect(
        isTypeSubTypeOf(schema, new GraphQLNonNull(GraphQLInt), GraphQLInt),
      ).toBe(true);
    });

    it('nullable is not subtype of non-null', () => {
      const schema = testSchema({ field: { type: GraphQLString } });
      expect(
        isTypeSubTypeOf(schema, GraphQLInt, new GraphQLNonNull(GraphQLInt)),
      ).toBe(false);
    });

    it('item is not subtype of list', () => {
      const schema = testSchema({ field: { type: GraphQLString } });
      expect(
        isTypeSubTypeOf(schema, GraphQLInt, new GraphQLList(GraphQLInt)),
      ).toBe(false);
    });

    it('list is not subtype of item', () => {
      const schema = testSchema({ field: { type: GraphQLString } });
      expect(
        isTypeSubTypeOf(schema, new GraphQLList(GraphQLInt), GraphQLInt),
      ).toBe(false);
    });

    it('member is subtype of union', () => {
      const member = new GraphQLObjectType({
        name: 'Object',
        fields: {
          field: { type: GraphQLString },
        },
      });
      const union = new GraphQLUnionType({ name: 'Union', types: [member] });
      const schema = testSchema({ field: { type: union } });
      expect(isTypeSubTypeOf(schema, member, union)).toBe(true);
    });

    it('implementing object is subtype of interface', () => {
      const iface = new GraphQLInterfaceType({
        name: 'Interface',
        fields: {
          field: { type: GraphQLString },
        },
      });
      const impl = new GraphQLObjectType({
        name: 'Object',
        interfaces: [iface],
        fields: {
          field: { type: GraphQLString },
        },
      });
      const schema = testSchema({ field: { type: impl } });
      expect(isTypeSubTypeOf(schema, impl, iface)).toBe(true);
    });

    it('implementing interface is subtype of interface', () => {
      const iface = new GraphQLInterfaceType({
        name: 'Interface',
        fields: {
          field: { type: GraphQLString },
        },
      });
      const iface2 = new GraphQLInterfaceType({
        name: 'Interface2',
        interfaces: [iface],
        fields: {
          field: { type: GraphQLString },
        },
      });
      const impl = new GraphQLObjectType({
        name: 'Object',
        interfaces: [iface2, iface],
        fields: {
          field: { type: GraphQLString },
        },
      });
      const schema = testSchema({ field: { type: impl } });
      expect(isTypeSubTypeOf(schema, iface2, iface)).toBe(true);
    });
  });
});
