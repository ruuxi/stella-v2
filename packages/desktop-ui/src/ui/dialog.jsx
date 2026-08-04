import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/shared/lib/utils";
import { X } from "@/ui/icons";
const DialogRoot = DialogPrimitive.Root;
const DialogPortal = DialogPrimitive.Portal;
const DialogOverlay = React.forwardRef(({ className, ...props }, ref) => (<DialogPrimitive.Overlay ref={ref} data-component="dialog-overlay" className={cn(className)} {...props}/>));
DialogOverlay.displayName = "DialogOverlay";
const DialogContent = React.forwardRef(({ className, size = "md", fit, children, ...props }, ref) => (<DialogPortal>
    <DialogOverlay />
    <div data-component="dialog" data-size={size} data-fit={fit || undefined}>
      <div data-slot="dialog-container">
        <DialogPrimitive.Content ref={ref} data-slot="dialog-content" className={cn(className)} {...props}>
          {children}
        </DialogPrimitive.Content>
      </div>
    </div>
  </DialogPortal>));
DialogContent.displayName = "DialogContent";
const DialogHeader = React.forwardRef(({ className, ...props }, ref) => (<div ref={ref} data-slot="dialog-header" className={cn(className)} {...props}/>));
DialogHeader.displayName = "DialogHeader";
const DialogTitle = React.forwardRef(({ className, ...props }, ref) => (<DialogPrimitive.Title ref={ref} data-slot="dialog-title" className={cn(className)} {...props}/>));
DialogTitle.displayName = "DialogTitle";
const DialogDescription = React.forwardRef(({ className, ...props }, ref) => (<DialogPrimitive.Description ref={ref} data-slot="dialog-description" className={cn(className)} {...props}/>));
DialogDescription.displayName = "DialogDescription";
const DialogBody = React.forwardRef(({ className, ...props }, ref) => (<div ref={ref} data-slot="dialog-body" className={cn(className)} {...props}/>));
DialogBody.displayName = "DialogBody";
const DialogCloseButton = React.forwardRef(({ className, ...props }, ref) => (<DialogPrimitive.Close ref={ref} data-slot="dialog-close-button" className={cn(className)} {...props}>
    <X size={16}/>
  </DialogPrimitive.Close>));
DialogCloseButton.displayName = "DialogCloseButton";
export const Dialog = Object.assign(DialogRoot, {
    Content: DialogContent,
    Header: DialogHeader,
    Title: DialogTitle,
    Description: DialogDescription,
    Body: DialogBody,
    CloseButton: DialogCloseButton,
});
export { DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogCloseButton, };
