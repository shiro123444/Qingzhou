/** Isolated preview of the actual brand components and glass runtime. */
import { createRoot } from 'react-dom/client';

import { mountThreeGlass } from '@/features/LiquidGlass/three/runtime';
import {
  QingzhouComposerOrnaments,
  QingzhouEmptyBoat,
  QingzhouHomeFrame,
  qingzhouStyles,
} from '@/features/QingzhouBrand';
import { glassSurface, liquidGlass } from '@/styles/liquidGlass';

const css = document.createElement('style');
css.textContent = `
  * { box-sizing:border-box; }
  html,body { margin:0; min-height:100%; font:14px/1.6 system-ui; }
  body { --ant-color-text:#edf2f0; --ant-color-text-secondary:#a9b7b4; --ant-color-text-tertiary:#80918b; --ant-color-bg-container:#202725; --ant-color-bg-elevated:#2e3834; --ant-color-bg-layout:#151d1b; color:var(--ant-color-text); background:#151d1b; }
  body[data-theme=light] { --ant-color-text:#243e38; --ant-color-text-secondary:#61776e; --ant-color-text-tertiary:#7e9187; --ant-color-bg-container:#f5f8f5; --ant-color-bg-elevated:#f7faf7; --ant-color-bg-layout:#eaf0eb; background:#eaf0eb; }
  [data-qz-glass-scene] { position:relative; min-height:100vh; overflow:hidden; padding:72px max(24px,calc((100vw - 960px)/2)); background:radial-gradient(at 85% 12%,#629a8c13,transparent 60%),var(--ant-color-bg-layout); }
  h1 { margin:0; font-size:24px; font-weight:500; }
  p { color:var(--ant-color-text-secondary); margin:8px 0 0; }
  .intro { margin:12px 0 42px; max-width:400px; }
  .composer { position:relative; z-index:1; margin:0 0 64px; }
  .plate { padding:20px; min-height:152px; border:1px solid #91aaa52e; border-radius:24px; }
  textarea { display:block; width:100%; height:64px; resize:none; border:0; outline:0; background:transparent; color:inherit; font:inherit; }
  .tools { display:flex; justify-content:space-between; align-items:center; color:var(--ant-color-text-secondary); font-size:12px; }
  .mode { border-radius:999px; padding:4px 12px; background:#9fbab512; }
  .empty { margin-top:24px; padding:32px; text-align:center; border-radius:24px; background:#9fbab508; display:flex; flex-direction:column; align-items:center; }
  .empty h2 { margin:0; font-size:18px; font-weight:500; }
  @media(max-width:600px) { [data-qz-glass-scene] { padding:36px 24px; } h1 { font-size:20px; } .intro { margin-bottom:36px; } .empty { padding:24px; } }
`;
document.head.append(css);
const mount = document.createElement('div');
document.body.append(mount);
const root = createRoot(mount);
root.render(
  <main data-qz-glass-scene className={liquidGlass}>
    <QingzhouHomeFrame>
      <header className="intro">
        <h1>带着新问题，慢慢开始。</h1>
        <p>一处安静的创作空间。</p>
      </header>
      <div className={`composer ${qingzhouStyles.composer}`}>
        <QingzhouComposerOrnaments />
        <div className={`plate ${glassSurface}`} data-qz-glass="composer">
          <textarea aria-label="创作内容" placeholder="提问、创作，或开始一项任务。" />
          <div className="tools">
            <span className="mode">∞ 智能</span>
            <span>↗</span>
          </div>
        </div>
      </div>
    </QingzhouHomeFrame>
    <section className="empty">
      <QingzhouEmptyBoat />
      <h2>从一个小想法出发</h2>
      <p>让下一段旅程，从这里开始。</p>
    </section>
  </main>,
);
const stop = mountThreeGlass();
window.brandPreview = {
  cleanup: () => {
    stop();
    root.unmount();
  },
};
declare global {
  interface Window {
    brandPreview: { cleanup: () => void };
  }
}
