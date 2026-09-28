/**
 * Shared Mutant Apps SDK design tokens.
 *
 * The overview card and the compact follow-up card are separate documents under
 * separate resource URIs, so they cannot share a stylesheet. They can share these
 * literals: every other color either card paints comes from the host CSS
 * variables applied by the host-styles hook, with a light-mode fallback.
 */
import type { CSSProperties } from "react";

export interface Palette {
  accent: string;
  accentText: string;
  errorBackground: string;
  errorBorder: string;
  errorText: string;
  dropActive: string;
}

export const LIGHT_PALETTE: Palette = {
  accent: "#1f7a3f",
  accentText: "#ffffff",
  errorBackground: "#fdecea",
  errorBorder: "#f5c6cb",
  errorText: "#7f1d1d",
  dropActive: "#f0fff4",
};

export const DARK_PALETTE: Palette = {
  accent: "#4ea86e",
  accentText: "#0b1a10",
  errorBackground: "#3a1d1d",
  errorBorder: "#5c2b2b",
  errorText: "#ffb4ab",
  dropActive: "#16301f",
};

export function paletteVars(palette: Palette): CSSProperties {
  return {
    "--mutant-accent": palette.accent,
    "--mutant-accent-text": palette.accentText,
    "--mutant-error-bg": palette.errorBackground,
    "--mutant-error-border": palette.errorBorder,
    "--mutant-error-text": palette.errorText,
    "--mutant-drop-active": palette.dropActive,
  } as CSSProperties;
}
