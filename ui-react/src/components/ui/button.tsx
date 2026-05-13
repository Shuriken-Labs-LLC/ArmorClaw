import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ac-teal disabled:pointer-events-none disabled:opacity-50 min-h-[44px]',
  {
    variants: {
      variant: {
        default:
          'bg-ac-teal text-ac-bg hover:bg-ac-teal/90 rounded-btn hover-glow',
        destructive:
          'bg-ac-red text-ac-text hover:bg-ac-red/90 rounded-btn',
        outline:
          'border border-ac-border bg-transparent text-ac-text hover:bg-ac-surface2 rounded-btn',
        secondary:
          'bg-ac-surface2 text-ac-text hover:bg-ac-border rounded-btn',
        ghost:
          'text-ac-text hover:bg-ac-surface2 rounded-btn',
        link:
          'text-ac-teal underline-offset-4 hover:underline min-h-0',
        amber:
          'bg-ac-amber text-ac-bg hover:bg-ac-amber/90 rounded-btn',
      },
      size: {
        default: 'h-11 px-4 py-2',
        sm: 'h-9 px-3 text-xs min-h-[36px]',
        lg: 'h-12 px-8',
        icon: 'h-11 w-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
