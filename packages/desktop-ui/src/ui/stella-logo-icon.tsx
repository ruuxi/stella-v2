import { StellaMark, type StellaMarkProps } from "@/ui/stella-mark";

type StellaLogoIconProps = StellaMarkProps;

/**
 * Historic name for the brand mark, kept so existing call sites don't churn.
 * Prefer importing {@link StellaMark} directly in new code.
 */
export function StellaLogoIcon({
  size = 16,
  style,
  ...props
}: StellaLogoIconProps) {
  return (
    <StellaMark
      size={size}
      style={{
        display: "inline-block",
        flex: "0 0 auto",
        verticalAlign: "middle",
        ...style,
      }}
      {...props}
    />
  );
}
