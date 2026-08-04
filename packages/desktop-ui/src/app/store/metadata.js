import { CustomStore } from "@/ui/nav-icons";
import { STORE_BROWSE_ENABLED } from "@/features/store/store-feature";
const metadata = {
    id: "store",
    label: "Store",
    icon: CustomStore,
    route: "/store",
    slot: "top",
    order: 30,
    hideFromSidebar: !STORE_BROWSE_ENABLED,
};
export default metadata;
