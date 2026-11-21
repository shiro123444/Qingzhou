import { Flexbox, Icon, Popover, Tooltip } from '@lobehub/ui';
import { cx } from 'antd-style';
import {
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  InfinityIcon,
  MessageCircleIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAgentId } from '@/features/ChatInput/hooks/useAgentId';
import { useToggleAgentMode } from '@/features/ChatInput/hooks/useToggleAgentMode';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors } from '@/store/agent/selectors';

import { modeSelectorStyles as styles } from './modeSelector.style';

const AGENT_CAPS = [
  { icon: WrenchIcon, key: 'tools' },
  { icon: SearchIcon, key: 'web' },
  { icon: FolderIcon, key: 'files' },
  { icon: TerminalIcon, key: 'env' },
] as const;

const ModeSelector = memo(() => {
  const { t } = useTranslation('chat');
  const agentId = useAgentId();
  const toggleAgentMode = useToggleAgentMode();
  const [open, setOpen] = useState(false);

  const enableAgentMode = useAgentStore(agentByIdSelectors.getAgentEnableModeById(agentId));

  const currentMode = enableAgentMode ? 'agent' : 'chat';
  const CurrentIcon = enableAgentMode ? InfinityIcon : MessageCircleIcon;

  const handleSelect = useCallback(
    async (mode: 'chat' | 'agent') => {
      setOpen(false);
      await toggleAgentMode(mode === 'agent');
    },
    [toggleAgentMode],
  );

  const agentTooltip = (
    <div className={styles.agentTooltip}>
      <div className={styles.agentTooltipTitle}>{t('chatMode.agent')}</div>
      {AGENT_CAPS.map(({ key, icon }) => (
        <div className={styles.agentTooltipCap} key={key}>
          <Icon icon={icon} size={12} />
          {t(`chatMode.agentCap.${key}`)}
        </div>
      ))}
    </div>
  );

  const chatTooltip = t('chatMode.chatDesc');

  const popoverContent = (
    <Flexbox gap={4} style={{ maxWidth: 320, minWidth: 280 }}>
      <button
        aria-pressed={currentMode === 'agent'}
        className={cx(styles.option, currentMode === 'agent' && styles.activeOption)}
        type="button"
        onClick={() => handleSelect('agent')}
      >
        <Flexbox
          align="center"
          className={styles.optionIcon}
          height={32}
          justify="center"
          width={32}
        >
          <Icon icon={InfinityIcon} size={16} />
        </Flexbox>
        <Flexbox flex={1}>
          <div className={styles.optionTitle}>{t('chatMode.agent')}</div>
          <div className={styles.optionDesc}>{t('chatMode.agentDesc')}</div>
        </Flexbox>
        <Icon className={styles.optionCheck} icon={CheckIcon} size={16} />
      </button>

      <button
        aria-pressed={currentMode === 'chat'}
        className={cx(styles.option, currentMode === 'chat' && styles.activeOption)}
        type="button"
        onClick={() => handleSelect('chat')}
      >
        <Flexbox
          align="center"
          className={styles.optionIcon}
          height={32}
          justify="center"
          width={32}
        >
          <Icon icon={MessageCircleIcon} size={16} />
        </Flexbox>
        <Flexbox flex={1}>
          <div className={styles.optionTitle}>{t('chatMode.chat')}</div>
          <div className={styles.optionDesc}>{t('chatMode.chatDesc')}</div>
        </Flexbox>
        <Icon className={styles.optionCheck} icon={CheckIcon} size={16} />
      </button>
    </Flexbox>
  );

  const button = (
    <div className={styles.button}>
      <Icon icon={CurrentIcon} size={14} />
      <span>{t(`chatMode.${currentMode}`)}</span>
      <Icon icon={ChevronDownIcon} size={12} />
    </div>
  );

  return (
    <Popover
      arrow={false}
      className={styles.popover}
      classNames={{ content: styles.popoverContent }}
      content={popoverContent}
      open={open}
      placement="topLeft"
      trigger="click"
      onOpenChange={setOpen}
    >
      <div>
        {open ? (
          button
        ) : (
          <Tooltip title={enableAgentMode ? agentTooltip : chatTooltip}>{button}</Tooltip>
        )}
      </div>
    </Popover>
  );
});

ModeSelector.displayName = 'ModeSelector';

export default ModeSelector;
