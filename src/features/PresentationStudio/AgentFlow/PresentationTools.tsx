import { Button, Icon } from '@lobehub/ui';
import { Checkbox, Popover, Spin } from 'antd';
import { createStaticStyles } from 'antd-style';
import { Globe2 } from 'lucide-react';
import { useEffect, useState } from 'react';

export interface PresentationToolSelection {
  search: boolean;
  skillIds: string[];
}
const styles = createStaticStyles(({ css, cssVar }) => ({
  menu: css`
    display: flex;
    flex-direction: column;
    gap: 14px;

    width: 240px;
    padding: 12px;
  `,
  label: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  error: css`
    font-size: 12px;
    color: ${cssVar.colorError};
  `,
}));
export function PresentationTools({
  value,
  onChange,
}: {
  value: PresentationToolSelection;
  onChange: (value: PresentationToolSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void fetch('/api/runtime/presentation/conversation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'catalog' }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || '工具列表加载失败');
        return result;
      })
      .then((result) => setSkills(result.skills))
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open]);
  return (
    <Popover
      open={open}
      placement="topLeft"
      trigger="click"
      content={
        <div aria-label="PPT 工具" className={styles.menu}>
          <Checkbox
            checked={value.search}
            onChange={(event) => onChange({ ...value, search: event.target.checked })}
          >
            联网搜索
          </Checkbox>
          <span className={styles.label}>技能</span>
          {loading ? (
            <Spin size="small" />
          ) : (
            skills.map((skill) => (
              <Checkbox
                checked={value.skillIds.includes(skill.id)}
                key={skill.id}
                onChange={(event) =>
                  onChange({
                    ...value,
                    skillIds: event.target.checked
                      ? [...value.skillIds, skill.id]
                      : value.skillIds.filter((id) => id !== skill.id),
                  })
                }
              >
                {skill.name}
              </Checkbox>
            ))
          )}
          {error && (
            <span className={styles.error} role="alert">
              {error}
            </span>
          )}
        </div>
      }
      onOpenChange={setOpen}
    >
      <Button
        aria-label={`联网搜索与技能（联网搜索${value.search ? '已开启' : '已关闭'}）`}
        icon={<Icon icon={Globe2} size={18} />}
        size="small"
        type="text"
      >
        联网
      </Button>
    </Popover>
  );
}
