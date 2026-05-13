import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-badge px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none',
  {
    variants: {
      variant: {
        default: 'bg-ac-teal/20 text-ac-teal',
        success: 'bg-ac-teal/20 text-ac-teal',
        rejected: 'bg-ac-red/20 text-ac-red',
        error: 'bg-ac-red/20 text-ac-red',
        undone: 'bg-ac-amber/20 text-ac-amber',
        warning: 'bg-ac-amber/20 text-ac-amber',
        pending: 'bg-ac-blue/20 text-ac-blue',
        muted: 'bg-ac-surface2 text-ac-muted',
        purple: 'bg-ac-purple/20 text-ac-purple',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
