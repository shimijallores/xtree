import type { Transition, Variants } from "motion/react";

// Motion tokens (mirrored as CSS vars in styles.css :root).
// Follows .kiro/skills/ui-animation: transform/opacity only, exits faster than entrances.
export const EASE_ENTER = [0.22, 1, 0.36, 1] as const;
export const EASE_MOVE = [0.25, 1, 0.5, 1] as const;
export const EASE_PRESS = [0.25, 0.46, 0.45, 0.94] as const;

export const DUR = { enter: 0.22, exit: 0.15, move: 0.24, cutout: 0.28 } as const;

export const enterT: Transition = { duration: DUR.enter, ease: EASE_ENTER };
export const exitT: Transition = { duration: DUR.exit, ease: EASE_ENTER };
export const moveT: Transition = { duration: DUR.move, ease: EASE_MOVE };

/** Horizontal slide for edge-docked sidebars. dir -1 = from the left, 1 = from the right. */
export const slideX = (dir: -1 | 1, distance = 12): Variants => ({
  initial: { opacity: 0, x: dir * distance },
  animate: { opacity: 1, x: 0, transition: moveT },
  exit: { opacity: 0, x: dir * distance, transition: exitT },
});

/** Small rise for bottom-anchored cards. */
export const riseIn: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: enterT },
  exit: { opacity: 0, y: 8, transition: exitT },
};

/** Scale from the trigger. Pass a CSS transform-origin string for the anchor. */
export const fadeScale = (origin = "center", from = 0.96): Variants => ({
  initial: { opacity: 0, scale: from, transformOrigin: origin },
  animate: { opacity: 1, scale: 1, transformOrigin: origin, transition: enterT },
  exit: { opacity: 0, scale: from, transformOrigin: origin, transition: exitT },
});

/** View swap crossfade; a small blur hides the rough overlap. */
export const crossfade: Variants = {
  initial: { opacity: 0, filter: "blur(2px)" },
  animate: { opacity: 1, filter: "blur(0px)", transition: { duration: 0.2, ease: EASE_ENTER } },
  exit: { opacity: 0, filter: "blur(2px)", transition: exitT },
};
