import { fireEvent, screen } from '@testing-library/react';

import type { PresentationAgentClient } from './AgentFlow/presentationAgentClient';

/** Drive the normal outline-confirmation UI while transport suites own the generation client. */
export const outlineTestClient: PresentationAgentClient = {
  async turn({ messages }) {
    const topic =
      messages.find((message) => message.role === 'user')?.content.split('\n')[0] ?? 'Deck';
    return {
      brief: { topic, slideCount: 3 },
      phase: 'outline',
      message: '大纲已就绪。',
      slides: [1, 2, 3].map((n) => ({
        id: 'slide-' + n,
        title: n === 1 ? topic : topic + ' ' + n,
        keyPoints: ['Point ' + n],
      })),
    };
  },
  async outline() {
    throw new Error('Unexpected second outline request');
  },
};

export async function confirmTestOutline() {
  fireEvent.click(await screen.findByRole('button', { name: '确认大纲，继续生成' }));
}
