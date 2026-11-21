import { createStaticStyles } from 'antd-style';
import { panelResizeTiming } from './panelMotion';
export const { glassSelection } = createStaticStyles(({ css, cssVar }) => ({
  glassSelection: css`
    pointer-events: none;
    box-sizing: border-box;
    border: 1.5px solid var(--qz-glass-tint, ${cssVar.colorPrimary});
    border-radius: 4px;
    background: var(
      --qz-glass-selection,
      color-mix(in srgb, ${cssVar.colorPrimary} 8%, transparent)
    );
    box-shadow:
      inset 0 1px 0 var(--qz-glass-highlight),
      0 0 0 2px color-mix(in srgb, var(--qz-glass-tint, #53877e) 16%, transparent);
    animation: qzObjectSelectionIn ${panelResizeTiming} both;
    @keyframes qzObjectSelectionIn {
      from {
        scale: 0.97;
        opacity: 0.3;
      }
      to {
        scale: 1;
        opacity: 1;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
}));
