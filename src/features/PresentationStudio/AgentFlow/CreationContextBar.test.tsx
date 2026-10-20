import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { CreationContextBar } from './CreationContextBar';
import { teachingClient } from './teachingClient';

it('exposes teaching context and memory before an outline or template is selected', async () => {
  vi.spyOn(teachingClient, 'list').mockResolvedValue([]);
  const onModeChange = vi.fn();
  render(
    <CreationContextBar
      mode="presentation"
      selection={{ course: '', ids: [] }}
      onModeChange={onModeChange}
      onSelectionChange={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText('presentationCreation.lesson'));
  expect(onModeChange).toHaveBeenCalledWith('lesson');
  fireEvent.click(screen.getByRole('button', { name: 'presentationCreation.memories' }));
  expect(await screen.findByText('presentationTeaching.currentCourse')).toBeInTheDocument();
  expect(teachingClient.list).toHaveBeenCalledOnce();
});
