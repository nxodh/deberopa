/**
 * Deberopa is monochrome by design: the mark is a black "V" on a white disc. Hierarchy comes
 * from weight (bold), dimness and inverse video, never from hue. A theme only decides which
 * shade of grey "text" and "muted" are.
 */
export interface Theme {
  name: string
  description: string
  /** Foreground for normal text; undefined keeps the terminal's own foreground. */
  text?: string
  /** Colour for secondary text; undefined uses the terminal's dim attribute. */
  muted?: string
  /** Border colour for boxes. */
  border?: string
}

export const THEMES: Record<string, Theme> = {
  mono: {
    name: "mono",
    description: "Follows your terminal's colours (works on dark and light backgrounds)",
  },
  ink: {
    name: "ink",
    description: "Off-white on dark, like the logo's disc",
    text: "#EDEDED",
    muted: "#8C8C8C",
    border: "#5A5A5A",
  },
  paper: {
    name: "paper",
    description: "Near-black on light, like the logo's mark",
    text: "#141414",
    muted: "#6E6E6E",
    border: "#9A9A9A",
  },
}

export function getTheme(name: string | undefined): Theme {
  return THEMES[name ?? "mono"] ?? THEMES.mono!
}
