import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import PresentationStudioRoute from './index';

describe('Presentation Route', () => {
  it('renders the PresentationStudio feature component (thin shell)', async () => {
    render(
      <MemoryRouter>
        <PresentationStudioRoute />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('presentation-studio')).toBeInTheDocument();
    expect(await screen.findByTestId('studio-empty-state')).toBeInTheDocument();
  });
});
