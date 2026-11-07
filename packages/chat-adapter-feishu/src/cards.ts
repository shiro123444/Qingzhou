export interface LarkReplyCard {
  actions?: Array<{
    action: 'confirm' | 'reject';
    label: string;
    platformThreadId: string;
    token: string;
  }>;
  content: string;
  deliveryId: string;
  title: string;
}

/** JSON 2.0 buttons return only scoped action data. The operator comes from Feishu. */
export function buildLarkReplyCard(card: LarkReplyCard): Record<string, unknown> {
  if (!card.title.trim() || card.title.length > 100 || !card.content.trim()) {
    throw new Error('Invalid Feishu card title or content');
  }
  const elements: Record<string, unknown>[] = [
    { content: card.content.replaceAll(/<at\b/giu, '&lt;at'), tag: 'markdown' },
  ];
  if (card.actions && card.actions.length > 2) throw new Error('Too many Feishu card actions');
  for (const action of card.actions ?? []) {
    if (
      !['confirm', 'reject'].includes(action.action) ||
      !/^[a-f\d]{12}$/iu.test(action.token) ||
      !/^(?:feishu|lark):/.test(action.platformThreadId) ||
      !action.label.trim() ||
      action.label.length > 50
    ) {
      throw new Error('Invalid Feishu card action');
    }
    elements.push({
      behaviors: [
        {
          type: 'callback',
          value: {
            platformThreadId: action.platformThreadId,
            qingzhouAction: action.action,
            token: action.token,
          },
        },
      ],
      tag: 'button',
      text: { content: action.label, tag: 'plain_text' },
      type: action.action === 'confirm' ? 'primary' : 'danger',
    });
  }
  return {
    body: { elements },
    config: { update_multi: true },
    header: { title: { content: card.title, tag: 'plain_text' } },
    schema: '2.0',
  };
}
