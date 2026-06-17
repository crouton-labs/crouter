import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// Maps onto the Quiet Instrument `.badge` atom in index.css. Base = `.badge`
// (bordered uppercase pill); status modifier classes (.active/.idle/.done/
// .blocked/.dead) supply the hue. Variant `destructive` => `.badge.blocked`.
const badgeVariants = cva(
  "badge w-fit max-w-full overflow-hidden text-[var(--ink2)] whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "",
        secondary: "dead",
        destructive: "blocked",
        outline: "",
        ghost: "border-transparent",
        link: "border-transparent underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
