'use client';

import { Flexbox } from '@lobehub/ui';
import { LoadingDots } from '@lobehub/ui/chat';
import { cssVar } from 'antd-style';
import { memo, useEffect, useState } from 'react';

const PHRASES = ['PPT 生成', 'PPT 设计', 'PPT 打磨', 'PPT 编辑'];
const TYPING_INTERVAL_MS = 60;
const PAUSE_DURATION_MS = 2500;

export const PresentationTypewriterTitle = memo(() => {
  const [index, setIndex] = useState(0);
  const [partial, setPartial] = useState(PHRASES[0]);
  const [phase, setPhase] = useState<'typing' | 'pause'>('pause');
  const [charIndex, setCharIndex] = useState(PHRASES[0].length);

  const current = PHRASES[index % PHRASES.length];

  useEffect(() => {
    setPartial('');
    setCharIndex(0);
    setPhase('typing');
  }, [index]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    switch (phase) {
      case 'typing': {
        if (charIndex < current.length) {
          timer = setTimeout(() => {
            setPartial(current.slice(0, charIndex + 1));
            setCharIndex((c) => c + 1);
          }, TYPING_INTERVAL_MS);
        } else {
          setPhase('pause');
        }
        break;
      }
      case 'pause': {
        timer = setTimeout(() => {
          setIndex((prev) => (prev + 1) % PHRASES.length);
        }, PAUSE_DURATION_MS);
        break;
      }
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [phase, charIndex, current]);

  const showCursor = phase === 'typing';

  return (
    <Flexbox
      data-testid="presentation-typewriter-title"
      style={{
        alignItems: 'flex-start',
        color: cssVar.colorText,
        fontSize: 32,
        fontWeight: 700,
        height: '1.4em',
        lineHeight: 1.4,
        overflow: 'hidden',
        width: '100%',
      }}
    >
      <span>
        {phase === 'pause' ? current : partial}
        {showCursor && (
          <span style={{ display: 'inline-block', marginInlineStart: 6, verticalAlign: 'middle' }}>
            <LoadingDots color={cssVar.colorPrimary} size={10} variant="pulse" />
          </span>
        )}
      </span>
    </Flexbox>
  );
});

PresentationTypewriterTitle.displayName = 'PresentationTypewriterTitle';

export default PresentationTypewriterTitle;
