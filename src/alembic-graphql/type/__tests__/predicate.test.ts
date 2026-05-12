import { expect } from "bun:test";
import { describe, test as it } from "bun:test";

import { DirectiveLocation } from '../../language/directive-location.ts';

import type {
  GraphQLArgument,
  GraphQLInputField,
  GraphQLInputType,
} from '../definition.ts';
import {
  assertAbstractType,
  assertCompositeType,
  assertEnumType,
  assertInputObjectType,
  assertInputType,
  assertInterfaceType,
  assertLeafType,
  assertListType,
  assertNamedType,
  assertNonNullType,
  assertNullableType,
  assertObjectType,
  assertOutputType,
  assertScalarType,
  assertType,
  assertUnionType,
  assertWrappingType,
  getNamedType,
  getNullableType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLUnionType,
  isAbstractType,
  isCompositeType,
  isEnumType,
  isInputObjectType,
  isInputType,
  isInterfaceType,
  isLeafType,
  isListType,
  isNamedType,
  isNonNullType,
  isNullableType,
  isObjectType,
  isOutputType,
  isRequiredArgument,
  isRequiredInputField,
  isScalarType,
  isType,
  isUnionType,
  isWrappingType,
} from '../definition.ts';
import {
  assertDirective,
  GraphQLDeprecatedDirective,
  GraphQLDirective,
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
  isDirective,
  isSpecifiedDirective,
} from '../directives.ts';
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLString,
  isSpecifiedScalarType,
} from '../scalars.ts';

const ObjectType = new GraphQLObjectType({ name: 'Object', fields: {} });
const InterfaceType = new GraphQLInterfaceType({
  name: 'Interface',
  fields: {},
});
const UnionType = new GraphQLUnionType({ name: 'Union', types: [ObjectType] });
const EnumType = new GraphQLEnumType({ name: 'Enum', values: { foo: {} } });
const InputObjectType = new GraphQLInputObjectType({
  name: 'InputObject',
  fields: {},
});
const ScalarType = new GraphQLScalarType({ name: 'Scalar' });
const Directive = new GraphQLDirective({
  name: 'Directive',
  locations: [DirectiveLocation.QUERY],
});

