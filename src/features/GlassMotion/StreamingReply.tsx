import { cx } from 'antd-style';
import { motion, useReducedMotion, useSpring } from 'motion/react';
import {
  type ComponentProps,
  type PropsWithChildren,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';

import { springs } from './springs';
import { styles } from './style';
import { textStyles } from './text.style';
import { createReadAlong } from './textMotion';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
interface Node {
  children?: Node[];
  properties?: Record<string, unknown>;
  tagName?: string;
  type: string;
  value?: string;
}

/** HAST transform, not a DOM mutation: React retains ownership and Markdown semantics. */
export function streamWords() {
  return (tree: Node) => {
    const visit = (node: Node, prose = false) => {
      if (['code', 'pre', 'svg', 'math', 'style', 'script'].includes(node.tagName ?? '')) return;
      const isProse = prose || ['p', 'li', 'blockquote'].includes(node.tagName ?? '');
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (isProse && child.type === 'text' && child.value) {
          return [...segmenter.segment(child.value)].map(({ segment }) =>
            /\S/.test(segment)
              ? {
                  type: 'element',
                  tagName: 'span',
                  properties: { 'data-qz-stream-word': true },
                  children: [{ type: 'text', value: segment }],
                }
              : { type: 'text', value: segment },
          );
        }
        visit(child, isProse);
        return [child];
      });
    };
    visit(tree);
  };
}

export function StreamingWord({
  node: _node,
  ...props
}: ComponentProps<'span'> & { 'node'?: unknown; 'data-qz-stream-word'?: boolean }) {
  const reduced = useReducedMotion();
  if (!props['data-qz-stream-word'] || reduced) return <span {...props} />;
  return (
    <motion.span
      {...(props as Omit<
        typeof props,
        'onDrag' | 'onDragEnd' | 'onDragStart' | 'onAnimationStart'
      >)}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      initial={{ opacity: 0, y: 6, filter: 'blur(4px)' }}
      transition={{ type: 'spring', ...springs.word }}
    />
  );
}

export function StreamingReply({
  children,
  streaming = false,
}: PropsWithChildren<{ streaming?: boolean }>) {
  const inner = useRef<HTMLDivElement>(null),
    measured = useRef(false);
  const pill = useRef<HTMLSpanElement>(null);
  const height = useSpring(0, springs.lensZoom),
    reduced = useReducedMotion();
  useEffect(() => {
    if (!streaming || !inner.current || !pill.current) return;
    const element = inner.current;
    const reading = createReadAlong(element, pill.current);
    const focus = () => {
      const words = element.querySelectorAll<HTMLElement>('[data-qz-stream-word]');
      reading.focus(words.item(words.length - 1));
    };
    const observer = new MutationObserver(focus);
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    focus();
    return () => {
      observer.disconnect();
      reading.dispose();
    };
  }, [streaming]);
  useLayoutEffect(() => {
    const element = inner.current;
    if (!element || !streaming || reduced) {
      measured.current = false;
      return;
    }
    const observer = new ResizeObserver(() => {
      const next = element.getBoundingClientRect().height;
      if (!measured.current) {
        height.jump(next);
        measured.current = true;
      } else height.set(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [streaming, reduced, height]);
  return (
    <motion.div
      className={styles.streaming}
      style={{ height: streaming && !reduced ? height : 'auto' }}
    >
      <div className={cx(textStyles.readingRoot)} ref={inner}>
        {streaming && (
          <span aria-hidden data-reading-pill className={textStyles.readingPill} ref={pill} />
        )}
        {children}
      </div>
    </motion.div>
  );
}
