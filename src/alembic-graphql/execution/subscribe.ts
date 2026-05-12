import { Effect, Stream } from 'effect';

import { devAssert } from '../jsutils/dev-assert.ts';
import { inspect } from '../jsutils/inspect.ts';
import { addPath, pathToArray } from '../jsutils/path.ts';

import {
  type GraphQLError,
  GraphQLSubscriptionError,
  isGraphQLError,
} from '../error/graph-ql-error.ts';
import { locatedError } from '../error/located-error.ts';

import { collectFields } from './collect-fields.ts';
import type {
  EffectFieldResolver,
  EffectSubscribeResolver,
  ExecutionArgs,
  ExecutionContext,
  ExecutionResult,
} from './execute.ts';
import {
  assertValidExecutionArguments,
  buildExecutionContextEffect,
  buildResolveInfo,
  execute,
  getFieldDef,
  resolverResultToEffect,
} from './execute.ts';
import { getArgumentValues } from './values.ts';
import type { GraphQLResolverResult } from '../type/definition.ts';

/**
 * Implements the "Subscribe" algorithm described in the GraphQL specification.
 *
 * Returns an Effect yielding either a Stream of ExecutionResults or an
 * ExecutionResult (errors-only result if the subscription could not be
 * established). Transports consume the returned Stream with Effect primitives.
 */
export function subscribe<R = never>(
  args: ExecutionArgs,
): Effect.Effect<
  Stream.Stream<ExecutionResult, unknown, R> | ExecutionResult,
  never,
  R
> {
  devAssert(
    arguments.length < 2,
    'Alembic GraphQL subscribe expects a single argument object.',
  );

  return Effect.gen(function* () {
    const resultOrStream = yield* createSourceEventStream<R>(args);

    if (!Stream.isStream(resultOrStream)) {
      return resultOrStream;
    }

    return resultOrStream.pipe(
      Stream.mapEffect((payload) =>
        execute<R>({ ...args, rootValue: payload }).pipe(
          Effect.withSpan('alembic.subscribe.event.execute'),
        ),
      ),
      Stream.withSpan('alembic.subscribe.stream'),
    );
  }).pipe(Effect.withSpan('alembic.subscribe'));
}

/**
 * Implements the "CreateSourceEventStream" algorithm described in the
 * GraphQL specification.
 *
 * The success channel yields either an Effect Stream (the source stream) or an
 * ExecutionResult (subscription-resolver error).
 * The Effect error channel is `never`.
 */
export function createSourceEventStream<R = never>(
  args: ExecutionArgs,
): Effect.Effect<Stream.Stream<unknown, unknown, R> | ExecutionResult, never, R> {
  return Effect.gen(function* () {
    const { schema, document, variableValues } = args;

    assertValidExecutionArguments(schema, document, variableValues);

    const exeContextOrErrors = yield* buildExecutionContextEffect(args);
    if (Array.isArray(exeContextOrErrors)) {
      return { errors: exeContextOrErrors } as ExecutionResult;
    }
    const exeContext = exeContextOrErrors as ExecutionContext;

    return yield* executeSubscription<R>(exeContext).pipe(
      Effect.flatMap((eventStream) => {
        if (!Stream.isStream(eventStream)) {
          return Effect.die(
            new Error(
              'Subscription field must return Effect Stream. ' +
                `Received: ${inspect(eventStream)}.`,
            ),
          );
        }
        return Effect.succeed(eventStream as Stream.Stream<unknown, unknown, R>);
      }),
      Effect.catch((error: unknown) => {
        if (isGraphQLError(error)) {
          return Effect.succeed({ errors: [error] } as ExecutionResult);
        }
        return Effect.die(error);
      }),
    ).pipe(Effect.withSpan('alembic.subscribe.source'));
  });
}

function executeSubscription<R>(
  exeContext: ExecutionContext,
): Effect.Effect<Stream.Stream<unknown, unknown, R>, GraphQLError, R> {
  return Effect.gen(function* () {
    const { schema, fragments, operation, variableValues, rootValue } =
      exeContext;

    const rootType = schema.getSubscriptionType();
    if (rootType == null) {
      return yield* Effect.fail(
        new GraphQLSubscriptionError(
          'Schema is not configured to execute subscription operation.',
          { nodes: operation, reason: 'missingSubscriptionRootType' },
        ),
      );
    }

    const rootFields = collectFields(
      schema,
      fragments,
      variableValues,
      rootType,
      operation.selectionSet,
    );
    const rootField = [...rootFields.entries()][0];
    if (rootField === undefined) {
      return yield* Effect.fail(
        new GraphQLSubscriptionError('Subscription must select a field.', {
          reason: 'missingSubscriptionField',
        }),
      );
    }
    const [responseName, fieldNodes] = rootField;
    const fieldNode = fieldNodes[0]!;
    const fieldDef = getFieldDef(schema, rootType, fieldNode);

    if (!fieldDef) {
      const fieldName = fieldNode.name.value;
      return yield* Effect.fail(
        new GraphQLSubscriptionError(
          `The subscription field "${fieldName}" is not defined.`,
          { nodes: fieldNodes, reason: 'undefinedSubscriptionField' },
        ),
      );
    }

    const path = addPath(undefined, responseName, rootType.name);
    const info = buildResolveInfo(
      exeContext,
      fieldDef,
      fieldNodes,
      rootType,
      path,
    );

    const resolveFn: EffectSubscribeResolver<any, any, any, R> =
      (fieldDef.subscribe as
        | EffectSubscribeResolver<any, any, any, R>
        | undefined) ??
      (exeContext.subscribeFieldResolver as EffectSubscribeResolver<
        any,
        any,
        any,
        R
      >);

    const program: Effect.Effect<Stream.Stream<unknown, unknown, R>, unknown, R> = Effect.gen(function* () {
      const args = yield* Effect.try({
        try: () =>
          getArgumentValues(fieldDef, fieldNode, variableValues),
        catch: (e) => e,
      });
      const stream = yield* resolverResultToEffect<
        Stream.Stream<unknown, unknown, R>,
        R
      >(() =>
        resolveFn(
          rootValue,
          args,
          exeContext.contextValue,
          info,
        ) as GraphQLResolverResult<Stream.Stream<unknown, unknown, R>, R>,
      );
      if (stream instanceof Error) {
        return yield* Effect.fail(stream);
      }
      return stream;
    }).pipe(Effect.withSpan('alembic.subscribe.resolve'));

    return yield* program.pipe(
      Effect.catch((error: unknown) =>
        Effect.fail(locatedError(error, fieldNodes, pathToArray(path))),
      ),
    );
  });
}
