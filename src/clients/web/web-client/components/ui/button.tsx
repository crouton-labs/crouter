import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// Maps onto the Quiet Instrument `.btn` atom in index.css so `<Button>` and
// `className="btn ..."` render identically. Base = `.btn`; variants add the
// atom modifier classes (.primary/.danger/.sm) plus a11y focus + svg sizing.
const buttonVariants = cva(
  "btn justify-center transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "primary",
        destructive: "danger",
        // .btn base already IS the outline look (line2 border, transparent)
        outline: "",
        secondary: "",
        ghost: "border-transparent",
        link: "border-transparent bg-transparent text-primary underline-offset-4 hover:underline hover:bg-transparent",
      },
      size: {
        default: "",
        xs: "sm gap-1 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "sm",
        lg: "px-6 py-2.5",
        icon: "p-0 size-9",
        "icon-xs": "p-0 size-6 rounded-[7px] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "p-0 size-8 rounded-[7px]",
        "icon-lg": "p-0 size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
