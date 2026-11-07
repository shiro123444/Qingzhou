import { isDesktop } from '@lobechat/const';
import { type Theme } from 'antd-style';
import { css } from 'antd-style';
import { rgba } from 'polished';

const antdOverride = ({ token }: { prefixCls: string; token: Theme }) => css`
  .${token.prefixCls}-popover {
    z-index: 1100;
  }

  .${token.prefixCls}-menu-item-selected {
    .${token.prefixCls}-menu-title-content {
      color: ${token.colorText};
    }
  }

  .${token.prefixCls}-modal
    .${token.prefixCls}-modal-container,
    .${token.prefixCls}-popover
    .${token.prefixCls}-popover-inner,
    .${token.prefixCls}-dropdown
    .${token.prefixCls}-dropdown-menu,
    .${token.prefixCls}-drawer
    .${token.prefixCls}-drawer-content {
    border-color: var(--qz-glass-border, ${token.colorBorderSecondary});
    background: var(
      --qz-glass-strong,
      color-mix(in srgb, ${token.colorBgElevated} 88%, transparent)
    );
    backdrop-filter: var(--qz-glass-filter, blur(24px) saturate(1.35));
    box-shadow: var(--qz-glass-shadow, 0 12px 32px rgb(16 42 49 / 8%));
  }

  .${token.prefixCls}-modal .${token.prefixCls}-modal-header {
    background: transparent;
  }

  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .${token.prefixCls}-modal
      .${token.prefixCls}-modal-container,
      .${token.prefixCls}-popover
      .${token.prefixCls}-popover-inner,
      .${token.prefixCls}-dropdown
      .${token.prefixCls}-dropdown-menu,
      .${token.prefixCls}-drawer
      .${token.prefixCls}-drawer-content {
      background: ${token.colorBgElevated};
      backdrop-filter: none;
    }
  }

  @media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
    .${token.prefixCls}-modal
      .${token.prefixCls}-modal-container,
      .${token.prefixCls}-popover
      .${token.prefixCls}-popover-inner,
      .${token.prefixCls}-dropdown
      .${token.prefixCls}-dropdown-menu,
      .${token.prefixCls}-drawer
      .${token.prefixCls}-drawer-content {
      background: ${token.colorBgElevated};
      backdrop-filter: none;
      box-shadow: none;
    }
  }

  .${token.prefixCls}-modal-mask, .${token.prefixCls}-drawer-mask {
    background: ${rgba(token.colorBgLayout, 0.5)} !important;
    backdrop-filter: blur(2px);

    @media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
      backdrop-filter: none;
    }
  }

  ${
    isDesktop &&
    css`
      .${token.prefixCls}-modal-mask.${token.prefixCls}-modal-mask-blur {
        background: ${rgba(token.colorBgLayout, 0.8)} !important;
        backdrop-filter: none !important;
      }
    `
  }
`;

export default antdOverride;
