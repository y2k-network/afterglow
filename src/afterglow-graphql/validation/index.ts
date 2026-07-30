export { validate } from './validate.ts';

export { ValidationContext } from './validation-context.ts';
export type { ValidationRule } from './validation-context.ts';

// All validation rules in the GraphQL Specification.
export { specifiedRules, recommendedRules } from './specified-rules.ts';

// Spec Section: "Executable Definitions"
export { ExecutableDefinitionsRule } from './rules/executable-definitions-rule.ts';

// Spec Section: "Field Selections on Objects, Interfaces, and Unions Types"
export { FieldsOnCorrectTypeRule } from './rules/fields-on-correct-type-rule.ts';

// Spec Section: "Fragments on Composite Types"
export { FragmentsOnCompositeTypesRule } from './rules/fragments-on-composite-types-rule.ts';

// Spec Section: "Argument Names"
export { KnownArgumentNamesRule } from './rules/known-argument-names-rule.ts';

// Spec Section: "Directives Are Defined"
export { KnownDirectivesRule } from './rules/known-directives-rule.ts';

// Spec Section: "Fragment spread target defined"
export { KnownFragmentNamesRule } from './rules/known-fragment-names-rule.ts';

// Spec Section: "Fragment Spread Type Existence"
export { KnownTypeNamesRule } from './rules/known-type-names-rule.ts';

// Spec Section: "Lone Anonymous Operation"
export { LoneAnonymousOperationRule } from './rules/lone-anonymous-operation-rule.ts';

// Spec Section: "Fragments must not form cycles"
export { NoFragmentCyclesRule } from './rules/no-fragment-cycles-rule.ts';

// Spec Section: "All Variable Used Defined"
export { NoUndefinedVariablesRule } from './rules/no-undefined-variables-rule.ts';

// Spec Section: "Fragments must be used"
export { NoUnusedFragmentsRule } from './rules/no-unused-fragments-rule.ts';

// Spec Section: "All Variables Used"
export { NoUnusedVariablesRule } from './rules/no-unused-variables-rule.ts';

// Spec Section: "Field Selection Merging"
export { OverlappingFieldsCanBeMergedRule } from './rules/overlapping-fields-can-be-merged-rule.ts';

// Spec Section: "Fragment spread is possible"
export { PossibleFragmentSpreadsRule } from './rules/possible-fragment-spreads-rule.ts';

// Spec Section: "Argument Optionality"
export { ProvidedRequiredArgumentsRule } from './rules/provided-required-arguments-rule.ts';

// Spec Section: "Leaf Field Selections"
export { ScalarLeafsRule } from './rules/scalar-leafs-rule.ts';

// Spec Section: "Subscriptions with Single Root Field"
export { SingleFieldSubscriptionsRule } from './rules/single-field-subscriptions-rule.ts';

// Spec Section: "Argument Uniqueness"
export { UniqueArgumentNamesRule } from './rules/unique-argument-names-rule.ts';

// Spec Section: "Directives Are Unique Per Location"
export { UniqueDirectivesPerLocationRule } from './rules/unique-directives-per-location-rule.ts';

// Spec Section: "Fragment Name Uniqueness"
export { UniqueFragmentNamesRule } from './rules/unique-fragment-names-rule.ts';

// Spec Section: "Input Object Field Uniqueness"
export { UniqueInputFieldNamesRule } from './rules/unique-input-field-names-rule.ts';

// Spec Section: "Operation Name Uniqueness"
export { UniqueOperationNamesRule } from './rules/unique-operation-names-rule.ts';

// Spec Section: "Variable Uniqueness"
export { UniqueVariableNamesRule } from './rules/unique-variable-names-rule.ts';

// Spec Section: "Values Type Correctness"
export { ValuesOfCorrectTypeRule } from './rules/values-of-correct-type-rule.ts';

// Spec Section: "Variables are Input Types"
export { VariablesAreInputTypesRule } from './rules/variables-are-input-types-rule.ts';

// Spec Section: "All Variable Usages Are Allowed"
export { VariablesInAllowedPositionRule } from './rules/variables-in-allowed-position-rule.ts';

export { MaxIntrospectionDepthRule } from './rules/max-introspection-depth-rule.ts';

// SDL-specific validation rules
export { LoneSchemaDefinitionRule } from './rules/lone-schema-definition-rule.ts';
export { UniqueOperationTypesRule } from './rules/unique-operation-types-rule.ts';
export { UniqueTypeNamesRule } from './rules/unique-type-names-rule.ts';
export { UniqueEnumValueNamesRule } from './rules/unique-enum-value-names-rule.ts';
export { UniqueFieldDefinitionNamesRule } from './rules/unique-field-definition-names-rule.ts';
export { UniqueArgumentDefinitionNamesRule } from './rules/unique-argument-definition-names-rule.ts';
export { UniqueDirectiveNamesRule } from './rules/unique-directive-names-rule.ts';
export { PossibleTypeExtensionsRule } from './rules/possible-type-extensions-rule.ts';

// Optional rules not defined by the GraphQL Specification
export { NoDeprecatedCustomRule } from './rules/custom/no-deprecated-custom-rule.ts';
export { NoSchemaIntrospectionCustomRule } from './rules/custom/no-schema-introspection-custom-rule.ts';
