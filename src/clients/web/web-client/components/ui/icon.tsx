import * as React from "react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

// Icon convention for crouter-web. Icons are real `lucide-react` glyphs, never
// Unicode/emoji characters sized by font-size (those inherit the tiny type
// scale and read as noise). Two sizes only — this enforces the legibility floor:
//   default = 16px (size-4) — inline / nav / control icons
//   "lg"    = 20px (size-5) — prominent / standalone affordances
// Usage:  import { Search } from "lucide-react"; <Icon icon={Search} />
//         <Icon icon={Search} size="lg" />   or pass className for color.
function Icon({
  icon: LucideGlyph,
  size = "default",
  className,
  ...props
}: {
  icon: LucideIcon
  size?: "default" | "lg"
} & React.ComponentProps<LucideIcon>) {
  return (
    <LucideGlyph
      aria-hidden
      className={cn(size === "lg" ? "size-5" : "size-4", className)}
      {...props}
    />
  )
}

export { Icon }
