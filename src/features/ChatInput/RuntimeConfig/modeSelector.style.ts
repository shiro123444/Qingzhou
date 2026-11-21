import { createStaticStyles, cssVar } from 'antd-style';

export const modeSelectorStyles = createStaticStyles(({ css }) => ({
  activeOption: css`
    background: var(--qz-glass-selection, ${cssVar.colorFillTertiary});
  `,
  agentTooltip: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 160px;
  `,
  agentTooltipCap: css`
    display: flex;
    gap: 6px;
    align-items: center;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  agentTooltipTitle: css`
    margin-block-end: 2px;
    font-size: 12px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  button: css`
    cursor: pointer;

    display: flex;
    gap: 6px;
    align-items: center;

    height: 28px;
    padding-inline: 8px;
    border-radius: 999px;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillTertiary};

    transition: all 0.2s;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillSecondary};
    }
  `,
  option: css`
    cursor: pointer;

    display: flex;
    gap: 12px;
    align-items: center;

    width: 100%;
    padding: 12px;
    border: 0;
    border-radius: var(--qz-glass-radius-item, 12px);

    font: inherit;
    color: inherit;
    text-align: start;

    appearance: none;
    background-color: transparent;

    transition: background-color 0.15s;

    &:hover {
      background-color: color-mix(in srgb, ${cssVar.colorText} 5%, transparent);
    }

    &:focus-visible {
      outline: 2px solid var(--qz-glass-tint, ${cssVar.colorPrimary});
      outline-offset: -2px;
    }
  `,
  optionDesc: css`
    font-size: 12px;
    line-height: 1.4;
    color: ${cssVar.colorTextSecondary};
  `,
  optionIcon: css`
    flex-shrink: 0;
    border-radius: 10px;
    color: ${cssVar.colorTextSecondary};
    background: color-mix(in srgb, ${cssVar.colorText} 5%, transparent);

    [aria-pressed='true'] & {
      color: var(--qz-glass-tint, ${cssVar.colorText});
      background: color-mix(in srgb, var(--qz-glass-tint, #729b97) 12%, transparent);
    }
  `,
  optionCheck: css`
    flex-shrink: 0;
    color: var(--qz-glass-tint, ${cssVar.colorText});
    opacity: 0;

    [aria-pressed='true'] & {
      opacity: 1;
    }
  `,
  popover: css`
    border-radius: var(--qz-glass-radius-panel, 20px);
  `,
  popoverContent: css`
    padding: 6px;
    border-radius: inherit;
  `,
  optionTitle: css`
    font-size: 14px;
    font-weight: 500;
    line-height: 1.4;
    color: ${cssVar.colorText};
  `,
}));