describe('Type predicates', () => {
  describe('isType', () => {
    it('returns true for unwrapped types', () => {
      expect(isType(GraphQLString)).toBe(true);
      expect(() => assertType(GraphQLString)).not.toThrow();
      expect(isType(ObjectType)).toBe(true);
      expect(() => assertType(ObjectType)).not.toThrow();
    });

    it('returns true for wrapped types', () => {
      expect(isType(new GraphQLNonNull(GraphQLString))).toBe(true);
      expect(() =>
        assertType(new GraphQLNonNull(GraphQLString)),
      ).not.toThrow();
    });

    it('returns false for type classes (rather than instances)', () => {
      expect(isType(GraphQLObjectType)).toBe(false);
      expect(() => assertType(GraphQLObjectType)).toThrow();
    });

    it('returns false for random garbage', () => {
      expect(isType({ what: 'is this' })).toBe(false);
      expect(() => assertType({ what: 'is this' })).toThrow();
    });
  });

  describe('isScalarType', () => {
    it('returns true for spec defined scalar', () => {
      expect(isScalarType(GraphQLString)).toBe(true);
      expect(() => assertScalarType(GraphQLString)).not.toThrow();
    });

    it('returns true for custom scalar', () => {
      expect(isScalarType(ScalarType)).toBe(true);
      expect(() => assertScalarType(ScalarType)).not.toThrow();
    });

    it('returns false for scalar class (rather than instance)', () => {
      expect(isScalarType(GraphQLScalarType)).toBe(false);
      expect(() => assertScalarType(GraphQLScalarType)).toThrow();
    });

    it('returns false for wrapped scalar', () => {
      expect(isScalarType(new GraphQLList(ScalarType))).toBe(false);
      expect(() => assertScalarType(new GraphQLList(ScalarType))).toThrow();
    });

    it('returns false for non-scalar', () => {
      expect(isScalarType(EnumType)).toBe(false);
      expect(() => assertScalarType(EnumType)).toThrow();
      expect(isScalarType(Directive)).toBe(false);
      expect(() => assertScalarType(Directive)).toThrow();
    });

    it('returns false for random garbage', () => {
      expect(isScalarType({ what: 'is this' })).toBe(false);
      expect(() => assertScalarType({ what: 'is this' })).toThrow();
    });
  });

  describe('isSpecifiedScalarType', () => {
    it('returns true for specified scalars', () => {
      expect(isSpecifiedScalarType(GraphQLString)).toBe(true);
      expect(isSpecifiedScalarType(GraphQLInt)).toBe(true);
      expect(isSpecifiedScalarType(GraphQLFloat)).toBe(true);
      expect(isSpecifiedScalarType(GraphQLBoolean)).toBe(true);
      expect(isSpecifiedScalarType(GraphQLID)).toBe(true);
    });

    it('returns false for custom scalar', () => {
      expect(isSpecifiedScalarType(ScalarType)).toBe(false);
    });
  });

  describe('isObjectType', () => {
    it('returns true for object type', () => {
      expect(isObjectType(ObjectType)).toBe(true);
      expect(() => assertObjectType(ObjectType)).not.toThrow();
    });

    it('returns false for wrapped object type', () => {
      expect(isObjectType(new GraphQLList(ObjectType))).toBe(false);
      expect(() => assertObjectType(new GraphQLList(ObjectType))).toThrow();
    });

    it('returns false for non-object type', () => {
      expect(isObjectType(InterfaceType)).toBe(false);
      expect(() => assertObjectType(InterfaceType)).toThrow();
    });
  });

  describe('isInterfaceType', () => {
    it('returns true for interface type', () => {
      expect(isInterfaceType(InterfaceType)).toBe(true);
      expect(() => assertInterfaceType(InterfaceType)).not.toThrow();
    });

    it('returns false for wrapped interface type', () => {
      expect(isInterfaceType(new GraphQLList(InterfaceType))).toBe(false);
      expect(() =>
        assertInterfaceType(new GraphQLList(InterfaceType)),
      ).toThrow();
    });

    it('returns false for non-interface type', () => {
      expect(isInterfaceType(ObjectType)).toBe(false);
      expect(() => assertInterfaceType(ObjectType)).toThrow();
    });
  });

  describe('isUnionType', () => {
    it('returns true for union type', () => {
      expect(isUnionType(UnionType)).toBe(true);
      expect(() => assertUnionType(UnionType)).not.toThrow();
    });

    it('returns false for wrapped union type', () => {
      expect(isUnionType(new GraphQLList(UnionType))).toBe(false);
      expect(() => assertUnionType(new GraphQLList(UnionType))).toThrow();
    });

    it('returns false for non-union type', () => {
      expect(isUnionType(ObjectType)).toBe(false);
      expect(() => assertUnionType(ObjectType)).toThrow();
    });
  });

  describe('isEnumType', () => {
    it('returns true for enum type', () => {
      expect(isEnumType(EnumType)).toBe(true);
      expect(() => assertEnumType(EnumType)).not.toThrow();
    });

    it('returns false for wrapped enum type', () => {
      expect(isEnumType(new GraphQLList(EnumType))).toBe(false);
      expect(() => assertEnumType(new GraphQLList(EnumType))).toThrow();
    });

    it('returns false for non-enum type', () => {
      expect(isEnumType(ScalarType)).toBe(false);
      expect(() => assertEnumType(ScalarType)).toThrow();
    });
  });

  describe('isInputObjectType', () => {
    it('returns true for input object type', () => {
      expect(isInputObjectType(InputObjectType)).toBe(true);
      expect(() => assertInputObjectType(InputObjectType)).not.toThrow();
    });

    it('returns false for wrapped input object type', () => {
      expect(isInputObjectType(new GraphQLList(InputObjectType))).toBe(
        false,
      );
      expect(() =>
        assertInputObjectType(new GraphQLList(InputObjectType)),
      ).toThrow();
    });

    it('returns false for non-input-object type', () => {
      expect(isInputObjectType(ObjectType)).toBe(false);
      expect(() => assertInputObjectType(ObjectType)).toThrow();
    });
  });

  describe('isListType', () => {
    it('returns true for a list wrapped type', () => {
      expect(isListType(new GraphQLList(ObjectType))).toBe(true);
      expect(() => assertListType(new GraphQLList(ObjectType))).not.toThrow();
    });

    it('returns false for an unwrapped type', () => {
      expect(isListType(ObjectType)).toBe(false);
      expect(() => assertListType(ObjectType)).toThrow();
    });

    it('returns false for a non-list wrapped type', () => {
      expect(
        isListType(new GraphQLNonNull(new GraphQLList(ObjectType))),
      ).toBe(false);
      expect(() =>
        assertListType(new GraphQLNonNull(new GraphQLList(ObjectType))),
      ).toThrow();
    });
  });

  describe('isNonNullType', () => {
    it('returns true for a non-null wrapped type', () => {
      expect(isNonNullType(new GraphQLNonNull(ObjectType))).toBe(true);
      expect(() =>
        assertNonNullType(new GraphQLNonNull(ObjectType)),
      ).not.toThrow();
    });

    it('returns false for an unwrapped type', () => {
      expect(isNonNullType(ObjectType)).toBe(false);
      expect(() => assertNonNullType(ObjectType)).toThrow();
    });

    it('returns false for a not non-null wrapped type', () => {
      expect(
        isNonNullType(new GraphQLList(new GraphQLNonNull(ObjectType))),
      ).toBe(false);
      expect(() =>
        assertNonNullType(new GraphQLList(new GraphQLNonNull(ObjectType))),
      ).toThrow();
    });
  });

  describe('isInputType', () => {
    function expectInputType(type: unknown) {
      expect(isInputType(type)).toBe(true);
      expect(() => assertInputType(type)).not.toThrow();
    }

    it('returns true for an input type', () => {
      expectInputType(GraphQLString);
      expectInputType(EnumType);
      expectInputType(InputObjectType);
    });

    it('returns true for a wrapped input type', () => {
      expectInputType(new GraphQLList(GraphQLString));
      expectInputType(new GraphQLList(EnumType));
      expectInputType(new GraphQLList(InputObjectType));

      expectInputType(new GraphQLNonNull(GraphQLString));
      expectInputType(new GraphQLNonNull(EnumType));
      expectInputType(new GraphQLNonNull(InputObjectType));
    });

    function expectNonInputType(type: unknown) {
      expect(isInputType(type)).toBe(false);
      expect(() => assertInputType(type)).toThrow();
    }

    it('returns false for an output type', () => {
      expectNonInputType(ObjectType);
      expectNonInputType(InterfaceType);
      expectNonInputType(UnionType);
    });

    it('returns false for a wrapped output type', () => {
      expectNonInputType(new GraphQLList(ObjectType));
      expectNonInputType(new GraphQLList(InterfaceType));
      expectNonInputType(new GraphQLList(UnionType));

      expectNonInputType(new GraphQLNonNull(ObjectType));
      expectNonInputType(new GraphQLNonNull(InterfaceType));
      expectNonInputType(new GraphQLNonNull(UnionType));
    });
  });

  describe('isOutputType', () => {
    function expectOutputType(type: unknown) {
      expect(isOutputType(type)).toBe(true);
      expect(() => assertOutputType(type)).not.toThrow();
    }

    it('returns true for an output type', () => {
      expectOutputType(GraphQLString);
      expectOutputType(ObjectType);
      expectOutputType(InterfaceType);
      expectOutputType(UnionType);
      expectOutputType(EnumType);
    });

    it('returns true for a wrapped output type', () => {
      expectOutputType(new GraphQLList(GraphQLString));
      expectOutputType(new GraphQLList(ObjectType));
      expectOutputType(new GraphQLList(InterfaceType));
      expectOutputType(new GraphQLList(UnionType));
      expectOutputType(new GraphQLList(EnumType));

      expectOutputType(new GraphQLNonNull(GraphQLString));
      expectOutputType(new GraphQLNonNull(ObjectType));
      expectOutputType(new GraphQLNonNull(InterfaceType));
      expectOutputType(new GraphQLNonNull(UnionType));
      expectOutputType(new GraphQLNonNull(EnumType));
    });

    function expectNonOutputType(type: unknown) {
      expect(isOutputType(type)).toBe(false);
      expect(() => assertOutputType(type)).toThrow();
    }

    it('returns false for an input type', () => {
      expectNonOutputType(InputObjectType);
    });

    it('returns false for a wrapped input type', () => {
      expectNonOutputType(new GraphQLList(InputObjectType));
      expectNonOutputType(new GraphQLNonNull(InputObjectType));
    });
  });

  describe('isLeafType', () => {
    it('returns true for scalar and enum types', () => {
      expect(isLeafType(ScalarType)).toBe(true);
      expect(() => assertLeafType(ScalarType)).not.toThrow();
      expect(isLeafType(EnumType)).toBe(true);
      expect(() => assertLeafType(EnumType)).not.toThrow();
    });

    it('returns false for wrapped leaf type', () => {
      expect(isLeafType(new GraphQLList(ScalarType))).toBe(false);
      expect(() => assertLeafType(new GraphQLList(ScalarType))).toThrow();
    });

    it('returns false for non-leaf type', () => {
      expect(isLeafType(ObjectType)).toBe(false);
      expect(() => assertLeafType(ObjectType)).toThrow();
    });

    it('returns false for wrapped non-leaf type', () => {
      expect(isLeafType(new GraphQLList(ObjectType))).toBe(false);
      expect(() => assertLeafType(new GraphQLList(ObjectType))).toThrow();
    });
  });

  describe('isCompositeType', () => {
    it('returns true for object, interface, and union types', () => {
      expect(isCompositeType(ObjectType)).toBe(true);
      expect(() => assertCompositeType(ObjectType)).not.toThrow();
      expect(isCompositeType(InterfaceType)).toBe(true);
      expect(() => assertCompositeType(InterfaceType)).not.toThrow();
      expect(isCompositeType(UnionType)).toBe(true);
      expect(() => assertCompositeType(UnionType)).not.toThrow();
    });

    it('returns false for wrapped composite type', () => {
      expect(isCompositeType(new GraphQLList(ObjectType))).toBe(false);
      expect(() => assertCompositeType(new GraphQLList(ObjectType))).toThrow();
    });

    it('returns false for non-composite type', () => {
      expect(isCompositeType(InputObjectType)).toBe(false);
      expect(() => assertCompositeType(InputObjectType)).toThrow();
    });

    it('returns false for wrapped non-composite type', () => {
      expect(isCompositeType(new GraphQLList(InputObjectType))).toBe(false);
      expect(() =>
        assertCompositeType(new GraphQLList(InputObjectType)),
      ).toThrow();
    });
  });

  describe('isAbstractType', () => {
    it('returns true for interface and union types', () => {
      expect(isAbstractType(InterfaceType)).toBe(true);
      expect(() => assertAbstractType(InterfaceType)).not.toThrow();
      expect(isAbstractType(UnionType)).toBe(true);
      expect(() => assertAbstractType(UnionType)).not.toThrow();
    });

    it('returns false for wrapped abstract type', () => {
      expect(isAbstractType(new GraphQLList(InterfaceType))).toBe(false);
      expect(() =>
        assertAbstractType(new GraphQLList(InterfaceType)),
      ).toThrow();
    });

    it('returns false for non-abstract type', () => {
      expect(isAbstractType(ObjectType)).toBe(false);
      expect(() => assertAbstractType(ObjectType)).toThrow();
    });

    it('returns false for wrapped non-abstract type', () => {
      expect(isAbstractType(new GraphQLList(ObjectType))).toBe(false);
      expect(() => assertAbstractType(new GraphQLList(ObjectType))).toThrow();
    });
  });

  describe('isWrappingType', () => {
    it('returns true for list and non-null types', () => {
      expect(isWrappingType(new GraphQLList(ObjectType))).toBe(true);
      expect(() =>
        assertWrappingType(new GraphQLList(ObjectType)),
      ).not.toThrow();
      expect(isWrappingType(new GraphQLNonNull(ObjectType))).toBe(true);
      expect(() =>
        assertWrappingType(new GraphQLNonNull(ObjectType)),
      ).not.toThrow();
    });

    it('returns false for unwrapped types', () => {
      expect(isWrappingType(ObjectType)).toBe(false);
      expect(() => assertWrappingType(ObjectType)).toThrow();
    });
  });

  describe('isNullableType', () => {
    it('returns true for unwrapped types', () => {
      expect(isNullableType(ObjectType)).toBe(true);
      expect(() => assertNullableType(ObjectType)).not.toThrow();
    });

    it('returns true for list of non-null types', () => {
      expect(
        isNullableType(new GraphQLList(new GraphQLNonNull(ObjectType))),
      ).toBe(true);
      expect(() =>
        assertNullableType(new GraphQLList(new GraphQLNonNull(ObjectType))),
      ).not.toThrow();
    });

    it('returns false for non-null types', () => {
      expect(isNullableType(new GraphQLNonNull(ObjectType))).toBe(false);
      expect(() =>
        assertNullableType(new GraphQLNonNull(ObjectType)),
      ).toThrow();
    });
  });

  describe('getNullableType', () => {
    it('returns undefined for no type', () => {
      expect(getNullableType(undefined)).toBe(undefined);
      expect(getNullableType(null)).toBe(undefined);
    });

    it('returns self for a nullable type', () => {
      expect(getNullableType(ObjectType)).toBe(ObjectType);
      const listOfObj = new GraphQLList(ObjectType);
      expect(getNullableType(listOfObj)).toBe(listOfObj);
    });

    it('unwraps non-null type', () => {
      expect(getNullableType(new GraphQLNonNull(ObjectType))).toBe(
        ObjectType,
      );
    });
  });

  describe('isNamedType', () => {
    it('returns true for unwrapped types', () => {
      expect(isNamedType(ObjectType)).toBe(true);
      expect(() => assertNamedType(ObjectType)).not.toThrow();
    });

    it('returns false for list and non-null types', () => {
      expect(isNamedType(new GraphQLList(ObjectType))).toBe(false);
      expect(() => assertNamedType(new GraphQLList(ObjectType))).toThrow();
      expect(isNamedType(new GraphQLNonNull(ObjectType))).toBe(false);
      expect(() => assertNamedType(new GraphQLNonNull(ObjectType))).toThrow();
    });
  });

  describe('getNamedType', () => {
    it('returns undefined for no type', () => {
      expect(getNamedType(undefined)).toBe(undefined);
      expect(getNamedType(null)).toBe(undefined);
    });

    it('returns self for a unwrapped type', () => {
      expect(getNamedType(ObjectType)).toBe(ObjectType);
    });

    it('unwraps wrapper types', () => {
      expect(getNamedType(new GraphQLNonNull(ObjectType))).toBe(ObjectType);
      expect(getNamedType(new GraphQLList(ObjectType))).toBe(ObjectType);
    });

    it('unwraps deeply wrapper types', () => {
      expect(
        getNamedType(
          new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ObjectType))),
        ),
      ).toBe(ObjectType);
    });
  });

  describe('isRequiredArgument', () => {
    function buildArg(config: {
      type: GraphQLInputType;
      defaultValue?: unknown;
    }): GraphQLArgument {
      return {
        name: 'someArg',
        type: config.type,
        description: undefined,
        defaultValue: config.defaultValue,
        deprecationReason: null,
        extensions: Object.create(null),
        astNode: undefined,
      };
    }

    it('returns true for required arguments', () => {
      const requiredArg = buildArg({
        type: new GraphQLNonNull(GraphQLString),
      });
      expect(isRequiredArgument(requiredArg)).toBe(true);
    });

    it('returns false for optional arguments', () => {
      const optArg1 = buildArg({
        type: GraphQLString,
      });
      expect(isRequiredArgument(optArg1)).toBe(false);

      const optArg2 = buildArg({
        type: GraphQLString,
        defaultValue: null,
      });
      expect(isRequiredArgument(optArg2)).toBe(false);

      const optArg3 = buildArg({
        type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
      });
      expect(isRequiredArgument(optArg3)).toBe(false);

      const optArg4 = buildArg({
        type: new GraphQLNonNull(GraphQLString),
        defaultValue: 'default',
      });
      expect(isRequiredArgument(optArg4)).toBe(false);
    });
  });

  describe('isRequiredInputField', () => {
    function buildInputField(config: {
      type: GraphQLInputType;
      defaultValue?: unknown;
    }): GraphQLInputField {
      return {
        name: 'someInputField',
        type: config.type,
        description: undefined,
        defaultValue: config.defaultValue,
        deprecationReason: null,
        extensions: Object.create(null),
        astNode: undefined,
      };
    }

    it('returns true for required input field', () => {
      const requiredField = buildInputField({
        type: new GraphQLNonNull(GraphQLString),
      });
      expect(isRequiredInputField(requiredField)).toBe(true);
    });

    it('returns false for optional input field', () => {
      const optField1 = buildInputField({
        type: GraphQLString,
      });
      expect(isRequiredInputField(optField1)).toBe(false);

      const optField2 = buildInputField({
        type: GraphQLString,
        defaultValue: null,
      });
      expect(isRequiredInputField(optField2)).toBe(false);

      const optField3 = buildInputField({
        type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
      });
      expect(isRequiredInputField(optField3)).toBe(false);

      const optField4 = buildInputField({
        type: new GraphQLNonNull(GraphQLString),
        defaultValue: 'default',
      });
      expect(isRequiredInputField(optField4)).toBe(false);
    });
  });
});

