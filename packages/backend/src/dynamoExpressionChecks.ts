// TEST-ONLY: what DynamoDB validates at PARSE, before anything is written, and a mocked
// client does not. A command that would fail every production call looks perfectly fine
// against a mock unless the SHAPE of its expressions is what the suite holds — so the
// Dynamo store suites build their clients over these checks, and no write escapes them.
//
// Nothing in the Lambda's import graph reaches this file; it is not bundled.

import { expect } from 'vitest';
import type { AttributeValue, TransactWriteItem } from '@aws-sdk/client-dynamodb';

// DynamoDB's CONDITION grammar has NO arithmetic, and its whole function list is these
// six — `size` over a document PATH. `if_not_exists` and `+` belong to an UPDATE
// expression's SET action; naming either in a condition makes the service reject the
// request with a ValidationException.
const CONDITION_FUNCTIONS = [
  'attribute_exists',
  'attribute_not_exists',
  'attribute_type',
  'begins_with',
  'contains',
  'size',
];

interface Expressed {
  UpdateExpression?: string;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
}

export function expectConditionSyntax(expression: string | undefined): void {
  expect(expression).toBeTruthy();
  const source = expression!;
  for (const match of source.matchAll(/([A-Za-z_]+)\s*\(/g)) {
    // `AND (`/`OR (`/`NOT (` are the grammar's own logical operators, not calls.
    if (['AND', 'OR', 'NOT'].includes(match[1].toUpperCase())) continue;
    expect(CONDITION_FUNCTIONS, source).toContain(match[1]);
  }
  // No arithmetic anywhere, and every `size()` reads a plain attribute PATH rather than
  // wrapping another call.
  expect(source).not.toMatch(/[+*/]/);
  expect(source).not.toMatch(/\s-\s/);
  expect(source).not.toMatch(/if_not_exists/);
  for (const match of source.matchAll(/size\(\s*([^)]*)\)/g)) {
    expect(match[1].trim()).toMatch(/^#[A-Za-z]+$/);
  }
}

// DynamoDB rejects an ExpressionAttributeNames entry that no expression references ("Value
// provided in ExpressionAttributeNames unused in expressions: keys: {#x}") and an alias no
// entry declares, and does the same for VALUES — so a command carrying a union map of every
// attribute its store knows about fails EVERY write in production. Checked in both
// directions, with the condition's grammar wherever the command carries one.
export function expectExpressionsValid(input: Expressed): void {
  const source = `${input.UpdateExpression ?? ''} ${input.ConditionExpression ?? ''}`;
  const check = (pattern: RegExp, declared: object | undefined, what: string) => {
    const used = new Set(source.match(pattern) ?? []);
    const keys = new Set(Object.keys(declared ?? {}));
    expect([...keys].filter((k) => !used.has(k)), `${what} declared but unused`).toEqual([]);
    expect([...used].filter((k) => !keys.has(k)), `${what} used but undeclared`).toEqual([]);
  };
  check(/#[A-Za-z0-9_]+/g, input.ExpressionAttributeNames, 'name');
  check(/:[A-Za-z0-9_]+/g, input.ExpressionAttributeValues, 'value');
  if (input.ConditionExpression !== undefined) expectConditionSyntax(input.ConditionExpression);
}

// Every clause inside a TRANSACTION is subject to the same rejection, and one bad item
// fails the whole write — a standalone ConditionCheck included.
export function expectTransactItemValid(item: TransactWriteItem): void {
  for (const part of [item.Put, item.Delete, item.Update, item.ConditionCheck]) {
    if (part) expectExpressionsValid(part);
  }
}
