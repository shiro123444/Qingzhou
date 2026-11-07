import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css }) => ({
  definitions: css`
    pointer-events: none;

    position: absolute;

    overflow: hidden;

    width: 0;
    height: 0;
  `,
  optics: css`
    &[data-qz-optics='direct'] {
      backdrop-filter: var(--qz-refraction-filter) !important;
    }

    &[data-qz-optics='backplate']::before {
      backdrop-filter: var(--qz-refraction-filter) !important;
    }
  `,
}));
