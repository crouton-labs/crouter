import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // shadcn-standard sizing (h-9, text-sm, px-3); QI look via color/shadow tokens only
        "h-9 w-full min-w-0 rounded-md border border-[var(--line)] bg-[oklch(0_0_0/0.25)] px-3 py-1 text-sm text-[var(--ink)] shadow-[inset_0_1px_3px_oklch(0_0_0/0.3)] transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-[var(--dim)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-[var(--line2)] focus-visible:ring-[3px] focus-visible:ring-ring/40",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
