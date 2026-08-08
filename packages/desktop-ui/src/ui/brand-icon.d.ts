import type { ComponentType, SVGProps } from "react";

export type BrandIconProps = SVGProps<SVGSVGElement> & {
  brand: string;
  size?: number | string;
};

export declare const BrandIcon: ComponentType<BrandIconProps>;
