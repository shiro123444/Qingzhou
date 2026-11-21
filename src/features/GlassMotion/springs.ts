/** Design Bookmark motion tokens. Mass is 1, matching shared/motion.js. */
export const springs = {
  soft: { stiffness: 260, damping: 24, mass: 1 },
  lead: { stiffness: 620, damping: 36, mass: 1 },
  trail: { stiffness: 190, damping: 19, mass: 1 },
  pop: { stiffness: 520, damping: 16, mass: 1 },
  fade: { stiffness: 420, damping: 32, mass: 1 },
  lensFollow: { stiffness: 180, damping: 17, mass: 1 },
  lensZoom: { stiffness: 260, damping: 26, mass: 1 },
  word: { stiffness: 340, damping: 26, mass: 1 },
  sidebarLabel: { stiffness: 300, damping: 26, mass: 1 },
  sidebarToggle: { stiffness: 300, damping: 22, mass: 1 },
  cordSwing: { stiffness: 46, damping: 3, mass: 1 },
  cordTug: { stiffness: 300, damping: 13, mass: 1 },
  cordRelease: { stiffness: 300, damping: 17, mass: 1 },
  dock: { stiffness: 380, damping: 32, mass: 1 },
} as const;

/** Kokonut UI Toolbar (MIT): retain its plate and reflow timing. */
export const toolbarTransitions = {
  plate: { type: 'spring', bounce: 0, duration: 0.25 },
  reflow: { type: 'spring', bounce: 0, duration: 0.4 },
} as const;
