import { CustomStore } from "@/ui/nav-icons";
import type { AppMetadata } from "../_shared/app-metadata";
import { STORE_BROWSE_ENABLED } from "@/features/store/store-feature";

const metadata: AppMetadata = {
  id: "store",
  label: "Store",
  icon: CustomStore,
  route: "/store",
  slot: "top",
  order: 30,
  hideFromSidebar: !STORE_BROWSE_ENABLED,
};

export default metadata;
