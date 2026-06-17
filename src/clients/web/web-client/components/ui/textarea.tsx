import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // shadcn-standard sizing (text-sm, px-3 py-2, rounded-md); QI look via color/shadow tokens only
        "flex field-sizing-content min-h-16 w-full rounded-md border border-[var(--line)] bg-[oklch(0_0_0/0.3)] px-3 py-2 text-sm text-[var(--ink)] shadow-[inset_0_2px_6px_oklch(0_0_0/0.3)] transition-[color,box-shadow] outline-none placeholder:text-[var(--dim)] focus-visible:border-[var(--line2)] focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
