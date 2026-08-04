import { AlertCircle, CheckCircle2, Circle, CircleDot } from "@/ui/icons";
/** One icon vocabulary for inline cards and Activity rows. */
export function AgentLifecycleStatusIcon({ status, ...props }) {
    switch (status) {
        case "running":
            return <CircleDot {...props}/>;
        case "completed":
            return <CheckCircle2 {...props}/>;
        case "error":
            return <AlertCircle {...props}/>;
        case "canceled":
            return <Circle {...props}/>;
    }
}
