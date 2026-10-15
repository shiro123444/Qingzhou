import { expect, it } from 'vitest';

import { selectRoleDiverse } from './role-diversity';

it('retains late table and closing roles rather than truncating the first three layouts', () => {
  const layouts = [
    { id: 'a', roles: ['content'] },
    { id: 'b', roles: ['content'] },
    { id: 'c', roles: ['content'] },
    { id: 'table', roles: ['data', 'comparison'] },
    { id: 'thanks', roles: ['closing'] },
  ];
  expect(selectRoleDiverse(layouts, 3).map((a) => a.id)).toEqual(['table', 'a', 'thanks']);
  expect(layouts).toHaveLength(5);
});
