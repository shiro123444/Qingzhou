import { createStaticStyles } from 'antd-style';

export const glyphStyles = createStaticStyles(({ css }) => ({
  glyph: css`
    /* stylelint-disable no-descending-specificity -- Each glyph variant is mutually exclusive, with deliberate interaction overrides. */
    pointer-events: none;

    position: relative;

    display: inline-block;
    flex: none;

    width: var(--glyph-size, 20px);
    height: var(--glyph-size, 20px);

    color: inherit;
    vertical-align: middle;

    i {
      position: absolute;

      display: none;

      box-sizing: border-box;
      border-radius: 1px;

      background: currentcolor;

      transition:
        transform 360ms cubic-bezier(0.2, 0.8, 0.25, 1),
        opacity 200ms,
        clip-path 360ms;
    }

    &[data-motion-glyph='music'],
    &[data-motion-glyph='library'] {
      i:nth-child(-n + 4) {
        inset-block-end: 16%;
        inset-inline-start: calc(12% + var(--part) * 22%);

        display: block;

        width: 9%;
        height: 50%;
      }

      i:nth-child(2) {
        height: 75%;
      }

      i:nth-child(3) {
        height: 62%;
      }

      i:nth-child(4) {
        height: 42%;
      }
    }

    &[data-motion-glyph='library'] i:last-child {
      inset-block-end: 16%;
      inset-inline-start: 76%;
      transform: rotate(-16deg);

      display: block;

      width: 9%;
      height: 68%;
    }

    &[data-motion-glyph='home'] {
      i:first-child {
        inset-block-start: 12%;
        inset-inline-start: 23%;
        transform: rotate(45deg);

        display: block;

        width: 54%;
        height: 54%;
        border-block-start: 1.5px solid;
        border-inline-start: 1.5px solid;

        background: transparent;
      }

      i:nth-child(2) {
        inset-block-start: 43%;
        inset-inline-start: 18%;

        display: block;

        width: 64%;
        height: 43%;
        border: 1.5px solid;
        border-block-start: 0;
        border-radius: 0 0 3px 3px;

        background: transparent;
      }

      i:nth-child(3) {
        inset-block-start: 60%;
        inset-inline-start: 43%;

        display: block;

        width: 16%;
        height: 26%;
        border: 1.5px solid;
        border-block-end: 0;

        background: transparent;
      }
    }

    &[data-motion-glyph='search'],
    &[data-motion-glyph='awareness'] {
      i:first-child {
        inset-block-start: 12%;
        inset-inline-start: 12%;

        display: block;

        width: 61%;
        height: 61%;
        border: 1.5px solid;
        border-radius: 50%;

        background: transparent;
      }

      i:nth-child(2) {
        inset-block-start: 66%;
        inset-inline-start: 64%;
        transform-origin: left center;
        transform: rotate(45deg);

        display: block;

        width: 30%;
        height: 1.5px;
      }
    }

    &[data-motion-glyph='awareness'] {
      i:first-child {
        inset-block-start: 15%;
        inset-inline-start: 12%;
        transform: rotate(45deg);

        width: 76%;
        height: 64%;
        border-radius: 75% 15%;
      }

      i:nth-child(2) {
        inset-block-start: 38%;
        inset-inline-start: 43%;
        transform: none;

        width: 17%;
        height: 25%;
        border-radius: 4px;
      }
    }

    &[data-motion-glyph='document'],
    &[data-motion-glyph='tasks'],
    &[data-motion-glyph='menu'],
    &[data-motion-glyph='channels'] {
      i:nth-child(-n + 3) {
        inset-block-start: calc(27% + var(--part) * 22%);
        inset-inline-start: 25%;

        display: block;

        width: 58%;
        height: 1.5px;
      }

      i:nth-child(2) {
        width: 44%;
      }

      i:nth-child(3) {
        width: 34%;
      }
    }

    &[data-motion-glyph='tasks'] i:nth-child(n + 4) {
      inset-block-start: calc(-39% + var(--part) * 22%);
      inset-inline-start: 4%;
      transform: rotate(-35deg);

      display: block;

      width: 9%;
      height: 1.5px;
    }

    &[data-motion-glyph='document'] i:last-child {
      inset-block: 6%;
      inset-inline: 9%;

      display: block;

      border: 1.5px solid;
      border-radius: 3px;

      background: transparent;
    }

    &[data-motion-glyph='channels'] i {
      transform: rotate(-35deg);
    }

    &[data-motion-glyph='plugins'] i:nth-child(-n + 4) {
      display: block;

      width: 30%;
      height: 30%;
      border: 1.5px solid;
      border-radius: 3px;

      background: transparent;
    }

    &[data-motion-glyph='plugins'] {
      i:first-child {
        inset-block-start: 10%;
        inset-inline-start: 10%;
      }

      i:nth-child(2) {
        inset-block-start: 10%;
        inset-inline-end: 10%;
        transform: rotate(12deg);
      }

      i:nth-child(3) {
        inset-block-end: 10%;
        inset-inline-start: 10%;
      }

      i:nth-child(4) {
        inset-block-end: 10%;
        inset-inline-end: 10%;
      }
    }

    &[data-motion-glyph='computer'],
    &[data-motion-glyph='presentation'],
    &[data-motion-glyph='sidebar'] {
      i:first-child {
        inset-block: 13% 25%;
        inset-inline: 6%;

        display: block;

        border: 1.5px solid;
        border-radius: 3px;

        background: transparent;
      }

      i:nth-child(2) {
        inset-block-start: 75%;
        inset-inline-start: 46%;

        display: block;

        width: 1.5px;
        height: 14%;
      }

      i:nth-child(3) {
        inset-block-end: 10%;
        inset-inline-start: 30%;

        display: block;

        width: 40%;
        height: 1.5px;
      }
    }

    &[data-motion-glyph='sidebar'] {
      i:first-child {
        inset-block: 12%;
        inset-inline: 6%;
      }

      i:nth-child(2) {
        inset-block-start: 12%;
        inset-inline-start: 35%;
        height: 76%;
      }

      i:nth-child(3) {
        display: none;
      }
    }

    &[data-motion-glyph='close'],
    &[data-motion-glyph='plus'] {
      i:nth-child(-n + 2) {
        inset-block-start: 47%;
        inset-inline-start: 14%;
        transform: rotate(45deg);

        display: block;

        width: 72%;
        height: 1.5px;
      }

      i:nth-child(2) {
        transform: rotate(-45deg);
      }
    }

    &[data-motion-glyph='plus'] {
      i:first-child {
        transform: none;
      }

      i:nth-child(2) {
        transform: rotate(90deg);
      }
    }

    &[data-motion-glyph='play'],
    &[data-motion-glyph='pause'],
    &[data-motion-glyph='next'],
    &[data-motion-glyph='previous'] {
      i:first-child {
        inset-block: 17%;
        inset-inline: 25% 18%;

        display: block;

        border-radius: 2px;

        clip-path: polygon(0 0, 100% 50%, 0 100%);
      }

      i:nth-child(2) {
        inset-block-start: 17%;
        inset-inline-start: 72%;

        display: block;

        width: 8%;
        height: 66%;

        opacity: 0;
      }
    }

    &[data-motion-glyph='pause'] {
      i:first-child {
        inset-inline-end: 55%;
        clip-path: none;
      }

      i:nth-child(2) {
        inset-inline-start: 61%;
        width: 14%;
        opacity: 1;
      }
    }

    &[data-motion-glyph='next'],
    &[data-motion-glyph='previous'] {
      i:first-child {
        inset-inline-end: 32%;
      }

      i:nth-child(2) {
        opacity: 1;
      }
    }

    &[data-motion-glyph='previous'] {
      transform: rotate(180deg);
    }

    &[data-motion-glyph='arrow'],
    &[data-motion-glyph='back'],
    &[data-motion-glyph='enter'] {
      i:first-child {
        inset-block-start: 48%;
        inset-inline-start: 17%;

        display: block;

        width: 65%;
        height: 1.5px;
      }

      i:nth-child(2) {
        inset-block-start: 29%;
        inset-inline-start: 52%;
        transform: rotate(45deg);

        display: block;

        width: 37%;
        height: 37%;
        border-block-start: 1.5px solid;
        border-inline-end: 1.5px solid;

        background: transparent;
      }
    }

    &[data-motion-glyph='back'],
    &[data-motion-glyph='enter'] {
      transform: rotate(180deg);
    }

    &[data-motion-glyph='expand'],
    &[data-motion-glyph='collapse'] {
      i:nth-child(-n + 2) {
        display: block;

        width: 34%;
        height: 34%;
        border-block-start: 1.5px solid;
        border-inline-end: 1.5px solid;

        background: transparent;
      }

      i:first-child {
        inset-block-start: 12%;
        inset-inline-end: 12%;
      }

      i:nth-child(2) {
        inset-block-end: 12%;
        inset-inline-start: 12%;
        transform: rotate(180deg);
      }
    }

    &[data-motion-glyph='collapse'] {
      transform: none;

      i:first-child {
        inset-block-start: 10%;
        inset-inline-end: 10%;
        transform: rotate(180deg);
      }

      i:nth-child(2) {
        inset-block-end: 10%;
        inset-inline-start: 10%;
        transform: none;
      }
    }

    &[data-motion-glyph='refresh'],
    &[data-motion-glyph='repeat'] {
      i:first-child {
        inset: 14%;

        display: block;

        border: 1.5px solid;
        border-inline-end-color: transparent;
        border-radius: 50%;

        background: transparent;
      }

      i:nth-child(2) {
        inset-block-start: 8%;
        inset-inline-end: 10%;

        display: block;

        width: 25%;
        height: 25%;
        border-block-end: 1.5px solid;
        border-inline-end: 1.5px solid;

        background: transparent;
      }
    }

    &[data-motion-glyph='repeat'] i:first-child {
      border-radius: 4px;
    }

    &[data-motion-glyph='volume'] {
      i:first-child {
        inset-block: 18%;
        inset-inline: 8% 45%;
        display: block;
        clip-path: polygon(0 30%, 40% 30%, 100% 0, 100% 100%, 40% 70%, 0 70%);
      }

      i:nth-child(2) {
        inset-block-start: 23%;
        inset-inline-end: 10%;

        display: block;

        width: 25%;
        height: 54%;
        border-inline-end: 1.5px solid;
        border-radius: 50%;

        background: transparent;
      }
    }

    &[data-motion-glyph='shuffle'] {
      i:nth-child(-n + 2) {
        inset-block-start: 46%;
        inset-inline-start: 9%;
        transform: rotate(33deg);

        display: block;

        width: 80%;
        height: 1.5px;
      }

      i:nth-child(2) {
        transform: rotate(-33deg);
      }
    }

    :is(button, a, [data-kinetic-control]):is(:hover, :focus-visible) & {
      &[data-motion-glyph='music'] i:nth-child(odd) {
        transform: scaleY(0.55);
      }

      &[data-motion-glyph='music'] i:nth-child(even) {
        transform: scaleY(1.12);
      }

      &[data-motion-glyph='document'] i:nth-child(2),
      &[data-motion-glyph='menu'] i:nth-child(2) {
        transform: translateX(12%);
      }

      &[data-motion-glyph='awareness'] i:nth-child(2) {
        transform: translateX(2px);
      }

      &[data-motion-glyph='sidebar'] i:nth-child(2) {
        transform: translateX(2px);
      }

      &[data-motion-glyph='plugins'] i:nth-child(2) {
        transform: rotate(90deg);
      }

      &[data-motion-glyph='next'] i:first-child {
        transform: translateX(2px);
      }

      &[data-motion-glyph='previous'] i:first-child {
        transform: translateX(2px);
      }

      &[data-motion-glyph='refresh'] i:first-child {
        transform: rotate(65deg);
      }

      &[data-motion-glyph='arrow'] i,
      &[data-motion-glyph='back'] i {
        translate: 2px 0;
      }

      &[data-motion-glyph='home'] i:nth-child(3) {
        transform-origin: bottom;
        transform: scaleY(0.7);
      }
    }

    &[data-running='true'][data-motion-glyph='music'] i {
      transform-origin: bottom;
      animation: qz-glyph-meter 850ms ease-in-out infinite alternate;
      animation-delay: calc(var(--part) * -140ms);
    }

    @keyframes qz-glyph-meter {
      to {
        transform: scaleY(0.35);
      }
    }

    &[data-active='true'][data-motion-glyph='menu'] {
      i:first-child {
        transform: translateY(calc(var(--glyph-size) * 0.22)) rotate(45deg);
      }

      i:nth-child(2) {
        opacity: 0;
      }

      i:nth-child(3) {
        transform: translateY(calc(var(--glyph-size) * -0.22)) rotate(-45deg);
        width: 58%;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      &,
      i {
        transition: none !important;
        animation: none !important;
      }
    }
  `,
}));
