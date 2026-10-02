import { STELLA_PROMPT_DEFAULTS } from "../../packages/backend/convex/stella_prompt_defaults.generated.ts";
process.stdout.write(JSON.stringify({ revision: STELLA_PROMPT_DEFAULTS.revision, prompts: STELLA_PROMPT_DEFAULTS.prompts.map(({ id, content }) => ({ id, content })) }));
