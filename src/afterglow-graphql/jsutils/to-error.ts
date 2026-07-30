import { inspect } from './inspect.ts';

export function toError(thrownValue: unknown): Error {
  if (thrownValue instanceof Error) return thrownValue;

  const error = new Error(`Unexpected error value: ${inspect(thrownValue)}`) as Error & {
    name: string;
    thrownValue: unknown;
  };
  error.name = 'NonErrorThrown';
  error.thrownValue = thrownValue;
  return error;
}
