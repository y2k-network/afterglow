// Spec Section: "Executable Definitions"
import { ExecutableDefinitionsRule } from './rules/executable-definitions-rule.ts';
// Spec Section: "Field Selections on Objects, Interfaces, and Unions Types"
import { FieldsOnCorrectTypeRule } from './rules/fields-on-correct-type-rule.ts';
// Spec Section: "Fragments on Composite Types"
import { FragmentsOnCompositeTypesRule } from './rules/fragments-on-composite-types-rule.ts';
// Spec Section: "Argument Names"
import {
  KnownArgumentNamesOnDirectivesRule,
  KnownArgumentNamesRule,
} from './rules/known-argument-names-rule.ts';
// Spec Section: "Directives Are Defined"
import { KnownDirectivesRule } from './rules/known-directives-rule.ts';
// Spec Section: "Fragment spread target defined"
import { KnownFragmentNamesRule } from './rules/known-fragment-names-rule.ts';
// Spec Section: "Fragment Spread Type Existence"
import { KnownTypeNamesRule } from './rules/known-type-names-rule.ts';
// Spec Section: "Lone Anonymous Operation"
import { LoneAnonymousOperationRule } from './rules/lone-anonymous-operation-rule.ts';
// SDL-specific validation rules
import { LoneSchemaDefinitionRule } from './rules/lone-schema-definition-rule.ts';
// TODO: Spec Section
import { MaxIntrospectionDepthRule } from './rules/max-introspection-depth-rule.ts';
// Spec Section: "Fragments must not form cycles"
import { NoFragmentCyclesRule } from './rules/no-fragment-cycles-rule.ts';
// Spec Section: "All Variable Used Defined"
import { NoUndefinedVariablesRule } from './rules/no-undefined-variables-rule.ts';
// Spec Section: "Fragments must be used"
import { NoUnusedFragmentsRule } from './rules/no-unused-fragments-rule.ts';
// Spec Section: "All Variables Used"
import { NoUnusedVariablesRule } from './rules/no-unused-variables-rule.ts';
// Spec Section: "Field Selection Merging"
import { OverlappingFieldsCanBeMergedRule } from './rules/overlapping-fields-can-be-merged-rule.ts';
// Spec Section: "Fragment spread is possible"
import { PossibleFragmentSpreadsRule } from './rules/possible-fragment-spreads-rule.ts';
import { PossibleTypeExtensionsRule } from './rules/possible-type-extensions-rule.ts';
// Spec Section: "Argument Optionality"
import {
  ProvidedRequiredArgumentsOnDirectivesRule,
  ProvidedRequiredArgumentsRule,
} from './rules/provided-required-arguments-rule.ts';
// Spec Section: "Leaf Field Selections"
import { ScalarLeafsRule } from './rules/scalar-leafs-rule.ts';
// Spec Section: "Subscriptions with Single Root Field"
import { SingleFieldSubscriptionsRule } from './rules/single-field-subscriptions-rule.ts';
import { UniqueArgumentDefinitionNamesRule } from './rules/unique-argument-definition-names-rule.ts';
// Spec Section: "Argument Uniqueness"
import { UniqueArgumentNamesRule } from './rules/unique-argument-names-rule.ts';
import { UniqueDirectiveNamesRule } from './rules/unique-directive-names-rule.ts';
// Spec Section: "Directives Are Unique Per Location"
import { UniqueDirectivesPerLocationRule } from './rules/unique-directives-per-location-rule.ts';
import { UniqueEnumValueNamesRule } from './rules/unique-enum-value-names-rule.ts';
import { UniqueFieldDefinitionNamesRule } from './rules/unique-field-definition-names-rule.ts';
// Spec Section: "Fragment Name Uniqueness"
import { UniqueFragmentNamesRule } from './rules/unique-fragment-names-rule.ts';
// Spec Section: "Input Object Field Uniqueness"
import { UniqueInputFieldNamesRule } from './rules/unique-input-field-names-rule.ts';
// Spec Section: "Operation Name Uniqueness"
import { UniqueOperationNamesRule } from './rules/unique-operation-names-rule.ts';
import { UniqueOperationTypesRule } from './rules/unique-operation-types-rule.ts';
import { UniqueTypeNamesRule } from './rules/unique-type-names-rule.ts';
// Spec Section: "Variable Uniqueness"
import { UniqueVariableNamesRule } from './rules/unique-variable-names-rule.ts';
// Spec Section: "Value Type Correctness"
import { ValuesOfCorrectTypeRule } from './rules/values-of-correct-type-rule.ts';
// Spec Section: "Variables are Input Types"
import { VariablesAreInputTypesRule } from './rules/variables-are-input-types-rule.ts';
// Spec Section: "All Variable Usages Are Allowed"
import { VariablesInAllowedPositionRule } from './rules/variables-in-allowed-position-rule.ts';
import type { SDLValidationRule, ValidationRule } from './validation-context.ts';

/**
 * Technically these aren't part of the spec but they are strongly encouraged
 * validation rules.
 */
export const recommendedRules = Object.freeze([MaxIntrospectionDepthRule]);

/**
 * This set includes all validation rules defined by the GraphQL spec.
 *
 * The order of the rules in this list has been adjusted to lead to the
 * most clear output when encountering multiple validation errors.
 */
export const specifiedRules: ReadonlyArray<ValidationRule> = Object.freeze([
  ExecutableDefinitionsRule,
  UniqueOperationNamesRule,
  LoneAnonymousOperationRule,
  SingleFieldSubscriptionsRule,
  KnownTypeNamesRule,
  FragmentsOnCompositeTypesRule,
  VariablesAreInputTypesRule,
  ScalarLeafsRule,
  FieldsOnCorrectTypeRule,
  UniqueFragmentNamesRule,
  KnownFragmentNamesRule,
  NoUnusedFragmentsRule,
  PossibleFragmentSpreadsRule,
  NoFragmentCyclesRule,
  UniqueVariableNamesRule,
  NoUndefinedVariablesRule,
  NoUnusedVariablesRule,
  KnownDirectivesRule,
  UniqueDirectivesPerLocationRule,
  KnownArgumentNamesRule,
  UniqueArgumentNamesRule,
  ValuesOfCorrectTypeRule,
  ProvidedRequiredArgumentsRule,
  VariablesInAllowedPositionRule,
  OverlappingFieldsCanBeMergedRule,
  UniqueInputFieldNamesRule,
  ...recommendedRules,
]);

/**
 * @internal
 */
export const specifiedSDLRules: ReadonlyArray<SDLValidationRule> =
  Object.freeze([
    LoneSchemaDefinitionRule,
    UniqueOperationTypesRule,
    UniqueTypeNamesRule,
    UniqueEnumValueNamesRule,
    UniqueFieldDefinitionNamesRule,
    UniqueArgumentDefinitionNamesRule,
    UniqueDirectiveNamesRule,
    KnownTypeNamesRule,
    KnownDirectivesRule,
    UniqueDirectivesPerLocationRule,
    PossibleTypeExtensionsRule,
    KnownArgumentNamesOnDirectivesRule,
    UniqueArgumentNamesRule,
    UniqueInputFieldNamesRule,
    ProvidedRequiredArgumentsOnDirectivesRule,
  ]);
