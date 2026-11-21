// PPT Master Style workspaces define the visual grammar. Qingzhou supplies the
// actual ink/paper colors and type families shared by generation and the gallery.
export const presentationStylePresets = [
  {
    id: 'narrative-keynote',
    visualStyle: 'editorial',
    coverLayout: 'editorial_bleed/09_full_statement.svg',
    textLayout: 'presentation_core/05_comparison.svg',
    fontFamily: 'Songti SC, Noto Serif CJK SC, Georgia, serif',
    colors: {
      background: '#F4F0E6',
      text: '#302A28',
      muted: '#665B53',
      primary: '#843C34',
      accent: '#AD5746',
    },
  },
  {
    id: 'academic-research',
    visualStyle: 'swiss-minimal',
    coverLayout: 'presentation_core/01_title_slide.svg',
    textLayout: 'presentation_core/04_two_content.svg',
    fontFamily: 'Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif',
    colors: {
      background: '#F3F4EE',
      text: '#192C25',
      muted: '#50645B',
      primary: '#17604E',
      accent: '#B5D256',
    },
  },
  {
    id: 'technical-deepdive',
    visualStyle: 'blueprint',
    coverLayout: 'report_core/01_cover.svg',
    textLayout: 'presentation_core/04_two_content.svg',
    fontFamily: 'Hiragino Sans GB, Microsoft YaHei, Arial, sans-serif',
    colors: {
      background: '#152B46',
      text: '#F1F5FA',
      muted: '#ACC3D9',
      primary: '#619FC8',
      accent: '#F5C776',
    },
  },
] as const;

export type PresentationStyleId = (typeof presentationStylePresets)[number]['id'];

export const getPresentationStylePreset = (value: unknown) =>
  presentationStylePresets.find(({ id }) => id === value);
