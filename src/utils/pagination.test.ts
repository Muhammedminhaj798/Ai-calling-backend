import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { paginationSchema, parseSort, skipTake } from './pagination.ts';

describe('pagination', () => {
  it('coerces and defaults page/pageSize', () => {
    assert.deepEqual(paginationSchema.parse({}), { page: 1, pageSize: 50 });
    assert.deepEqual(paginationSchema.parse({ page: '3', pageSize: '20' }), { page: 3, pageSize: 20 });
    assert.deepEqual(skipTake({ page: 3, pageSize: 20 }), { skip: 40, take: 20 });
    assert.throws(() => paginationSchema.parse({ pageSize: '500' }));
  });

  it('parses sort against an allow-list', () => {
    const allowed = ['createdAt', 'name'] as const;
    assert.deepEqual(parseSort('-name', allowed, 'createdAt'), { field: 'name', direction: 'desc' });
    assert.deepEqual(parseSort('name', allowed, 'createdAt'), { field: 'name', direction: 'asc' });
    assert.deepEqual(parseSort('passwordHash', allowed, 'createdAt'), { field: 'createdAt', direction: 'desc' });
    assert.deepEqual(parseSort(undefined, allowed, 'createdAt'), { field: 'createdAt', direction: 'desc' });
  });
});
