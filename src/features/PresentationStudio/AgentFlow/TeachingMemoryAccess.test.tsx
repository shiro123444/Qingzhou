import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { TeachingMemoryAccess } from './TeachingMemoryAccess';
import { teachingClient } from './teachingClient';

it('lets the teacher inspect the selected memory in context', async () => {
  vi.spyOn(teachingClient, 'list').mockResolvedValue([]);
  render(<TeachingMemoryAccess selection={{ course: '物理', ids: [] }} onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'presentationTeaching.title' }));
  expect(await screen.findByText('presentationTeaching.currentCourse')).toBeInTheDocument();
  expect(teachingClient.list).toHaveBeenCalledOnce();
});
