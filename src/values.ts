export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export const validAgentName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value) &&
  !['constructor', 'prototype', '__proto__'].includes(value);