describe('Directive predicates', () => {
  describe('isDirective', () => {
    it('returns true for spec defined directive', () => {
      expect(isDirective(GraphQLSkipDirective)).toBe(true);
      expect(() => assertDirective(GraphQLSkipDirective)).not.toThrow();
    });

    it('returns true for custom directive', () => {
      expect(isDirective(Directive)).toBe(true);
      expect(() => assertDirective(Directive)).not.toThrow();
    });

    it('returns false for directive class (rather than instance)', () => {
      expect(isDirective(GraphQLDirective)).toBe(false);
      expect(() => assertDirective(GraphQLDirective)).toThrow();
    });

    it('returns false for non-directive', () => {
      expect(isDirective(EnumType)).toBe(false);
      expect(() => assertDirective(EnumType)).toThrow();
      expect(isDirective(ScalarType)).toBe(false);
      expect(() => assertDirective(ScalarType)).toThrow();
    });

    it('returns false for random garbage', () => {
      expect(isDirective({ what: 'is this' })).toBe(false);
      expect(() => assertDirective({ what: 'is this' })).toThrow();
    });
  });
  describe('isSpecifiedDirective', () => {
    it('returns true for specified directives', () => {
      expect(isSpecifiedDirective(GraphQLIncludeDirective)).toBe(true);
      expect(isSpecifiedDirective(GraphQLSkipDirective)).toBe(true);
      expect(isSpecifiedDirective(GraphQLDeprecatedDirective)).toBe(true);
    });

    it('returns false for custom directive', () => {
      expect(isSpecifiedDirective(Directive)).toBe(false);
    });
  });
});
