import { CustomLayout } from "@/ui/nav-icons";
// The full-window bar omits this entry (`ShellTopBarFull`): there the Apps
// sidebar section is the way in, and a nav entry would compete with it for the
// same job. It stays registered so the library route remains deep-linkable.
const metadata = {
    id: "apps",
    label: "Apps",
    icon: CustomLayout,
    route: "/apps",
    slot: "top",
    order: 20,
};
export default metadata;
