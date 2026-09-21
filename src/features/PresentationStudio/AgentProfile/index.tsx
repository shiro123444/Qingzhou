import { Flexbox, Icon, Tag } from '@lobehub/ui';
import {
  ChevronRight,
  FileCheck,
  FileText,
  Image as ImageIcon,
  Layout,
  Sparkles,
} from 'lucide-react';
import { memo } from 'react';

import { JUMI_AVATAR, JUMI_NAME } from '@/const/jumi';

import { styles } from './style';

export interface PresentationAgentProfileProps {
  onSelectPrompt?: (prompt: string) => void;
}

const CAPABILITIES = [
  { desc: '自动提炼多级逻辑框架与页面内容', icon: FileText, title: '大纲智能规划' },
  { desc: '高保真矢量图表与现代排版设计', icon: Layout, title: '矢量版式排版' },
  { desc: '智能关联主题插图与素材插槽', icon: ImageIcon, title: '素材智能装配' },
  { desc: '支持 PPTX、PDF、SVG 格式极速导出', icon: FileCheck, title: '多格式无损导出' },
];

const INSPIRATION_PROMPTS = [
  '2026年企业数字化转型战略规划',
  '智能新零售产品发布商业提案',
  'Q3 团队技术演进与业务增长复盘',
  '人工智能前沿学术研讨会报告',
];

export const PresentationAgentProfile = memo<PresentationAgentProfileProps>(
  ({ onSelectPrompt }) => {
    return (
      <aside
        aria-label="Presentation Agent Profile"
        className={styles.card}
        data-testid="presentation-agent-profile"
      >
        <div className={styles.header}>
          <div className={styles.avatar}>
            <img alt={JUMI_NAME} src={JUMI_AVATAR} />
          </div>
          <div className={styles.meta}>
            <Flexbox horizontal align="center" gap={6}>
              <span className={styles.title}>{JUMI_NAME}</span>
              <Tag color="purple">Agent</Tag>
            </Flexbox>
            <span style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>
              清舟演示文稿智能体
            </span>
          </div>
        </div>

        <div className={styles.description}>
          基于大模型深度理解与矢量渲染引擎，为你自动规划幻灯片大纲、设计专业视觉版式并生成可编辑的
          PPT 文档。
        </div>

        <Flexbox gap={10}>
          <span className={styles.sectionTitle}>核心能力</span>
          <div className={styles.capabilityList}>
            {CAPABILITIES.map((cap) => (
              <div className={styles.capabilityItem} key={cap.title}>
                <Icon icon={cap.icon} size={15} style={{ color: 'var(--ant-color-primary)' }} />
                <div>
                  <span style={{ fontWeight: 600 }}>{cap.title}</span>
                  <span
                    style={{
                      color: 'var(--ant-color-text-secondary)',
                      fontSize: 12,
                      marginLeft: 6,
                    }}
                  >
                    ({cap.desc})
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Flexbox>

        <Flexbox gap={10}>
          <Flexbox horizontal align="center" gap={4}>
            <Icon icon={Sparkles} size={13} style={{ color: 'var(--ant-gold-active)' }} />
            <span className={styles.sectionTitle}>创作灵感推荐</span>
          </Flexbox>
          <div className={styles.promptList} data-testid="agent-profile-prompt-list">
            {INSPIRATION_PROMPTS.map((prompt) => (
              <div
                className={styles.promptCard}
                key={prompt}
                onClick={() => onSelectPrompt?.(prompt)}
              >
                <span>💡 {prompt}</span>
                <Icon icon={ChevronRight} size={12} />
              </div>
            ))}
          </div>
        </Flexbox>
      </aside>
    );
  },
);

PresentationAgentProfile.displayName = 'PresentationAgentProfile';

export default PresentationAgentProfile;
