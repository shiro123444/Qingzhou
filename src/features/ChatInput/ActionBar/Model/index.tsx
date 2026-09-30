import { ModelIcon } from '@lobehub/icons';
import { Center } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback } from 'react';

import ModelSwitchPanel from '@/features/ModelSwitchPanel';
import { useJumiChatModel } from '@/hooks/useJumiChatModel';
import { useAgentStore } from '@/store/agent';

import { useAgentId } from '../../hooks/useAgentId';
import { useActionBarContext } from '../context';

const styles = createStaticStyles(({ css, cssVar }) => ({
  icon: css`
    transition: scale 400ms cubic-bezier(0.215, 0.61, 0.355, 1);
  `,
  model: css`
    cursor: pointer;
    border-radius: 24px;

    :hover {
      background: ${cssVar.colorFillSecondary};
    }

    :active {
      div {
        scale: 0.8;
      }
    }
  `,
}));

const ModelSwitch = memo(() => {
  const { actionSize, dropdownPlacement } = useActionBarContext();
  const blockSize = actionSize?.blockSize ?? 32;
  const iconSize = actionSize?.size ?? 20;

  const agentId = useAgentId();
  const { model, provider, selectionAgentId } = useJumiChatModel(agentId);
  const updateAgentConfigById = useAgentStore((s) => s.updateAgentConfigById);

  const handleModelChange = useCallback(
    async (params: { model: string; provider: string }) => {
      if (selectionAgentId) await updateAgentConfigById(selectionAgentId, params);
    },
    [selectionAgentId, updateAgentConfigById],
  );

  return (
    <ModelSwitchPanel
      model={model}
      open={selectionAgentId ? undefined : false}
      placement={dropdownPlacement}
      provider={provider}
      onModelChange={handleModelChange}
    >
      <Center className={styles.model} height={blockSize} width={blockSize}>
        <div className={styles.icon}>
          <ModelIcon model={model} size={iconSize} />
        </div>
      </Center>
    </ModelSwitchPanel>
  );
});

ModelSwitch.displayName = 'ModelSwitch';

export default ModelSwitch;
