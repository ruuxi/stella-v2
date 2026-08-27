import * as DialogPrimitive from "@radix-ui/react-dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { cn } from "@/shared/lib/utils";
import { X } from "@/ui/icons";
import { useT } from "@/shared/i18n";

interface ImageLightboxProps {

  open: boolean;
  onOpenChange: (open: boolean) => void;

  src: string;

  alt?: string;
  className?: string;
}

export function ImageLightbox({
  open,
  onOpenChange,
  src,
  alt,
  className,
}: ImageLightboxProps) {
  const t = useT();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-component="image-lightbox-overlay" />
        <div data-component="image-lightbox">
          <DialogPrimitive.Content
            data-slot="image-lightbox-content"
            className={cn(className)}
            aria-describedby={undefined}
          >
            <VisuallyHidden asChild>
              <DialogPrimitive.Title>
                {alt || t("ui.imageLightbox.title")}
              </DialogPrimitive.Title>
            </VisuallyHidden>
            <img
              data-slot="image-lightbox-image"
              src={src}
              alt={alt ?? ""}
            />
            <DialogPrimitive.Close
              data-slot="image-lightbox-close"
              aria-label={t("ui.imageLightbox.close")}
            >
              <X size={18} />
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
